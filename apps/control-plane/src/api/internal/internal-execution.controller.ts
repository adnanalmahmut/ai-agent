import {
  Body,
  Controller,
  Headers,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { RuntimeStep } from '@repo/execution-contracts';

import { AppException } from '../../core/errors';
import type { ContractIssue } from '@repo/execution-contracts';
import {
  LeaseExecutionStepUseCase,
  SettleExecutionStepUseCase,
  type SettleExecutionStepOutcome,
} from '../../modules/execution';
import {
  InternalServiceGuard,
  RequiresServiceCapability,
} from './internal-service.guard';

/**
 * A tenant the caller believes it is acting for. Compared against durable
 * state, never used to find anything.
 */
const ASSERTED_ORGANIZATION = 'x-assert-organization-id';

/**
 * The execution boundary an out-of-process runtime talks to.
 *
 * Excluded from the published OpenAPI document on purpose: this is not part
 * of the product API, nothing generated from that contract should acquire it,
 * and no production runtime has been cut over to it. It is the seam that
 * makes such a cutover possible without giving a runtime a database.
 *
 * Every route is one authenticated service identity plus identifiers. There
 * is no request field that carries an authorization decision, a tenant the
 * Control Plane will trust, or an attempt ordinal the caller chose.
 */
@ApiExcludeController()
// Anonymous to Better Auth, not unauthenticated: these routes carry no user
// session by design, and `InternalServiceGuard` below is what decides them.
// Leaving the session guard in place would make the boundary unreachable
// while looking, from the outside, exactly like a rejected credential.
@AllowAnonymous()
@Controller('internal/execution/runs/:runId')
@UseGuards(InternalServiceGuard)
export class InternalExecutionController {
  constructor(
    private readonly lease: LeaseExecutionStepUseCase,
    private readonly settle: SettleExecutionStepUseCase,
  ) {}

  @Post('lease')
  @RequiresServiceCapability('execution:step.lease')
  async leaseStep(
    @Param('runId') runId: string,
    @Headers(ASSERTED_ORGANIZATION) assertedOrganizationId?: string,
  ): Promise<RuntimeStep> {
    const outcome = await this.lease.execute({
      runId,
      assertedOrganizationId: asserted(assertedOrganizationId),
    });

    switch (outcome.status) {
      case 'leased':
        return outcome.step;
      case 'not_found':
        throw new AppException('NOT_FOUND', { context: { resource: 'run' } });
      case 'not_claimed':
        throw new AppException('CONFLICT', {
          publicDetails: { reason: 'not_claimed' },
        });
      case 'not_executable':
        throw new AppException('CONFLICT', {
          publicDetails: { reason: 'not_executable' },
        });
    }
  }

  @Post('result')
  @RequiresServiceCapability('execution:step.settle')
  async submitResult(
    @Param('runId') runId: string,
    // Deliberately untyped: the published JSON Schema is the wire authority,
    // so the body reaches the use case exactly as it arrived and a second,
    // hand-written description of the same shape never gets a chance to
    // disagree with it.
    @Body() document: unknown,
    @Headers(ASSERTED_ORGANIZATION) assertedOrganizationId?: string,
  ): Promise<{ status: SettleExecutionStepOutcome['status'] }> {
    const outcome = await this.settle.execute({
      runId,
      document,
      assertedOrganizationId: asserted(assertedOrganizationId),
    });

    switch (outcome.status) {
      // A replay of the identical result is the same answer as applying it.
      case 'settled':
      case 'already_settled':
        return { status: outcome.status };
      case 'not_found':
        throw new AppException('NOT_FOUND', { context: { resource: 'run' } });
      case 'invalid_document':
        throw new AppException('BAD_REQUEST', {
          publicDetails: {
            reason: 'contract_violation',
            issues: summarise(outcome.issues),
          },
        });
      case 'identity_mismatch':
        throw new AppException('BAD_REQUEST', {
          publicDetails: { reason: 'identity_mismatch' },
        });
      case 'output_rejected':
        throw new AppException('BAD_REQUEST', {
          publicDetails: { reason: 'output_rejected' },
        });
      case 'unsupported_outcome':
        throw new AppException('CONFLICT', {
          publicDetails: {
            reason: 'unsupported_outcome',
            outcome: outcome.outcome,
          },
        });
      case 'stale':
        throw new AppException('CONFLICT', {
          publicDetails: { reason: 'stale' },
        });
      case 'conflict':
        throw new AppException('CONFLICT', {
          publicDetails: { reason: 'conflict' },
        });
    }
  }
}

function asserted(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Enough to fix a malformed document, bounded so a reply cannot be a payload. */
function summarise(
  issues: readonly ContractIssue[],
): { path: string; message: string }[] {
  return issues
    .slice(0, 5)
    .map((issue) => ({ path: issue.path, message: issue.message }));
}
