import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../../../infrastructure/auth';
import {
  apiSuccessSchema,
  createZodDto,
  wireSchemaOf,
} from '../../../infrastructure/http';
import { UserRateLimit } from '../../../infrastructure/rate-limit';
import {
  agentActionApprovalPageSchema,
  agentActionApprovalSchema,
} from './agent-action-approval.contract';
import { AgentActionApprovalService } from './agent-action-approval.service';
import {
  agentActionApprovalQuery,
  agentActionDecisionInput,
} from './agent-action-approval.types';

class AgentActionDecisionDto extends createZodDto(agentActionDecisionInput) {}

class ListAgentActionApprovalsDto extends createZodDto(
  agentActionApprovalQuery,
) {}

@ApiTags('Agent action approvals')
@Controller('organizations/:organizationId/agent-action-approvals')
@UseGuards(OrganizationPermissionGuard)
export class AgentActionApprovalController {
  constructor(private readonly approvals: AgentActionApprovalService) {}

  @Get()
  @RequiresOrganizationPermission({ agentActionApproval: ['read'] })
  @ApiOperation({
    operationId: 'listAgentActionApprovals',
    summary: 'List proposed agent actions and their decisions, newest first',
  })
  @ApiParam({ name: 'organizationId' })
  // Names, optionality and value semantics come from the same Zod schema that
  // validates the query, so the two cannot describe different things.
  @ApiQuery({
    name: 'status',
    required: false,
    schema: wireSchemaOf(agentActionApprovalQuery.shape.status),
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: wireSchemaOf(agentActionApprovalQuery.shape.cursor),
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: wireSchemaOf(agentActionApprovalQuery.shape.limit),
  })
  @ApiOkResponse({ schema: apiSuccessSchema(agentActionApprovalPageSchema) })
  list(
    @Param('organizationId') organizationId: string,
    @Query() query: ListAgentActionApprovalsDto,
  ) {
    return this.approvals.list({
      organizationId,
      status: query.status,
      cursor: query.cursor,
      limit: query.limit,
    });
  }

  @Get(':toolExecutionId')
  @RequiresOrganizationPermission({ agentActionApproval: ['read'] })
  @ApiOperation({
    operationId: 'getAgentActionApproval',
    summary: 'Read one proposed agent action and its decision',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'toolExecutionId' })
  @ApiOkResponse({ schema: apiSuccessSchema(agentActionApprovalSchema) })
  detail(
    @Param('organizationId') organizationId: string,
    @Param('toolExecutionId') toolExecutionId: string,
  ) {
    return this.approvals.detail({ organizationId, toolExecutionId });
  }

  @Post(':toolExecutionId/approve')
  @RequiresOrganizationPermission({ agentActionApproval: ['decide'] })
  @UserRateLimit({ points: 60, durationSec: 300 })
  @ApiOperation({
    operationId: 'approveAgentAction',
    summary: 'Approve one proposed agent action, once',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'toolExecutionId' })
  // The request body is described by the schema that already validates it.
  @ApiBody({ schema: wireSchemaOf(agentActionDecisionInput) })
  @ApiCreatedResponse({ schema: apiSuccessSchema(agentActionApprovalSchema) })
  approve(
    @Param('organizationId') organizationId: string,
    @Param('toolExecutionId') toolExecutionId: string,
    @Body() body: AgentActionDecisionDto,
    @Session() session: UserSession,
  ) {
    return this.approvals.approve({
      organizationId,
      toolExecutionId,
      actorUserId: session.user.id,
      note: body.note,
    });
  }

  @Post(':toolExecutionId/reject')
  @RequiresOrganizationPermission({ agentActionApproval: ['decide'] })
  @UserRateLimit({ points: 60, durationSec: 300 })
  @ApiOperation({
    operationId: 'rejectAgentAction',
    summary: 'Reject one proposed agent action, once',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'toolExecutionId' })
  // The request body is described by the schema that already validates it.
  @ApiBody({ schema: wireSchemaOf(agentActionDecisionInput) })
  @ApiCreatedResponse({ schema: apiSuccessSchema(agentActionApprovalSchema) })
  reject(
    @Param('organizationId') organizationId: string,
    @Param('toolExecutionId') toolExecutionId: string,
    @Body() body: AgentActionDecisionDto,
    @Session() session: UserSession,
  ) {
    return this.approvals.reject({
      organizationId,
      toolExecutionId,
      actorUserId: session.user.id,
      note: body.note,
    });
  }
}
