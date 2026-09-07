import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * The four browser origins this installation is made of, stated once.
 *
 * Before this, "where does the customer application live" was answerable only
 * by parsing `APP_PLATFORM_URL`, and "where does the API live" only by parsing
 * `BETTER_AUTH_URL`. Both are still the operative settings and neither moves
 * here; what changes is that the origins are now named, parsed as origins, and
 * checked against each other, so a deployment cannot hold two different
 * answers to the same question and find out from a broken login.
 *
 * An origin is a scheme, a host and a port. A value carrying a path, a query
 * or a fragment is refused rather than trimmed: `https://example.com/app` and
 * `https://example.com` are the same origin, and silently accepting the first
 * as the second would make a comparison that looks exact into a comparison
 * that is not.
 *
 * None of this is authorization. Which origin a browser is on says nothing
 * about who is using it or what they may do; those are the session's business
 * and the authorization policy's. The origins exist so that cookies stay
 * host-only, so the trusted-origin allowlist can be exact, and so a return
 * destination can be checked against something specific.
 *
 * Several of them being equal is a valid answer, not a degenerate one. The
 * deployment today serves every surface from one host on different paths, so
 * the public, app and API origins are the same string; separating them is a
 * hostname decision that this model describes either way.
 */

/** Local development, where each surface has a port rather than a hostname. */
const LOCAL = {
  public: 'http://localhost:3000',
  app: 'http://localhost:3001',
  api: 'http://localhost:3002',
  admin: 'http://localhost:3003',
} as const;

export class OriginConfigurationError extends Error {}

/**
 * One host: an IPv6 literal in brackets, or dot-separated labels of letters,
 * digits and inner hyphens. Deliberately narrow — anything a wildcard, a
 * pattern or a smuggled authority would need is outside it.
 */
const HOSTNAME =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/;

/**
 * A scheme, a host and a port, and nothing else.
 *
 * `URL` normalisation is the whole point: it is what makes
 * `HTTPS://App.Example.COM` and `https://app.example.com` compare equal, and
 * `https://app.example.com.attacker.example` compare unequal. Nothing here
 * does prefix or suffix matching, because neither is a statement about
 * origins.
 */
export function parseOrigin(name: string, value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new OriginConfigurationError(`${name} must be an absolute URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginConfigurationError(`${name} must be http or https`);
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    throw new OriginConfigurationError(`${name} must be an origin, not a path`);
  }

  validateAuthority(name, url);

  return url.origin;
}

/** The origin of a URL that legitimately carries a path, such as a mount. */
function originOf(name: string, value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new OriginConfigurationError(`${name} must be an absolute URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OriginConfigurationError(`${name} must be http or https`);
  }

  validateAuthority(name, url);

  return url.origin;
}

function validateAuthority(name: string, url: URL): void {
  if (url.username !== '' || url.password !== '') {
    throw new OriginConfigurationError(`${name} must not carry credentials`);
  }

  if (url.search !== '' || url.hash !== '') {
    throw new OriginConfigurationError(
      `${name} must not carry a query or fragment`,
    );
  }

  // `URL` accepts a good deal more in a host than a host may contain —
  // `https://*.example.com` parses, with `*.example.com` as the hostname. So
  // the guarantee that an entry is one host rather than a pattern has to be
  // made here, not left to each caller to remember.
  if (!HOSTNAME.test(url.hostname)) {
    throw new OriginConfigurationError(
      `${name} must name one host; "${url.hostname}" is not a hostname`,
    );
  }

  // `URL.origin` is "null" for a scheme without one; http and https always
  // have one, so reaching that would mean the protocol check above was wrong.
  if (url.origin === 'null') {
    throw new OriginConfigurationError(`${name} has no origin`);
  }
}

const schema = z.object({
  APP_ORIGIN_PUBLIC: z.string().optional(),
  APP_ORIGIN_APP: z.string().optional(),
  APP_ORIGIN_ADMIN: z.string().optional(),
  APP_ORIGIN_API: z.string().optional(),
});

export type OriginConfig = {
  /** The public marketing site. */
  readonly public: string;
  /** The authenticated customer application. */
  readonly app: string;
  /**
   * The administrative surface. Configured or not: nothing deploys it yet, and
   * a value invented here would be an allowlist entry for an origin that does
   * not exist.
   */
  readonly admin: string | null;
  /** Where the API answers, which is also where Better Auth is mounted. */
  readonly api: string;
};

/**
 * Derived where a canonical source already exists, explicit where it does not,
 * and refused where the two disagree.
 *
 * The app origin comes from `APP_PLATFORM_URL` and the API origin from
 * `BETTER_AUTH_URL`, because those are the values the running system already
 * behaves according to — email links are built from the first and Better Auth
 * mounts itself at the second. Setting `APP_ORIGIN_APP` or `APP_ORIGIN_API` to
 * something else does not change that behaviour, so it is a contradiction
 * rather than a configuration, and it fails at boot.
 */
export function resolveOrigins(
  environment: NodeJS.ProcessEnv = process.env,
): OriginConfig {
  const declared = schema.parse(environment);

  const app = agree(
    'APP_ORIGIN_APP',
    declared.APP_ORIGIN_APP,
    environment.APP_PLATFORM_URL === undefined
      ? LOCAL.app
      : originOf('APP_PLATFORM_URL', environment.APP_PLATFORM_URL),
    'APP_PLATFORM_URL',
  );

  const api = agree(
    'APP_ORIGIN_API',
    declared.APP_ORIGIN_API,
    environment.BETTER_AUTH_URL === undefined
      ? LOCAL.api
      : originOf('BETTER_AUTH_URL', environment.BETTER_AUTH_URL),
    'BETTER_AUTH_URL',
  );

  return {
    public:
      declared.APP_ORIGIN_PUBLIC === undefined
        ? environment.APP_PLATFORM_URL === undefined
          ? LOCAL.public
          : app
        : parseOrigin('APP_ORIGIN_PUBLIC', declared.APP_ORIGIN_PUBLIC),
    app,
    admin:
      declared.APP_ORIGIN_ADMIN === undefined
        ? null
        : parseOrigin('APP_ORIGIN_ADMIN', declared.APP_ORIGIN_ADMIN),
    api,
  };
}

function agree(
  name: string,
  declared: string | undefined,
  derived: string,
  source: string,
): string {
  if (declared === undefined) return derived;

  const explicit = parseOrigin(name, declared);

  if (explicit !== derived) {
    throw new OriginConfigurationError(
      `${name} is ${explicit} but ${source} says ${derived}. ` +
        `Two answers to the same question is a deployment that works until it does not.`,
    );
  }

  return explicit;
}

export default registerAs('origins', (): OriginConfig => resolveOrigins());
