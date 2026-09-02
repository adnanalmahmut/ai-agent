import {
  createMcpHandler,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { authConfig } from '../../config';
import { RuntimeConfigResolver } from '../../control-plane';
import { AppException } from '../../core/errors';
import { AgentConfigurationError } from '../agent-configuration.error';
import { AgentDefinitionRegistry } from '../agent-definition.registry';
import { AgentRunService } from '../agent-run.service';
import {
  AGENT_RUN_DRIVERS,
  isMcpSessionExpired,
  MCP_SESSION_TTL_MS,
  type AgentRuntimeTool,
  type AgentValue,
} from '../agent.types';
import { ToolExecutionService } from '../tools/tool-execution.service';
import { ToolExecutionFailure, ToolGateway } from '../tools/tool.gateway';
import {
  MCP_EXCHANGE_DEADLINE_MS,
  MCP_FORWARDED_HEADERS,
  MCP_HEADER_PREFIX,
  MCP_REFUSED_METHODS,
  MCP_SESSION_TOOL_CALL_BUDGET,
  type McpExchange,
  type McpSessionAccepted,
  type McpSessionClosed,
  type OpenMcpSessionInput,
} from './mcp-session.types';
import { createGovernedMcpServer } from './mcp-tool-server';

/**
 * A session has exactly one attempt.
 *
 * Nothing retries an MCP session: there is no job, no delivery, and no
 * transport that could hand it to a second worker. Recording 1 is therefore
 * the truth rather than a placeholder, and it keeps every `ToolExecution` a
 * session writes attributable to the one attempt that made it.
 */
const MCP_SESSION_ATTEMPT = 1;

/**
 * The version this server reports over the protocol.
 *
 * Deliberately the adapter's own contract version and not the application's
 * release: a client caches tool lists and schemas against it, and those change
 * when a `ToolDefinition` changes, not when the platform ships.
 */
const MCP_ADAPTER_VERSION = '1.0.0';

/**
 * MCP sessions: acceptance, authority, and one protocol exchange.
 *
 * The whole design is in what this service does *not* own. It holds no tool
 * implementations, writes no `ToolExecution` row, makes no approval decision,
 * and performs no external effect. It resolves who is asking and what their
 * run may call, hands `ToolGateway` the question, and hands the protocol SDK
 * the answer. Everything a tool call then does — durable recording, the
 * approval requirement for a side effect, containment of failures — happens
 * in the same code a Mastra run goes through, because it *is* that code.
 *
 * So the load-bearing claim is structural rather than defensive: an MCP client
 * cannot send a notification, because the closure it is given writes a
 * proposal and returns. There is no second path to bypass.
 */
@Injectable()
export class McpSessionService {
  private readonly allowedOriginHostnames: string[];

  constructor(
    private readonly runs: AgentRunService,
    private readonly definitions: AgentDefinitionRegistry,
    private readonly gateway: ToolGateway,
    @Inject(ToolExecutionService)
    private readonly executions: Pick<ToolExecutionService, 'countForRun'>,
    private readonly runtimeConfig: RuntimeConfigResolver,
    @Inject(authConfig.KEY) auth: ConfigType<typeof authConfig>,
  ) {
    /**
     * Hostnames, because that is what the SDK's validator compares.
     *
     * `BETTER_AUTH_TRUSTED_ORIGINS` holds URLs, and the SDK's validator compares
     * hostnames only. That is its documented convention, and it is worth naming
     * precisely because it is a widening rather than a restatement: comparing
     * hostnames discards both the scheme and the port, so a trusted entry of
     * `https://app.example.test` also admits `http://app.example.test:31337`.
     * The exposure is bounded — an attacker able to serve a page on any port of
     * a hostname the deployment already trusts is inside the trust boundary
     * this list draws — and reusing the list keeps one answer to "which browser
     * origins belong to this deployment" instead of adding a second setting to
     * disagree with it. An entry that is not a parseable URL is dropped rather
     * than allowed, because a malformed allowlist entry must not widen an
     * allowlist.
     */
    this.allowedOriginHostnames = auth.trustedOrigins.flatMap((origin) => {
      try {
        return [new URL(origin).hostname];
      } catch {
        return [];
      }
    });
  }

  /**
   * Opens a session for an installed agent.
   *
   * Reuses the ordinary run-acceptance path, which is where the
   * per-organization advisory lock, the exact in-flight ceiling, durable
   * idempotency, and definition/organization-version pinning already live. The
   * only difference this caller makes is the driver.
   */
  async open(input: {
    organizationId: string;
    actorUserId: string;
    idempotencyKey: string;
    payload: OpenMcpSessionInput;
  }): Promise<McpSessionAccepted> {
    // Coarse switch first, so the refusal names the broader cause when both
    // are off — the same order every other acceptance boundary uses.
    await this.runtimeConfig.assertFeature('agents.enabled', {
      organizationId: input.organizationId,
    });
    await this.runtimeConfig.assertFeature('mcp.enabled', {
      organizationId: input.organizationId,
    });

    /**
     * The organization's own ceiling, honored because a session is in-flight
     * agent activity that spends the platform's provider credential on every
     * call. The consequence is deliberate and documented: a session holds a
     * slot until it is closed or expires.
     */
    const maxInFlight = await this.runtimeConfig.setting(
      'agents.max_concurrent_runs_per_organization',
    );

    const run = await this.runs.create({
      maxInFlight,
      driver: AGENT_RUN_DRIVERS.mcpClient,
      agentId: input.payload.agentId,
      organizationId: input.organizationId,
      createdByUserId: input.actorUserId,
      input: { session: 'mcp' },
      idempotencyKey: sessionKey(input.idempotencyKey, input.payload),
    });

    return {
      runId: run.id,
      agentId: run.agentId,
      expiresAt: new Date(
        run.createdAt.getTime() + MCP_SESSION_TTL_MS,
      ).toISOString(),
    };
  }

  /**
   * Closes a session on request.
   *
   * Idempotent by design rather than by catching: a client that closes twice,
   * or closes one the reconciler already expired, gets a successful answer
   * describing what is true. Only the tenant, the creator and the runtime are
   * enforced — a close is not an action that needs a fresh feature check,
   * because ending a session cannot spend anything.
   */
  async close(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
  }): Promise<McpSessionClosed> {
    /**
     * Closing is the one session operation the creator does not own alone.
     *
     * A session holds one of the organization's in-flight run slots for up to
     * its whole lifetime, so a member who opens sessions and then disconnects
     * can exhaust the organization's agent capacity — and if only they could
     * release it, nobody could recover before the absolute TTL ran out. That
     * would make an ordinary disconnection an hour-long outage for every agent
     * in the organization, with no operator route to end it.
     *
     * Widening this grants nothing: ending a session can only remove
     * capability, never add it, and it is `mcpSession:create` — `admin` and
     * `owner` — that is being trusted, not membership. Every other session
     * route keeps the creator check, because those *do* confer authority.
     */
    const session = await this.requireSession({ ...input, anyMember: true });

    if (session.status !== 'RUNNING') {
      return { runId: session.id, closedBy: 'already_closed' };
    }

    const expired = isMcpSessionExpired(session.createdAt, new Date());
    const closedBy = expired ? 'expiry' : 'client';

    const closed = await this.runs.closeMcpSession({
      id: session.id,
      organizationId: input.organizationId,
      closedBy,
    });

    return {
      runId: session.id,
      closedBy: closed ? closedBy : 'already_closed',
    };
  }

  /**
   * One protocol exchange, with every authority decision made first.
   *
   * Nothing is cached between requests, and that is the point rather than a
   * cost: the definition revision, the pinned organization version and the
   * grant set are re-read every time, so a grant an operator changes takes
   * effect on the next call — while never altering *this* run, because what is
   * read is the immutable version the run pinned at acceptance rather than the
   * installation's current one.
   */
  async exchange(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
    origin: string | null;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<McpExchange> {
    /**
     * Origin first, before anything is read.
     *
     * The specification requires a streamable-HTTP server to validate it, and
     * the SDK deliberately does not: `createMcpHandler` performs no header
     * validation and expects its host to. Absence passes, because a non-browser
     * MCP client sends no `Origin`; a present value that is unparseable or
     * unknown is refused, which is what protects a cookie-authenticated
     * endpoint from being driven by a page the organization does not own.
     */
    const origin = validateOriginHeader(
      input.origin,
      this.allowedOriginHostnames,
    );

    if (!origin.ok) {
      throw new AppException('FORBIDDEN', {
        context: { resource: 'mcpSession', reason: origin.errorCode },
        publicDetails: { reason: 'origin_not_allowed' },
      });
    }

    /**
     * Both switches, on every call rather than only at acceptance.
     *
     * A session outlives the request that opened it, so gating only
     * acceptance would let every open session keep spending after an operator
     * had switched the feature off.
     */
    await this.runtimeConfig.assertFeature('agents.enabled', {
      organizationId: input.organizationId,
    });
    await this.runtimeConfig.assertFeature('mcp.enabled', {
      organizationId: input.organizationId,
    });

    const session = await this.requireSession(input);

    if (session.status !== 'RUNNING') {
      throw new AppException('CONFLICT', {
        context: { resource: 'mcpSession' },
        publicDetails: { reason: 'session_closed' },
      });
    }

    /**
     * An expired session is closed here, not merely refused.
     *
     * Refusing without closing would leave a row saying `RUNNING` that every
     * future request also refuses — a durable state the application knows to
     * be over. The reconciler does the same for a session nobody returns to;
     * this is the same decision reached by the other route.
     */
    if (isMcpSessionExpired(session.createdAt, new Date())) {
      await this.runs.closeMcpSession({
        id: session.id,
        organizationId: input.organizationId,
        closedBy: 'expiry',
      });

      throw new AppException('CONFLICT', {
        context: { resource: 'mcpSession' },
        publicDetails: { reason: 'session_expired' },
      });
    }

    /**
     * A streaming method is refused before the SDK is reached.
     *
     * Not defence in depth: the protocol entry serves `subscriptions/listen`
     * itself, as an `text/event-stream` body that ends only when its consumer
     * cancels or the handler closes. Reading such a body to completion — which
     * is what answering one HTTP request with one protocol response requires —
     * never returns. Refusing before delegating is the only place the answer
     * can be given cheaply and in-band.
     */
    const refused = refusedMethod(input.body);

    if (refused !== undefined) {
      throw new AppException('BAD_REQUEST', {
        context: { resource: 'mcpSession', reason: refused },
        publicDetails: { reason: 'method_not_supported' },
      });
    }

    const tools = await this.authorize(session);

    /**
     * A handler per exchange, whose factory closes over exactly these tools.
     *
     * The SDK calls the factory once per request and derives `tools/list` from
     * that instance's registrations, so a per-request instance is how a
     * per-principal tool set is expressed — not a workaround for one. The
     * factory cannot consult anything: the authorized closures are already
     * decided above, and it has no access to the gateway.
     *
     * `legacy: 'reject'` makes this a single-revision endpoint, and it is the
     * option that turns the ceiling below into a bound. The legacy leg accepts
     * a JSON-RPC array and dispatches every element without awaiting any of
     * them, so one HTTP request — one rate-limit point, one authorization, one
     * durable count — would fan out into as many concurrent tool calls as the
     * gateway's per-attempt budget allowed, each having read the same count of
     * zero. Rejecting it refuses a batch outright with `-32600`. It also makes
     * the endpoint honest in a second way: the legacy leg answers
     * request-bearing POSTs as `text/event-stream` regardless of
     * `responseMode`, so without this the claim below would describe half the
     * endpoint.
     *
     * The cost is interoperability, and it is real: the v2 client negotiates
     * the legacy era by default, so a client must ask for 2026-07-28
     * explicitly. That is an acceptable price here because this endpoint is
     * already reachable only by a caller holding an application session, which
     * is not a client anybody adopts by accident.
     *
     * `responseMode: 'json'` then describes every response: a tool call is one
     * request and one result, and nothing streams. `onerror` is given a sink
     * that reads nothing, so a transport fault cannot carry request material
     * into the logs.
     *
     * Constructed under a suppressed `console.warn` because this SDK writes an
     * unconditional advisory to the console when `responseMode` is `'json'`,
     * and a per-request handler would write it once per request. It is a static
     * sentence carrying no request material, so this is log discipline rather
     * than containment: the application logs through Pino, and one library line
     * per MCP call on stdout is noise an operator did not ask for. The
     * advisory's subject — dropped mid-call notifications — cannot arise here,
     * because the only method that emits them is refused above.
     */
    const handler = withoutConsoleWarnings(() =>
      createMcpHandler(
        () => createGovernedMcpServer({ tools, version: MCP_ADAPTER_VERSION }),
        {
          responseMode: 'json',
          legacy: 'reject',
          onerror: () => undefined,
          /**
           * No subscription may open, stated to the library as well.
           *
           * The refusal above is the honest answer and this is the guarantee
           * behind it: the router compares the open count against this ceiling
           * before it opens a stream, so at zero it answers a complete in-band
           * JSON-RPC error instead. Two mechanisms because they fail
           * differently — the refusal reads a method name out of a body whose
           * shape a future revision may change, while this bounds the router
           * whatever reaches it.
           */
          maxSubscriptions: 0,
        },
      ),
    );

    try {
      const response = await handler.fetch(
        new Request(input.url, {
          method: 'POST',
          headers: forwardedHeaders(input.headers),
          body: JSON.stringify(input.body ?? null),
        }),
        /**
         * The body the framework already parsed.
         *
         * `main.ts` boots with Nest's own body parser disabled and the auth
         * module installs JSON parsing for the whole application, so the
         * stream is consumed before a controller runs. Handing the parsed
         * value over is the SDK's supported answer to exactly that.
         */
        { parsedBody: input.body },
      );

      /**
       * The body is read under a deadline, and the deadline closes the handler.
       *
       * An `AbortSignal` on the request does not release a stream the entry is
       * already serving; closing the handler does, because that is what ends
       * its open streams and lets the pending read settle. So the timer's job
       * is to call `close()` — the read then finishes on its own and the
       * `finally` below closes an already-closed handler harmlessly.
       *
       * This exists so that a streaming response nobody anticipated degrades
       * to a slow refusal rather than to a socket, a timer and a server
       * instance held for the life of the process.
       */
      const body = await this.readWithinDeadline(response, handler);

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    } finally {
      // Per-request instance, so it is closed with the exchange rather than
      // left to a listener that has nothing to listen to. This closes the
      // modern leg; the legacy fallback is per-request by construction and
      // tears itself down with its own response.
      await handler.close();
    }
  }

  /**
   * One response body, or a refusal that does not outlive the deadline.
   *
   * The timer is always cleared, including when the read rejects, so a normal
   * exchange leaves nothing pending on the event loop.
   */
  private async readWithinDeadline(
    response: Response,
    handler: { close: () => Promise<void> },
  ): Promise<string> {
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      void handler.close().catch(() => undefined);
    }, MCP_EXCHANGE_DEADLINE_MS);

    try {
      const body = await response.text();

      if (expired) {
        throw new AppException('SERVICE_UNAVAILABLE', {
          context: { resource: 'mcpSession', reason: 'exchange_deadline' },
          publicDetails: { reason: 'exchange_timeout' },
        });
      }

      return body;
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * The session this caller is allowed to act on, or a refusal.
   *
   * A miss and another organization's session are deliberately the same
   * answer, and so is a session belonging to a different member: an id is not
   * a capability, and `NOT_FOUND` tells a caller nothing about what exists
   * elsewhere.
   *
   * The creator check is the one the organization permission cannot make.
   * `mcpSession:create` answers "may this person open sessions here"; it does
   * not make every admin the owner of every session, and a reconnecting client
   * must not gain authority by knowing an id. It is therefore applied to every
   * route that *uses* a session, and deliberately not to the one that ends
   * one — see `close`.
   */
  private async requireSession(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
    /**
     * Set only by `close`, where the caller's permission is the whole
     * authority and ownership would only stand between an organization and
     * its own capacity.
     */
    anyMember?: boolean;
  }) {
    const session = await this.runs.findMcpSession({
      id: input.runId,
      organizationId: input.organizationId,
    });

    const owned =
      input.anyMember === true ||
      session?.createdByUserId === input.actorUserId;

    if (!session || !owned) {
      throw new AppException('NOT_FOUND', {
        context: { resource: 'mcpSession' },
        publicDetails: { reason: 'session_not_found' },
      });
    }

    return session;
  }

  /**
   * Exactly what this session's run may call, with a durable ceiling.
   *
   * The gateway answers the authority question; this adds the one bound the
   * gateway cannot, because its own budget lives inside a single `authorize`
   * call and an MCP session authorizes once per request.
   */
  private async authorize(session: {
    id: string;
    agentId: string;
    agentVersion: number;
    organizationAgentVersionId: string | null;
    organizationId: string;
  }): Promise<readonly AgentRuntimeTool[]> {
    let tools: readonly AgentRuntimeTool[];

    try {
      const definition = this.definitions.resolve(
        session.agentId,
        session.agentVersion,
      );

      /**
       * An operator's disable switch has to reach an open session.
       *
       * `enabled` is checked at acceptance, which is sufficient for a Mastra
       * run because the run is over in seconds. A session lives up to an hour
       * and is driven by a client the whole time, so acceptance-only would mean
       * an agent an operator had explicitly turned off kept answering calls and
       * proposing actions for the rest of that hour, with nothing short of the
       * organization-wide `mcp.enabled` to stop it.
       *
       * This reads the installation's *current* state and refuses; the grants
       * below still come from the version the run pinned. The two are not in
       * tension — what an operator may change is whether this agent runs at
       * all, not what an accepted run is allowed to call.
       */
      const unavailable = await this.runs.installationAvailability({
        organizationId: session.organizationId,
        agentId: session.agentId,
      });

      if (unavailable !== null) {
        /**
         * The same public reason an unresolvable definition gives.
         *
         * Whether the agent was uninstalled or merely switched off is this
         * organization's business; an external client learns that the session
         * cannot be served and no more. The distinction is kept in `context`,
         * which stays server-side.
         */
        throw new AppException('CONFLICT', {
          context: { resource: 'mcpSession', reason: unavailable },
          publicDetails: { reason: 'session_agent_unavailable' },
        });
      }

      const pinned = await this.runs.pinnedVersionFor(session);

      tools = this.gateway.authorize({
        definition,
        organizationId: session.organizationId,
        agentRunId: session.id,
        agentRunAttempt: MCP_SESSION_ATTEMPT,
        // A legacy run with no pinned version has no configuration and,
        // necessarily, no tools. A session cannot be one — acceptance always
        // pins — but the type admits it, so it resolves to nothing rather than
        // to everything.
        grants: pinned?.toolGrants ?? [],
      });
    } catch (error) {
      /**
       * A build or a durable-drift fault, not a caller's fault.
       *
       * `AgentConfigurationError` means the code-owned definition and the
       * stored version disagree — a deployed revision withdrawn while a
       * session was open, or a grant that no longer fits its maximum. The
       * session cannot be served, and saying which of those it was would
       * describe this organization's rows to an external client.
       */
      if (error instanceof AgentConfigurationError) {
        throw new AppException('CONFLICT', {
          context: { resource: 'mcpSession' },
          publicDetails: { reason: 'session_agent_unavailable' },
        });
      }
      throw error;
    }

    return tools.map((tool) => this.budgeted(tool, session));
  }

  /**
   * One authorized tool, with the session's remaining call budget in front.
   *
   * Wrapped rather than passed through, and wrapped *outside* the gateway on
   * purpose: the ceiling is a property of this adapter's request boundary, not
   * of the tool or of the run, and pushing a session concept into the gateway
   * would make the authority owner know about its callers.
   *
   * The count is read per call, so the bound holds across requests, across
   * process restarts, and across two API instances serving one session.
   *
   * It is a cost ceiling, not a fence, and the difference is worth stating
   * exactly. Counting and calling are not one atomic step, so concurrent calls
   * can each read the same count and the total can overshoot by the number in
   * flight together. What bounds "in flight together" is that a modern
   * exchange carries exactly one tool call — which is why `legacy: 'reject'`
   * above is load-bearing rather than tidy, since a batch would have made one
   * request into many — leaving the per-user rate limit on the exchange route
   * as the real ceiling on concurrency. Making this exact would mean fencing it
   * atomically, in the transaction that writes the `ToolExecution` row or in
   * Redis; that is a deliberate non-goal, because the purpose is to stop a
   * session quietly spending all month, not to meter it to the call.
   */
  private budgeted(
    tool: AgentRuntimeTool,
    session: { id: string; organizationId: string },
  ): AgentRuntimeTool {
    return {
      ...tool,
      execute: async (input: AgentValue) => {
        const used = await this.executions.countForRun(
          session.id,
          session.organizationId,
        );

        if (used >= MCP_SESSION_TOOL_CALL_BUDGET) {
          // The same containment every other tool failure has: the model
          // learns the call did not happen, and learns nothing else.
          throw new ToolExecutionFailure(
            `Tool "${tool.name}" exceeded this session's tool-call budget`,
          );
        }

        return tool.execute(input);
      },
    };
  }
}

