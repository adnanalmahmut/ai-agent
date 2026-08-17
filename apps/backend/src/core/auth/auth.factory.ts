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

// Shared with email copy so advertised and enforced expiry cannot drift.
const RESET_PASSWORD_EXPIRES_IN_SECONDS = 3600;
const INVITATION_EXPIRES_IN_SECONDS = 48 * 60 * 60;

export type AppAuth = Auth;

/**
 * Keep the explicit BetterAuthOptions annotation.
 *
 * Inferring the full Better Auth options type under pnpm can produce TS2742
 * during declaration emit because the inferred type references non-portable
 * @better-auth/core paths.
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
    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    secret: config.secret,
    baseURL: config.baseUrl,

    // Keep this as an array: nestjs-better-auth also derives auth-route CORS from it.
    trustedOrigins: config.trustedOrigins,

    // Intentionally no session cookie cache: authorization changes and session
    // revocation must be observed on the next request. Revisit only if measured.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN_SECONDS,
      sendResetPassword,
    },

    emailVerification: {
      sendVerificationEmail,
      sendOnSignUp: true,

      // Email verification proves mailbox ownership; starting a session stays explicit.
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
      // Protect stored OAuth credentials from database/backup disclosure.
      encryptOAuthTokens: true,
      // Do not weaken Better Auth's default verified-email account-linking checks.
    },

    user: {
      additionalFields: {
        // Server-managed; not accepted from sign-up payloads.
        preferredLanguage: {
          type: 'string',
          required: false,
          input: false,
        },
        // Administrative lifecycle state: never client-writable or exposed in auth responses.
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
        adminRoles: [...GLOBAL_ADMIN_ROLES],
      }),

      organization({
        ac: organizationAccessControl,
        roles: organizationRoles,
        creatorRole: ORGANIZATION_CREATOR_ROLE,

        // Organizations are archived, never hard-deleted.
        disableOrganizationDeletion: true,
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        cancelPendingInvitationsOnReInvite: true,

        // Require verified mailbox ownership before acting on an invitation.
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail,
      }),

      // Omit the plugin entirely when docs are disabled; hiding the reference UI
      // alone would still expose the auth OpenAPI schema endpoint.
      ...(openApiEnabled ? [openAPI({ disableDefaultReference: true })] : []),
    ],

    advanced: {
      cookies: {
        session_token: {
          name: '__Host-session',
        },
      },
    },
  };

  return betterAuth(options);
}
