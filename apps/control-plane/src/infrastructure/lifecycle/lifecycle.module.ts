import { Global, Module } from '@nestjs/common';

import { ProcessReadiness } from './readiness';

@Global()
@Module({
  providers: [ProcessReadiness],
  exports: [ProcessReadiness],
})
export class LifecycleModule {}
