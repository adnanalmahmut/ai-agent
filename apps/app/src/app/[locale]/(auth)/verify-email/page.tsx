import { VerifyEmailBlock } from '@/features/auth/blocks/verify-email-block';
import {
  CALLBACK_ERROR_PARAM,
  VERIFICATION_STATUS_PARAM,
  VERIFICATION_STATUS_VERIFIED,
} from '@/features/auth/callback-urls';
import { firstRouteParam, type RouteSearchParams } from '@/lib/route-search-params';

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  return (
    <VerifyEmailBlock
      isVerified={
        firstRouteParam(query, VERIFICATION_STATUS_PARAM) ===
        VERIFICATION_STATUS_VERIFIED
      }
      callbackError={firstRouteParam(query, CALLBACK_ERROR_PARAM)}
    />
  );
}
