import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  createMcpHandler,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
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
import { createGovernedMcpServer } from './mcp-tool-server';
import {
  MCP_FORWARDED_HEADERS,
  MCP_HEADER_PREFIX,
  MCP_SESSION_TOOL_CALL_BUDGET,
  type McpExchange,
  type McpSessionAccepted,
  type McpSessionClosed,
  type OpenMcpSessionInput,
} from './mcp-session.types';

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
    private readonly executions: ToolExecutionService,
    private readonly runtimeConfig: RuntimeConfigResolver,
    @Inject(authConfig.KEY) auth: ConfigType<typeof authConfig>,
  ) {
    /**
     * Hostnames, because that is what the SDK's validator compares.
     *
     * `BETTER_AUTH_TRUSTED_ORIGINS` holds URLs, and origin validation here is
     * port-agnostic by the SDK's convention. Reusing that list rather than
     * adding a setting keeps one answer to "which browser origins belong to
     * this deployment"; an entry that is not a parseable URL is dropped rather
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
    const session = await this.requireSession(input);

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
     * `responseMode: 'json'` because nothing here streams: a tool call is one
     * request and one result. `onerror` is given a sink that reads nothing, so
     * a transport fault cannot carry request material into the logs.
     */
    const handler = createMcpHandler(
      () => createGovernedMcpServer({ tools, version: MCP_ADAPTER_VERSION }),
      { responseMode: 'json', onerror: () => undefined },
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

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: await response.text(),
      };
    } finally {
      // Per-request instance, so it is closed with the exchange rather than
      // left to a listener that has nothing to listen to.
      await handler.close();
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
   * must not gain authority by knowing an id.
   */
  private async requireSession(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
  }) {
    const session = await this.runs.findMcpSession({
      id: input.runId,
      organizationId: input.organizationId,
    });

    if (!session || session.createdByUserId !== input.actorUserId) {
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
   * process restarts, and across two API instances serving one session. Under
   * concurrency it can be exceeded by at most the number of calls in flight
   * together, because counting and calling are not one atomic step. That is
   * stated rather than hidden: the ceiling is a cost bound, and the same
   * property is true of the gateway's in-memory budget within a request.
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
 * that has no use for one. What the 2026-07-28 revision requires — the
 * `mcp-`-prefixed protocol, method and name headers — is forwarded verbatim,
 * because the SDK's classifier reads them to decide how to serve the request.
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
