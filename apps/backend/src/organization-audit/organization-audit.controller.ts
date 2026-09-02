import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../infrastructure/auth';
import { createZodDto } from '../infrastructure/http';
import { OrganizationAuditService } from './organization-audit.service';

const organizationAuditQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: z.coerce.number().int().optional(),
  })
  .strict();

class OrganizationAuditQueryDto extends createZodDto(
  organizationAuditQuerySchema,
) {}

@ApiTags('Organization audit')
@Controller('organizations/:organizationId/audit-events')
@UseGuards(OrganizationPermissionGuard)
export class OrganizationAuditController {
  constructor(private readonly audit: OrganizationAuditService) {}

  @Get()
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({
    operationId: 'listOrganizationAuditEvents',
    summary: 'List one bounded page of organization product history',
  })
  @ApiParam({ name: 'organizationId' })
  list(
    @Param('organizationId') organizationId: string,
    @Query() query: OrganizationAuditQueryDto,
  ) {
    return this.audit.list({
      organizationId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
