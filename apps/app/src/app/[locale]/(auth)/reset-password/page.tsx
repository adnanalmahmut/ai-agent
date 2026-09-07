import { ResetPasswordBlock } from '@/features/auth/blocks/reset-password-block';
import { CALLBACK_ERROR_PARAM } from '@/features/auth/callback-urls';
import { firstRouteParam, type RouteSearchParams } from '@/lib/route-search-params';

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<RouteSearchParams>;
}) {
  const query = await searchParams;
  return (
    <ResetPasswordBlock
      token={firstRouteParam(query, 'token')}
      callbackError={firstRouteParam(query, CALLBACK_ERROR_PARAM)}
    />
  );
}
