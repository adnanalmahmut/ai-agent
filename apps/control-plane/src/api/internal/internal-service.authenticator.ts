import { createHash, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { internalServiceConfig } from '../../infrastructure/config';
import type { InternalServiceCapability } from '../../infrastructure/config';

/**
 * Who is calling, once a credential has proved it.
 *
 * The identity is a consequence of the secret presented, never of anything
 * else in the request: there is no service-name header, because a name a
 * caller writes is a claim and this has to be a proof.
 */
export type InternalServicePrincipal = {
  readonly serviceId: string;
  readonly capabilities: readonly InternalServiceCapability[];
};

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

@Injectable()
export class InternalServiceAuthenticator {
  private readonly byDigest: ReadonlyMap<
    string,
    { principal: InternalServicePrincipal; digest: Buffer }
  >;

  constructor(
    @Inject(internalServiceConfig.KEY)
    config: ConfigType<typeof internalServiceConfig>,
  ) {
    this.byDigest = new Map(
      config.credentials.map((credential) => [
        credential.tokenSha256,
        {
          principal: {
            serviceId: credential.serviceId,
            capabilities: credential.capabilities,
          },
          digest: Buffer.from(credential.tokenSha256, 'hex'),
        },
      ]),
    );
  }

  /** Whether this boundary can authenticate anyone at all. */
  get configured(): boolean {
    return this.byDigest.size > 0;
  }

  /**
   * Resolves the principal a request proves, or null.
   *
   * The comparison is over digests of a fixed width and runs against every
   * configured credential, so neither the time taken nor the number of
   * comparisons made distinguishes a near-miss from a wrong length. Nothing
   * derived from the presented token is returned, thrown or logged.
   */
  authenticate(authorization: unknown): InternalServicePrincipal | null {
    if (typeof authorization !== 'string') return null;

    const bearer = BEARER.exec(authorization);

    if (!bearer) return null;

    const presented = createHash('sha256').update(bearer[1], 'utf8').digest();
    let matched: InternalServicePrincipal | null = null;

    for (const candidate of this.byDigest.values()) {
      if (timingSafeEqual(presented, candidate.digest)) {
        matched = candidate.principal;
      }
    }

    return matched;
  }
}
