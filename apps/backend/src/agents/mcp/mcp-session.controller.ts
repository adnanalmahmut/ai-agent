import {
  Body,
  Controller,
  Delete,
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
import { createZodDto } from '../../core/http';
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
 * organization in the path. `mcpSession:create` is `admin` and `owner`; the
 * service additionally requires the caller to be the member who opened the
 * session, which is the part a role cannot express.
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
   * The response is written through `@Res` rather than returned, because the
   * SDK produces a complete protocol response — status, headers and body —
   * and re-wrapping it in this application's envelope would corrupt it. The
   * envelope still governs every *refusal* made before the SDK is reached,
   * which is where authorization lives.
   *
   * Metered per user. A protocol exchange is cheap, but a tool call inside one
   * is not, and the durable per-session ceiling bounds the total rather than
   * the rate.
   */
  @Post(':runId/mcp')
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
       * An absolute URL, because `Request` requires one and the SDK reads the
       * path to classify the exchange. Built from what the request actually
       * arrived as; the host is not trusted for anything — host-header
       * validation is not used here, since Nest has already routed the request
       * and the origin check is the browser-facing defence.
       */
      url: `${request.protocol}://${request.headers.host ?? 'localhost'}${request.originalUrl}`,
      headers: request.headers,
      body,
    });

    response.status(exchange.status);
    for (const [name, value] of Object.entries(exchange.headers)) {
      response.setHeader(name, value);
    }
    response.send(exchange.body);
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
