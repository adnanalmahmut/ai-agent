import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import type { Request, Response } from 'express';
import { z } from 'zod';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../../core/auth';
import { AppException } from '../../core/errors';
import { createZodDto, RawResponse } from '../../core/http';
import { UserRateLimit } from '../../core/rate-limit';
import { McpSessionService } from './mcp-session.service';
import { openMcpSessionInput } from './mcp-session.types';

class OpenMcpSessionDto extends createZodDto(openMcpSessionInput) {}

/** The same bound the content-idea route puts on a caller-supplied key. */
const idempotencyKeySchema = z.string().trim().min(8).max(200);

/**
 * MCP over HTTP, as one more adapter in front of the same tool authority.
 *
 * Three operations: open a session, exchange protocol messages, close it.
 * There is deliberately no route that executes a tool, lists tools, or sends
 * anything — the protocol endpoint is the only way in, and what it can reach
 * is decided before the SDK sees a request.
 *
 * The shared organization guard runs before body validation and authorizes the
 * organization in the path. `mcpSession:create` is `admin` and `owner`; for
 * every route that *uses* a session the service additionally requires the
 * caller to be the member who opened it, which is the part a role cannot
 * express. Closing is the deliberate exception — see `McpSessionService.close`
 * — because a session holds organization-wide capacity and only removes it.
 */
@ApiTags('MCP sessions')
@Controller('organizations/:organizationId/mcp-sessions')
@UseGuards(OrganizationPermissionGuard)
export class McpSessionController {
  constructor(private readonly sessions: McpSessionService) {}

  /**
   * Metered because a session is a run: it takes an in-flight slot from the
   * organization's ceiling and can spend on every subsequent call.
   */
  @Post()
  @RequiresOrganizationPermission({ mcpSession: ['create'] })
  @UserRateLimit({ points: 30, durationSec: 300 })
  @ApiOperation({
    operationId: 'openMcpSession',
    summary: 'Open an MCP session over an installed agent’s granted tools',
  })
  @ApiParam({ name: 'organizationId' })
  open(
    @Param('organizationId') organizationId: string,
    @Body() body: OpenMcpSessionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Session() session: UserSession,
  ) {
    const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);

    if (!parsedKey.success) {
      throw new AppException('VALIDATION_ERROR', {
        context: { resource: 'mcpSession', reason: 'idempotency_key' },
        publicDetails: { reason: 'idempotency_key_required' },
      });
    }

    return this.sessions.open({
      organizationId,
      actorUserId: session.user.id,
      idempotencyKey: parsedKey.data,
      payload: body,
    });
  }

  /**
   * The MCP endpoint. POST only, which is what the protocol requires.
   *
   * The response is written through `@Res` under `@RawResponse` rather than
   * returned, because the SDK produces a complete protocol response — status,
   * headers and body — and re-wrapping it in this application's envelope would
   * corrupt it. `@RawResponse` is the interceptor's own documented opt-out for
   * protocol endpoints; injecting `@Res` without `passthrough` would discard
   * the envelope anyway, but only as a side effect, and the decorator is what
   * says so on purpose and spares the wrapper being built per request. The
   * envelope still governs every *refusal* made before the SDK is reached,
   * which is where authorization lives.
   *
   * Metered per user. A protocol exchange is cheap, but a tool call inside one
   * is not, and the durable per-session ceiling bounds the total rather than
   * the rate.
   */
  @Post(':runId/mcp')
  @RawResponse()
  @RequiresOrganizationPermission({ mcpSession: ['create'] })
  @UserRateLimit({ points: 240, durationSec: 300 })
  @ApiOperation({
    operationId: 'exchangeMcpMessage',
    summary: 'Exchange one MCP protocol message within an open session',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'runId' })
  async exchange(
    @Param('organizationId') organizationId: string,
    @Param('runId') runId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res() response: Response,
    @Session() session: UserSession,
  ): Promise<void> {
    const exchange = await this.sessions.exchange({
      organizationId,
      runId,
      actorUserId: session.user.id,
      origin: request.headers.origin ?? null,
      /**
       * An absolute URL over a constant base, because `Request` requires one.
       *
       * The request's own `Host` was used here and should not have been. It is
       * attacker-controlled and never validated — Nest has already routed the
       * request, and the origin check is the browser-facing defence — so a
       * value like `[bad` made `new Request()` throw `TypeError`, turning a
       * malformed header into a 500 with a logged stack. Nothing read it
       * either: the SDK classifies on the body and the path, so the authority
       * component was only ever a parsing requirement.
       */
      url: `http://mcp.invalid${request.originalUrl}`,
      headers: request.headers,
      body,
    });

    response.status(exchange.status);
    for (const [name, value] of Object.entries(exchange.headers)) {
      response.setHeader(name, value);
    }
    response.send(exchange.body);
  }

  /**
   * `405` for the two verbs the protocol asks a modern-only endpoint to refuse.
   *
   * The specification says a server supporting only this revision SHOULD answer
   * `405` to a GET or DELETE on the MCP endpoint, and the reason is
   * interoperability rather than tidiness: a client probing for the deprecated
   * 2024-11-05 HTTP+SSE transport reads the answer to decide which era it is
   * talking to, and a `404` carrying this application's error envelope is not a
   * recognizable protocol error — so it pushes a conforming client down the
   * legacy fallback instead of telling it the truth. Without these routes Nest
   * never reaches this controller for those verbs and answers exactly that
   * `404`.
   *
   * Written raw, like the exchange itself, because a JSON-RPC error is what the
   * specification permits in this body and what a client can parse.
   *
   * No permission decorator and no session lookup: the answer is a fact about
   * the endpoint's shape, identical for every caller, and resolving a session
   * to refuse a verb the endpoint never supports would leak whether one exists.
   * The guard on the controller still requires an authenticated member of the
   * organization.
   */
  @Get(':runId/mcp')
  @RawResponse()
  @RequiresOrganizationPermission({ mcpSession: ['create'] })
  @ApiOperation({
    operationId: 'rejectMcpGet',
    summary: 'Refuse GET on the MCP endpoint',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'runId' })
  rejectGet(@Res() response: Response): void {
    response.status(405);
    response.setHeader('Allow', 'POST');
    response.setHeader('Content-Type', 'application/json');
    response.send(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Method Not Allowed' },
        id: null,
      }),
    );
  }

  @Delete(':runId/mcp')
  @RawResponse()
  @RequiresOrganizationPermission({ mcpSession: ['create'] })
  @ApiOperation({
    operationId: 'rejectMcpDelete',
    summary: 'Refuse DELETE on the MCP endpoint',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'runId' })
  rejectDelete(@Res() response: Response): void {
    response.status(405);
    response.setHeader('Allow', 'POST');
    response.setHeader('Content-Type', 'application/json');
    response.send(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Method Not Allowed' },
        id: null,
      }),
    );
  }

  @Delete(':runId')
  @RequiresOrganizationPermission({ mcpSession: ['create'] })
  @UserRateLimit({ points: 60, durationSec: 300 })
  @ApiOperation({
    operationId: 'closeMcpSession',
    summary: 'Close an open MCP session',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'runId' })
  close(
    @Param('organizationId') organizationId: string,
    @Param('runId') runId: string,
    @Session() session: UserSession,
  ) {
    return this.sessions.close({
      organizationId,
      runId,
      actorUserId: session.user.id,
    });
  }
}
