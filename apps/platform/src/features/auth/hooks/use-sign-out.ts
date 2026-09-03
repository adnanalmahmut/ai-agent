import { useCallback } from 'react';

import { useAppNavigate, useRevalidate } from '@/i18n/navigation';

import { authClient } from '../auth-client';
import { AUTH_ROUTES } from '../routes';
import { useAuthAction } from './use-auth-action';

export function useSignOut() {
  const navigate = useAppNavigate();
  const revalidate = useRevalidate();
  const { isPending, error, reset, run } = useAuthAction();

  const submit = useCallback(async () => {
    // Navigating regardless would be worse than it looks: the cookie would
    // still be there, the proxy would bounce the user straight back in, and
    // the failure would present as a page that flickered.
    const result = await run(() => authClient.signOut());
    if (!result) return;

    navigate(AUTH_ROUTES.signIn, { replace: true });
    revalidate();
  }, [navigate, revalidate, run]);

  return { submit, isPending, error, reset };
}
