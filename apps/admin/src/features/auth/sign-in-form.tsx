'use client';

import { Button, Input, Label } from '@repo/ui';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { z } from 'zod';

import { useRouter } from '@/i18n/navigation';

import { authClient } from './auth-client';
import { ADMIN_ROUTES } from './routes';

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, { message: 'emailRequired' })
    .pipe(z.email({ message: 'emailInvalid' })),
  // Deliberately only "something was typed": an account created before a
  // password rule changed must still be able to sign in.
  password: z.string().min(1, { message: 'passwordRequired' }),
});

type Issues = Partial<Record<'email' | 'password', string>>;

/**
 * Sign in, and nothing else.
 *
 * There is no account creation, no invitation acceptance and no password
 * recovery here: staff accounts are provisioned and recovered through the
 * existing account administration, and adding any of those to this surface
 * would make it a way in rather than a way through.
 */
export function SignInForm() {
  const t = useTranslations('signIn');
  const errors = useTranslations('signInErrors');
  const router = useRouter();
  const [issues, setIssues] = useState<Issues>({});
  const [failure, setFailure] = useState<'rejected' | 'unavailable' | null>(null);
  const [isPending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const parsed = schema.safeParse({
      email: form.get('email'),
      password: form.get('password'),
    });

    if (!parsed.success) {
      const found: Issues = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field !== 'email' && field !== 'password') continue;
        found[field] ??= issue.message;
      }
      setIssues(found);
      setFailure(null);
      return;
    }

    setIssues({});
    setFailure(null);
    setPending(true);

    let rejected = false;

    try {
      const result = await authClient.signIn.email(parsed.data);
      rejected = result.error != null;
    } catch {
      setFailure('unavailable');
      setPending(false);
      return;
    }

    if (rejected) {
      // One message for every rejection. Which half was wrong, and whether
      // the address belongs to an account at all, is not this form's to say.
      setFailure('rejected');
      setPending(false);
      return;
    }

    // Whether the new session is a staff session is decided by the server, on
    // the workspace it is about to render — not here.
    router.replace(ADMIN_ROUTES.workspace);
    router.refresh();
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t('email')}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          aria-invalid={issues.email !== undefined}
          aria-describedby={issues.email ? 'email-error' : undefined}
        />
        {issues.email ? (
          <p id="email-error" role="alert" className="text-sm text-destructive">
            {errors(issues.email)}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t('password')}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          aria-invalid={issues.password !== undefined}
          aria-describedby={issues.password ? 'password-error' : undefined}
        />
        {issues.password ? (
          <p id="password-error" role="alert" className="text-sm text-destructive">
            {errors(issues.password)}
          </p>
        ) : null}
      </div>

      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {errors(failure)}
        </p>
      ) : null}

      <Button type="submit" disabled={isPending}>
        {isPending ? t('pending') : t('submit')}
      </Button>
    </form>
  );
}
