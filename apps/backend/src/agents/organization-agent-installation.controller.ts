import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../core/auth';
import { createZodDto } from '../core/http';
import { OrganizationAgentInstallationService } from './organization-agent-installation.service';
import {
  createOrganizationAgentInstallationSchema,
  organizationAgentVersionQuerySchema,
  replaceOrganizationAgentInstallationSchema,
} from './organization-agent-installation.types';

class CreateOrganizationAgentInstallationDto extends createZodDto(
  createOrganizationAgentInstallationSchema,
) {}
class ReplaceOrganizationAgentInstallationDto extends createZodDto(
  replaceOrganizationAgentInstallationSchema,
) {}
class OrganizationAgentVersionQueryDto extends createZodDto(
  organizationAgentVersionQuerySchema,
) {}

@ApiTags('Organization agents')
@Controller('organizations/:organizationId/agent-installations')
@UseGuards(OrganizationPermissionGuard)
export class OrganizationAgentInstallationController {
  constructor(
    private readonly installations: OrganizationAgentInstallationService,
  ) {}

  @Get('catalog')
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({ summary: 'List installable code-owned agent definitions' })
  catalog() {
    return this.installations.catalog();
  }

  @Get()
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({ summary: 'List current organization agent installations' })
  list(@Param('organizationId') organizationId: string) {
    return this.installations.list(organizationId);
  }

  @Post()
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({ summary: 'Install and activate one code-owned agent' })
  create(
    @Param('organizationId') organizationId: string,
    @Body() body: CreateOrganizationAgentInstallationDto,
    @Session() session: UserSession,
  ) {
    return this.installations.create(organizationId, body, session.user.id);
  }

  @Put(':installationId')
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({ summary: 'Create and activate an immutable agent version' })
  @ApiParam({ name: 'installationId' })
  replace(
    @Param('organizationId') organizationId: string,
    @Param('installationId') installationId: string,
    @Body() body: ReplaceOrganizationAgentInstallationDto,
    @Session() session: UserSession,
  ) {
    return this.installations.replace(
      organizationId,
      installationId,
      body,
      session.user.id,
    );
  }

  @Get(':installationId/versions')
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({ summary: 'List immutable organization agent versions' })
  @ApiParam({ name: 'installationId' })
  versions(
    @Param('organizationId') organizationId: string,
    @Param('installationId') installationId: string,
    @Query() query: OrganizationAgentVersionQueryDto,
  ) {
    return this.installations.listVersions({
      organizationId,
      installationId,
      cursor: query.cursor,
      limit: query.limit,
    });
  }
}
