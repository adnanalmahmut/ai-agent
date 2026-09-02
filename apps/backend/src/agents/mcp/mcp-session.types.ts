import { z } from 'zod';

/**
 * How many tool calls one session may make in total.
 *
 * The gateway's `MAX_TOOL_INVOCATIONS_PER_ATTEMPT` does not reach here, and
 * the reason is worth stating precisely because it is the kind of gap an
 * adapter opens silently. That budget is captured inside one `authorize()`
 * call and lives in memory for the life of the returned closures. A Mastra run
 * authorizes once and calls its tools inside that one attempt, so the budget
 * bounds the run. An MCP session authorizes once *per HTTP request*, because
 * the effective grant set must be re-derived per request — so every request
 * would receive a fresh budget, and a session could make an unbounded number
 * of paid calls while never exceeding it.
 *
 * This ceiling is therefore counted durably, from the session's own
 * `ToolExecution` rows, which is the only counter that survives the request
 * boundary the adapter introduces.
 *
 * Forty-eight: four times the per-attempt budget, because a session is a
 * person working through a client across many turns rather than one
 * generation, and still a number an operator would not notice on a bill.
 */
export const MCP_SESSION_TOOL_CALL_BUDGET = 48;

/**
 * Request headers this adapter is willing to hand the protocol SDK.
 *
 * An allowlist, and a security boundary rather than tidiness. The MCP endpoint
 * is authenticated by the application's own session cookie, so the incoming
 * request carries a credential; forwarding headers wholesale would put that
 * cookie — and an `Authorization` header, if one is ever added — inside a
 * third-party SDK, its transports, and anything it logs. Nothing in the
 * protocol needs either.
 *
 * What the protocol does need is here: content negotiation, and every
 * `mcp-`-prefixed header. The 2026-07-28 revision requires
 * `MCP-Protocol-Version` on every POST to the endpoint and `Mcp-Method` on
 * every request, while `Mcp-Name` is required only for `tools/call`,
 * `resources/read` and `prompts/get`; header requirements for notification
 * POSTs are not defined by that revision. The prefix also covers the
 * `Mcp-Param-*` headers the specification asks a server to cross-check, which
 * is why the rule is a prefix rather than a list of three names.
 *
 * These headers are a cross-check, not the era signal. The SDK's classifier is
 * body-primary: the era comes from the reserved protocol-version key inside
 * `params._meta`, and `MCP-Protocol-Version` never upgrades or downgrades a
 * body-derived classification — a disagreement is its own protocol error. So
 * forwarding them matters because withholding them turns a valid request into
 * a header-mismatch refusal, not because they decide how the request is served.
 */
export const MCP_FORWARDED_HEADERS = ['accept', 'content-type'] as const;

/** Every `mcp-*` header is forwarded; the prefix is the protocol's own. */
export const MCP_HEADER_PREFIX = 'mcp-';

/**
 * Protocol methods this adapter refuses before the SDK is reached.
 *
 * `subscriptions/listen` is core 2026-07-28 vocabulary with no client-capability
 * gate, and the protocol entry serves it itself — always as an open
 * `text/event-stream`, regardless of `responseMode`. A listen stream is
 * deliberately unbounded: it writes an acknowledgement, then a keepalive comment
 * every fifteen seconds, and ends only when the consumer cancels or the handler
 * is closed.
 *
 * This adapter answers one HTTP request with one complete protocol response,
 * because that is what a Nest controller writing through `@Res` can express. An
 * endless stream has no place in that shape: the response body would never
 * finish, so the request would never be written and the socket, the keepalive
 * timer and the per-request server instance would be held until the process
 * ended. Refusing is also the honest answer rather than merely the safe one —
 * this server registers no resources or prompts and declares
 * `tools.listChanged: false`, so it has nothing to notify anybody about.
 */
export const MCP_REFUSED_METHODS = ['subscriptions/listen'] as const;

/**
 * How long one protocol exchange may take before it is abandoned.
 *
 * A structural bound rather than a second guess at the refusal above. The
 * refusal names the one streaming method this SDK revision has; this deadline
 * is what keeps an unknown future one — or a defect in the refusal — a bounded
 * failure instead of a leaked socket. Closing the handler is what releases a
 * stream the read is waiting on, so the deadline has something to do.
 *
 * Thirty seconds: a tool call here can involve an embedding and a vector
 * search, and the gateway's own generation budget is larger than that, but no
 * single read-only or proposing tool call should approach it.
 */
export const MCP_EXCHANGE_DEADLINE_MS = 30_000;

export const openMcpSessionInput = z
  .object({
    /**
     * Which installed agent's granted tools the session exposes.
     *
     * The only thing a caller chooses. The organization comes from the path
     * and is authorized by the guard; the definition revision, the model pins
     * and the tool grants all come from the organization's active installation
     * at acceptance, so a caller cannot select a revision or widen a grant by
     * asking for one.
     */
    agentId: z.string().trim().min(1).max(120),
  })
  .strict();

export type OpenMcpSessionInput = z.infer<typeof openMcpSessionInput>;

export type McpSessionAccepted = {
  /** The `AgentRun` id. A session has no identity of its own. */
  runId: string;
  agentId: string;
  /**
   * When the session stops being usable, absolutely.
   *
   * Returned so a client can plan rather than discover it mid-task. There is
   * deliberately no endpoint URL alongside it: this process does not reliably
   * know its own public scheme, host, or proxy prefix, and inventing one would
   * make the response a configuration dependency that could quietly be wrong.
   * The path shape is documented instead.
   */
  expiresAt: string;
};

export type McpSessionClosed = {
  runId: string;
  /**
   * `client` when this call ended it, `expiry` when its lifetime had already
   * run out, `already_closed` when it was terminal before the call. All three
   * are successful outcomes of asking for it to be closed.
   */
  closedBy: 'client' | 'expiry' | 'already_closed';
};

/** A protocol exchange, as the controller must write it back. */
export type McpExchange = {
  status: number;
  headers: Record<string, string>;
  body: string;
};
