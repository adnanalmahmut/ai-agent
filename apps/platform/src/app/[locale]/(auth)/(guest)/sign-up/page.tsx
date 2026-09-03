import { SignUpBlock } from '@/features/auth/blocks/sign-up-block';
import { RETURN_TO_PARAM } from '@/features/auth/routes';
import { safeReturnPath } from '@/features/auth/safe-return-url';
import { firstRouteParam, type RouteSearchParams } from '@/lib/route-search-params';

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  return (
    <SignUpBlock
      returnTo={safeReturnPath(firstRouteParam(query, RETURN_TO_PARAM))}
    />
  );
}
