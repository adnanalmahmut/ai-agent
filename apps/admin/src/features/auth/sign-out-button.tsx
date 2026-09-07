'use client';

import { Button } from '@repo/ui';
import { useState } from 'react';

import { useRouter } from '@/i18n/navigation';

import { authClient } from './auth-client';
import { ADMIN_ROUTES } from './routes';

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  const [isPending, setPending] = useState(false);

  async function signOut() {
    setPending(true);

    try {
      await authClient.signOut();
    } catch {
      // The session may already be gone. Either way the reader is leaving.
    }

    router.replace(ADMIN_ROUTES.signIn);
    router.refresh();
  }

  return (
    <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={signOut}>
      {label}
    </Button>
  );
}