/**
 * Whole-request identity for a session, bound to what was asked for.
 *
 * The same shape the content-idea route uses, and for the same reason: run
 * acceptance answers a repeated key with the stored run without comparing the
 * rest of the payload, so a client reusing one key for a different agent would
 * otherwise receive a session for the wrong one.
 */
function sessionKey(callerKey: string, payload: OpenMcpSessionInput): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ agentId: payload.agentId }))
    .digest('hex');

  return `mcp-session:${callerKey}:${digest}`;
}

/**
 * The protocol's own headers, and nothing that authenticates anybody.
 *
 * An allowlist because the request carries this application's session cookie:
 * forwarding headers wholesale would hand a credential to a third-party SDK
 * that has no use for one. Every `mcp-`-prefixed header is forwarded verbatim,
 * which covers what the 2026-07-28 revision requires — `MCP-Protocol-Version`
 * on every POST, `Mcp-Method` on every request, `Mcp-Name` on the three that
 * name a subject — as well as the `Mcp-Param-*` headers a server is asked to
 * cross-check. Withholding them would turn a valid request into a
 * header-mismatch refusal; they do not decide how it is served, because the
 * SDK's era classifier reads the body's `_meta` rather than a header.
 */
export function forwardedHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const forwarded: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const allowed =
      key.startsWith(MCP_HEADER_PREFIX) ||
      (MCP_FORWARDED_HEADERS as readonly string[]).includes(key);

    if (!allowed || value === undefined) continue;

    forwarded[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  return forwarded;
}

