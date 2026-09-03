import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../../infrastructure/auth';
import { createZodDto } from '../../infrastructure/http';
import { UserRateLimit } from '../../infrastructure/rate-limit';
import { AgentActionApprovalService } from './agent-action-approval.service';
import {
  agentActionApprovalQuery,
  agentActionDecisionInput,
} from './agent-action-approval.types';

class AgentActionDecisionDto extends createZodDto(agentActionDecisionInput) {}

class ListAgentActionApprovalsDto extends createZodDto(
  agentActionApprovalQuery,
) {}

/**
 * Human approval of proposed agent actions, over HTTP.
 *
 * Four operations and no others: read what is waiting, read one, approve,
 * reject. There is no "execute", because nothing a caller can do here performs
 * the effect — approval commits an outbox event, and the worker does the rest
 * after checking everything again. There is no "edit", because a proposal is
 * the agent's and a person decides on it as written.
 *
 * The shared organization guard runs before the body is validated and
 * authorizes against the organization in the path. `read` is membership;
 * `decide` is `admin` and `owner`.
 */
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
  detail(
    @Param('organizationId') organizationId: string,
    @Param('toolExecutionId') toolExecutionId: string,
  ) {
    return this.approvals.detail({ organizationId, toolExecutionId });
  }

  /**
   * Metered lightly. A decision is one row and one outbox event, but it is
   * also the act that lets a message leave, so a loop should not be able to
   * approve faster than a person could read.
   */
  @Post(':toolExecutionId/approve')
  @RequiresOrganizationPermission({ agentActionApproval: ['decide'] })
  @UserRateLimit({ points: 60, durationSec: 300 })
  @ApiOperation({
    operationId: 'approveAgentAction',
    summary: 'Approve one proposed agent action, once',
  })
  @ApiParam({ name: 'organizationId' })
  @ApiParam({ name: 'toolExecutionId' })
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
