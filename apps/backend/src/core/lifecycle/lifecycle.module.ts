import { Global, Module } from '@nestjs/common';

import { ProcessReadiness } from './process-readiness';

/**
 * Process-level lifecycle state.
 *
 * Global because both the readiness endpoint and the shutdown sequence need the
 * *same* instance, and they live at opposite ends of the application — one in a
 * controller, the other in the entrypoint. Two instances would produce a probe
 * reporting ready throughout a drain, which is the exact failure this state
 * exists to prevent.
 */
@Global()
@Module({
  providers: [ProcessReadiness],
  exports: [ProcessReadiness],
})
export class LifecycleModule {}
