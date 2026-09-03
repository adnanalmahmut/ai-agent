import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';

import {
  OrganizationPermissionGuard,
  RequiresOrganizationPermission,
} from '../infrastructure/auth';
import { createZodDto } from '../infrastructure/http';
import { replaceOrganizationBusinessProfileSchema } from './organization-business-profile.types';
import { OrganizationBusinessProfileService } from './organization-business-profile.service';

class ReplaceOrganizationBusinessProfileDto extends createZodDto(
  replaceOrganizationBusinessProfileSchema,
) {}

@ApiTags('Organization settings')
@Controller('organizations/:organizationId/business-profile')
@UseGuards(OrganizationPermissionGuard)
export class OrganizationBusinessProfileController {
  constructor(private readonly profiles: OrganizationBusinessProfileService) {}

  @Get()
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({
    operationId: 'getOrganizationBusinessProfile',
    summary: 'Read the organization business settings',
  })
  @ApiParam({ name: 'organizationId' })
  get(@Param('organizationId') organizationId: string) {
    return this.profiles.get(organizationId);
  }

  @Put()
  @RequiresOrganizationPermission({ organization: ['update'] })
  @ApiOperation({
    operationId: 'replaceOrganizationBusinessProfile',
    summary: 'Replace the organization business settings',
  })
  @ApiParam({ name: 'organizationId' })
  replace(
    @Param('organizationId') organizationId: string,
    @Body() body: ReplaceOrganizationBusinessProfileDto,
    @Session() session: UserSession,
  ) {
    return this.profiles.replace(organizationId, body, session.user.id);
  }
}
