import { SignInBlock } from '@/features/auth/blocks/sign-in-block';
import { CALLBACK_ERROR_PARAM } from '@/features/auth/callback-urls';
import { RETURN_TO_PARAM } from '@/features/auth/routes';
import { safeReturnPath } from '@/features/auth/safe-return-url';
import { firstRouteParam, type RouteSearchParams } from '@/lib/route-search-params';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  return (
    <SignInBlock
      returnTo={safeReturnPath(firstRouteParam(query, RETURN_TO_PARAM))}
      providerError={firstRouteParam(query, CALLBACK_ERROR_PARAM)}
    />
  );
}
