import { Module } from '@nestjs/common';

import { ExecutionModule } from '../../modules/execution';
import { InternalExecutionController } from './internal-execution.controller';
import { InternalServiceAuthenticator } from './internal-service.authenticator';
import { InternalServiceGuard } from './internal-service.guard';

@Module({
  imports: [ExecutionModule],
  controllers: [InternalExecutionController],
  providers: [InternalServiceAuthenticator, InternalServiceGuard],
  exports: [InternalServiceAuthenticator],
})
export class InternalExecutionModule {}
