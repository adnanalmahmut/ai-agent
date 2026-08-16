import { prismaAdapter } from '@better-auth/prisma-adapter';
import type { ConfigType } from '@nestjs/config';
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { openAPI } from 'better-auth/plugins';
import { admin } from 'better-auth/plugins/admin';
import { organization } from 'better-auth/plugins/organization';

import type { appConfig, authConfig } from '../../config';
import type { PrismaService } from '../../database';
import type { MailService } from '../mail';
import {
  DEFAULT_GLOBAL_ROLE,
  GLOBAL_ADMIN_ROLES,
  globalAccessControl,
  globalRoles,
} from './auth-access';
import {
  createArchivedOrganizationHook,
  createArchivedOrganizationListFilter,
  createSoftDeleteDatabaseHooks,
} from './auth-hooks';
import { createAuthMailCallbacks } from './auth-mail';
import {
  ORGANIZATION_CREATOR_ROLE,
  organizationAccessControl,
  organizationRoles,
} from './organization-access';

/**
 * How long a password-reset link stays valid.
 *
 * One value feeds both the token's real lifetime and the number written into
 * the email, so the two cannot disagree. Better Auth's own default is the same
 * 3600 seconds; stating it explicitly is what makes it safe to quote.
 */
const RESET_PASSWORD_EXPIRES_IN_SECONDS = 3600;

/** Better Auth's own default, stated explicitly for the same reason. */
const INVITATION_EXPIRES_IN_SECONDS = 48 * 60 * 60;

export type AppAuth = Auth;

/**
 * The return type is annotated rather than inferred.
 *
 * `betterAuth()` infers `Auth<typeof options>`, a type that reaches into
 * `@better-auth/core` through pnpm's content-addressed paths — TypeScript
 * cannot write those into an emitted `.d.ts` (TS2742) and the build fails on a
 * path that is not portable between installs.
 *
 * `Auth` is invariant in its options parameter, so annotating the *options* as
 * `BetterAuthOptions` (rather than casting the result) is what makes the
 * return type nameable. The cost is plugin-specific inference on `auth.api`,
 * which this application does not rely on: `@thallesp/nestjs-better-auth`
 * types its own module options as `any`, and its `UserSession` fallback
 * already widens to include `user.role` and `session.activeOrganizationId`.
 */
export function createAuth(dependencies: {
  prisma: PrismaService;
  mail: MailService;
  config: ConfigType<typeof authConfig>;
  app: ConfigType<typeof appConfig>;
  openApiEnabled: boolean;
}): Auth {
  const { prisma, mail, config, app, openApiEnabled } = dependencies;

  const { sendVerificationEmail, sendResetPassword, sendInvitationEmail } =
    createAuthMailCallbacks(mail, {
      resetPasswordExpiresInMinutes: RESET_PASSWORD_EXPIRES_IN_SECONDS / 60,
      invitationExpiresInHours: INVITATION_EXPIRES_IN_SECONDS / 3600,
      platformUrl: app.platformUrl,
      lookupPreferredLanguage: async (email) => {
        const user = await prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { preferredLanguage: true },
        });
        return user?.preferredLanguage ?? null;
      },
    });

  const archivedOrganizationHook = createArchivedOrganizationHook(prisma);
  const archivedOrganizationListFilter =
    createArchivedOrganizationListFilter(prisma);

  const options: BetterAuthOptions = {
    // Reuses the application's single Prisma client rather than opening a
    // second pool for authentication.
    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    secret: config.secret,
    baseURL: config.baseUrl,
    // Must be a string array: `@thallesp/nestjs-better-auth` throws on a
    // function-valued `trustedOrigins`, because it also derives its CORS
    // configuration from this list.
    trustedOrigins: config.trustedOrigins,

    // No `session.cookieCache`. The database is the source of truth for both
    // authentication and authorization: a revoked session, a deactivated
    // account, a role change and a membership removal all take effect on the
    // very next request. Caching is a later, measured decision.

    emailAndPassword: {
      enabled: true,
      // Sign-in is refused until the address is confirmed, which also removes
      // sign-up as a user-enumeration oracle.
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN_SECONDS,
      sendResetPassword,
    },

    emailVerification: {
      sendVerificationEmail,
      sendOnSignUp: true,
      // Verifying an email proves control of the mailbox, not intent to start
      // a session. Signing in is left as a separate, deliberate step.
      autoSignInAfterVerification: false,
    },

    ...(config.google
      ? {
          socialProviders: {
            google: {
              clientId: config.google.clientId,
              clientSecret: config.google.clientSecret,
            },
          },
        }
      : {}),

    account: {
      // Access, refresh and id tokens are stored in the `account` table. At
      // rest they are provider credentials, not authorization inputs, and
      // nothing in this application reads them for an access decision — but a
      // database backup should not hand out live third-party sessions.
      encryptOAuthTokens: true,
      // Account linking is left on Better Auth's defaults, verified against
      // the installed source rather than assumed:
      //   `!isTrustedProvider && !userInfo.emailVerified
      //    || requireLocalEmailVerified && !dbUser.user.emailVerified` → refused
      // With `requireEmailVerification: true` above, every signed-in local user
      // is verified, so an existing account links to Google automatically —
      // while an *unverified* row (the pre-registration takeover vector) is
      // refused. `trustedProviders` is deliberately not set: it would only
      // weaken the first clause.
    },

    user: {
      additionalFields: {
        // Surfaces the column to the adapter and onto the session user, which
        // is what makes step 2 of the locale precedence reachable.
        // `input: false` keeps it out of client-supplied sign-up payloads.
        preferredLanguage: {
          type: 'string',
          required: false,
          input: false,
        },
        // Account lifecycle. Declared to Better Auth so the adapter carries
        // the columns through hooks; `input: false` so no client can set them
        // and `returned: false` so they never appear in a session or user
        // response. The lifecycle is administrative state, not profile data.
        deletedAt: {
          type: 'date',
          required: false,
          input: false,
          returned: false,
        },
        deletedByUserId: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
        },
        deletionReason: {
          type: 'string',
          required: false,
          input: false,
          returned: false,
        },
      },
    },

    databaseHooks: createSoftDeleteDatabaseHooks(prisma),

    hooks: {
      before: archivedOrganizationHook,
      after: archivedOrganizationListFilter,
    },

    plugins: [
      admin({
        ac: globalAccessControl,
        roles: globalRoles,
        defaultRole: DEFAULT_GLOBAL_ROLE,
        // Governs `impersonate-admins`: impersonating anyone holding one of
        // these roles needs that separate permission. The plugin throws at
        // construction if a name here is missing from `roles`.
        adminRoles: [...GLOBAL_ADMIN_ROLES],
      }),

      organization({
        ac: organizationAccessControl,
        roles: organizationRoles,
        creatorRole: ORGANIZATION_CREATOR_ROLE,
        // Hard deletion is not this application's lifecycle. The route answers
        // 404 with this on, and no role is granted `organization:delete`
        // either — two independent locks on the same door.
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        // Invitation ids travel by email; requiring a verified session email
        // makes proven mailbox control the ownership proof for acting on one.
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail,
        // Teams and dynamic access control stay off: each would add tables and
        // query cost for a capability nothing in the product asks for.
      }),

      // Omitted entirely when documentation is disabled. Merely hiding the
      // Scalar page would leave `/api/auth/open-api/generate-schema`
      // unauthenticated and publishing a map of every admin and organization
      // endpoint.
      ...(openApiEnabled ? [openAPI({ disableDefaultReference: true })] : []),
    ],

    advanced: {
      cookiePrefix: '__Host-',
    },
  };

  return betterAuth(options);
}
