import { createMcpHandler } from '@modelcontextprotocol/server';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { authConfig } from '../../../infrastructure/config';
import { RuntimeConfigResolver } from '../../control-plane';
import { AppException } from '../../../core/errors';
import { AgentConfigurationError } from '../../../ai/agents/agent-configuration.error';
import { AgentDefinitionRegistry } from '../../../ai/agents/agent-definition.registry';
import { AgentRunService } from '../../../ai/execution/agent-run.service';
import {
  AGENT_RUN_DRIVERS,
  isMcpSessionExpired,
  MCP_SESSION_TTL_MS,
  type AgentRuntimeTool,
  type AgentValue,
} from '../../../ai/agents/agent.types';
import { ToolExecutionService } from '../../../ai/tools/tool-execution.service';
import {
  ToolExecutionFailure,
  ToolGateway,
} from '../../../ai/tools/tool.gateway';
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

const MCP_SESSION_ATTEMPT = 1;

const MCP_ADAPTER_VERSION = '1.0.0';

@Injectable()
export class McpSessionService {
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    private readonly runs: AgentRunService,
    private readonly definitions: AgentDefinitionRegistry,
    private readonly gateway: ToolGateway,
    @Inject(ToolExecutionService)
    private readonly executions: Pick<ToolExecutionService, 'countForRun'>,
    private readonly runtimeConfig: RuntimeConfigResolver,
    @Inject(authConfig.KEY) auth: ConfigType<typeof authConfig>,
  ) {
    this.allowedOrigins = new Set(
      auth.trustedOrigins.flatMap((origin) => {
        try {
          const parsed = new URL(origin);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return [parsed.origin];
          }
          return [];
        } catch {
          return [];
        }
      }),
    );
  }

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

  async close(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
  }): Promise<McpSessionClosed> {
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

  async exchange(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
    origin: string | null;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }): Promise<McpExchange> {
    const origin = validateExactOriginHeader(input.origin, this.allowedOrigins);

    if (!origin.ok) {
      throw new AppException('FORBIDDEN', {
        context: { resource: 'mcpSession', reason: origin.errorCode },
        publicDetails: { reason: 'origin_not_allowed' },
      });
    }

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

    const refused = refusedMethod(input.body);

    if (refused !== undefined) {
      throw new AppException('BAD_REQUEST', {
        context: { resource: 'mcpSession', reason: refused },
        publicDetails: { reason: 'method_not_supported' },
      });
    }

    const tools = await this.authorize(session);

    const handler = withoutConsoleWarnings(() =>
      createMcpHandler(
        () => createGovernedMcpServer({ tools, version: MCP_ADAPTER_VERSION }),
        {
          responseMode: 'json',
          legacy: 'reject',
          onerror: () => undefined,
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
        { parsedBody: input.body },
      );

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

  private async requireSession(input: {
    organizationId: string;
    runId: string;
    actorUserId: string;
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

      const unavailable = await this.runs.installationAvailability({
        organizationId: session.organizationId,
        agentId: session.agentId,
      });

      if (unavailable !== null) {
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

function sessionKey(callerKey: string, payload: OpenMcpSessionInput): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ agentId: payload.agentId }))
    .digest('hex');

  return `mcp-session:${callerKey}:${digest}`;
}

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

export function withoutConsoleWarnings<T>(run: () => T): T {
  const warn = console.warn;
  console.warn = () => undefined;

  try {
    return run();
  } finally {
    console.warn = warn;
  }
}

export function validateExactOriginHeader(
  originHeader: string | null | undefined,
  allowedOrigins: ReadonlySet<string>,
):
  | { ok: true }
  | { ok: false; errorCode: 'invalid_origin_header' | 'origin_not_allowed' } {
  if (
    originHeader === null ||
    originHeader === undefined ||
    originHeader === ''
  ) {
    return { ok: true };
  }

  let requestOrigin: string;
  try {
    const parsed = new URL(originHeader);
    if (
      parsed.origin === 'null' ||
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    ) {
      return { ok: false, errorCode: 'invalid_origin_header' };
    }
    requestOrigin = parsed.origin;
  } catch {
    return { ok: false, errorCode: 'invalid_origin_header' };
  }

  if (!allowedOrigins.has(requestOrigin)) {
    return { ok: false, errorCode: 'origin_not_allowed' };
  }

  return { ok: true };
}