/**
 * The refused protocol method this body carries, if it carries one.
 *
 * Reads only a method name, and reads it defensively: the body is whatever the
 * framework parsed, so it is `unknown` until proven otherwise. An array is
 * inspected element by element because a batch — which this revision does not
 * define, but which a client library may still send — must not smuggle a
 * refused method past a check that only looked at the envelope.
 */
export function refusedMethod(body: unknown): string | undefined {
  const messages = Array.isArray(body) ? body : [body];

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;

    const method = (message as { method?: unknown }).method;

    if (
      typeof method === 'string' &&
      (MCP_REFUSED_METHODS as readonly string[]).includes(method)
    ) {
      return method;
    }
  }

  return undefined;
}

/**
 * Runs a synchronous call with `console.warn` silenced, and always restores it.
 *
 * Narrow on purpose. The call it wraps is synchronous, so nothing else can run
 * between the swap and the restore — this cannot silence a warning belonging to
 * another request, which is the only thing that would make patching a global
 * unacceptable here. It exists because the protocol SDK writes a fixed advisory
 * to the console at handler construction and offers no way to opt out; the
 * application logs through Pino, and a library line per MCP request is noise an
 * operator did not choose.
 */
export function withoutConsoleWarnings<T>(run: () => T): T {
  const warn = console.warn;
  console.warn = () => undefined;

  try {
    return run();
  } finally {
    console.warn = warn;
  }
}
