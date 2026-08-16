import { useSearchParams } from 'react-router';

import { ForgotPasswordBlock } from '@/features/auth/blocks/forgot-password-block';
import { ResetPasswordBlock } from '@/features/auth/blocks/reset-password-block';
import { SignInBlock } from '@/features/auth/blocks/sign-in-block';
import { SignUpBlock } from '@/features/auth/blocks/sign-up-block';
import { VerifyEmailBlock } from '@/features/auth/blocks/verify-email-block';
import {
  CALLBACK_ERROR_PARAM,
  VERIFICATION_STATUS_PARAM,
  VERIFICATION_STATUS_VERIFIED,
} from '@/features/auth/callback-urls';
import { RETURN_TO_PARAM } from '@/features/auth/routes';
import { safeReturnPath } from '@/features/auth/safe-return-url';
import { firstParam } from '@/lib/search-params';

/**
 * The five authentication routes.
 *
 * Each is a handful of lines: read the query string, hand it to a block. All
 * the state, every call to Better Auth and every decision about where a
 * successful attempt leads lives in the blocks and their hooks, which is what
 * keeps these readable as a description of what each URL is for.
 *
 * They share a file because separating five four-line modules would be five
 * files of imports. The blocks they render are one file each.
 */

export function SignInRoute() {
  const [params] = useSearchParams();

  return (
    <SignInBlock
      // Validated here rather than trusted: this value came from a query
      // string, which means it came from whoever wrote the link.
      returnTo={safeReturnPath(firstParam(params, RETURN_TO_PARAM))}
      providerError={firstParam(params, CALLBACK_ERROR_PARAM)}
    />
  );
}

export function SignUpRoute() {
  const [params] = useSearchParams();

  return (
    <SignUpBlock
      returnTo={safeReturnPath(firstParam(params, RETURN_TO_PARAM))}
    />
  );
}

export function VerifyEmailRoute() {
  const [params] = useSearchParams();

  return (
    <VerifyEmailBlock
      isVerified={
        firstParam(params, VERIFICATION_STATUS_PARAM) ===
        VERIFICATION_STATUS_VERIFIED
      }
      callbackError={firstParam(params, CALLBACK_ERROR_PARAM)}
    />
  );
}

export function ForgotPasswordRoute() {
  return <ForgotPasswordBlock />;
}

export function ResetPasswordRoute() {
  const [params] = useSearchParams();

  return (
    <ResetPasswordBlock
      // The token is read once and passed straight through. It is never
      // logged, never rendered and never put into a message.
      token={firstParam(params, 'token')}
      callbackError={firstParam(params, CALLBACK_ERROR_PARAM)}
    />
  );
}
