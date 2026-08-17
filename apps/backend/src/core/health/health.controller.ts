import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';

import { AppException } from '../errors';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @AllowAnonymous()
  @ApiOperation({
    operationId: 'getLiveness',
    summary: 'Liveness probe to check if application process is responsive',
  })
  getLive() {
    return this.healthService.getLiveness();
  }

  @Get('ready')
  @AllowAnonymous()
  @ApiOperation({
    operationId: 'getReadiness',
    summary:
      'Readiness probe to check connectivity to database and infrastructure dependencies',
  })
  async getReady() {
    const result = await this.healthService.getReadiness();

    if (result.status === 'error') {
      throw new AppException('SERVICE_UNAVAILABLE', {
        details: result.dependencies,
      });
    }

    return result;
  }
}
