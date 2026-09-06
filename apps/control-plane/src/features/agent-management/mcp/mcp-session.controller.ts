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
} from '../../../infrastructure/auth';
import { AppException } from '../../../core/errors';
import { createZodDto, RawResponse } from '../../../infrastructure/http';
import { UserRateLimit } from '../../../infrastructure/rate-limit';
import { McpSessionService } from './mcp-session.service';
import { openMcpSessionInput } from './mcp-session.types';

class OpenMcpSessionDto extends createZodDto(openMcpSessionInput) {}

const idempotencyKeySchema = z.string().trim().min(8).max(200);

@ApiTags('MCP sessions')
@Controller('organizations/:organizationId/mcp-sessions')
@UseGuards(OrganizationPermissionGuard)
export class McpSessionController {
  constructor(private readonly sessions: McpSessionService) {}

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
