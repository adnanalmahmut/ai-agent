import { isAppLocale, type AppLocale } from '@repo/i18n-core';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui';
import {
  CheckCircle2,
  Globe,
  KeyRound,
  Laptop,
  Loader2,
  LogOut,
  Save,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { authClient } from '@/features/auth/auth-client';
import {
  authErrorMessageKey,
  normalizeAuthError,
} from '@/features/auth/auth-errors';
import { FormField } from '@/features/auth/components/form-field';
import { PasswordField } from '@/features/auth/components/password-field';
import { SubmitButton } from '@/features/auth/components/submit-button';
import { usePlatformSession } from '@/features/auth/use-platform-session';
import { rememberLocale } from '@/i18n/locale-cookie';
import { localeSwitchHref } from '@/i18n/locale-switch-href';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAppLocale } from '@/i18n/use-app-locale';
import { deactivateSelfAccount } from '@/lib/application-api';

type ActiveSession = NonNullable<
  Awaited<ReturnType<typeof authClient.listSessions>>['data']
>[number] & {
  country?: string | null;
  city?: string | null;
};

export function ProfileSection() {
  const t = useTranslations('UserSettings.profile');
  const tAuth = useTranslations('Auth');
  const session = usePlatformSession();
  const router = useRouter();
  const pathname = usePathname();
  const activeLocale = useAppLocale();

  const initialLang = isAppLocale(session.user.preferredLanguage)
    ? session.user.preferredLanguage
    : activeLocale;

  const [name, setName] = useState(session.user.name ?? '');
  const [image, setImage] = useState(session.user.image ?? '');
  const [language, setLanguage] = useState<AppLocale>(initialLang);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsPending(true);
    setIsSaved(false);
    setErrorMsg(null);

    try {
      const res = await authClient.updateUser({
        name,
        image: image || undefined,
        preferredLanguage: language,
      });

      if (res?.error) {
        const code = normalizeAuthError(res.error);
        setErrorMsg(tAuth(authErrorMessageKey(code)));
        return;
      }

      rememberLocale(language);
      setIsSaved(true);

      if (language !== activeLocale) {
        // Same page, same query, same anchor — only the language changes.
        // The address is read at this moment rather than subscribed to; see
        // the language switcher for why.
        router.replace(
          localeSwitchHref(pathname, {
            search: window.location.search,
            hash: window.location.hash,
          }),
          { locale: language },
        );
      }
    } catch (err) {
      const code = normalizeAuthError(err);
      setErrorMsg(tAuth(authErrorMessageKey(code)));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Card className="ds-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {isSaved ? (
          <div
            className="flex items-start gap-2.5 rounded-md bg-muted/60 border border-border/40 p-3 text-xs"
            aria-live="polite"
          >
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <p className="leading-5 text-muted-foreground">{t('saved')}</p>
          </div>
        ) : null}

        {errorMsg ? (
          <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <p className="leading-5">{errorMsg}</p>
          </div>
        ) : null}

        <form noValidate className="space-y-4" onSubmit={handleSubmit}>
          <FormField
            type="text"
            label={t('name')}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <FormField
            type="url"
            label={t('image')}
            value={image}
            onChange={(e) => setImage(e.target.value)}
          />

          <div className="space-y-1.5">
            <Label className="text-xs font-semibold text-foreground">
              {t('language')}
            </Label>
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" />
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as AppLocale)}
                className="h-8 w-full rounded-md border border-border/60 bg-background px-3 text-xs text-foreground focus:ring-1 focus:ring-ring outline-none"
              >
                <option value="en">{t('languages.en')}</option>
                <option value="ar">{t('languages.ar')}</option>
              </select>
            </div>
          </div>

          <SubmitButton
            isPending={isPending}
            icon={<Save className="size-3.5" />}
            className="w-full sm:w-auto h-8 text-xs font-semibold"
          >
            {t('save')}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export function EmailSection() {
  const t = useTranslations('UserSettings.profile');
  const tAuth = useTranslations('Auth');
  const session = usePlatformSession();

  const [newEmail, setNewEmail] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleResend = async () => {
    setIsResending(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const res = await authClient.sendVerificationEmail({
        email: session.user.email,
        callbackURL: window.location.href,
      });
      if (res?.error) {
        const code = normalizeAuthError(res.error);
        setErrorMsg(tAuth(authErrorMessageKey(code)));
        return;
      }
      setMessage(t('verificationSent'));
    } catch (err) {
      const code = normalizeAuthError(err);
      setErrorMsg(tAuth(authErrorMessageKey(code)));
    } finally {
      setIsResending(false);
    }
  };

  const handleChangeEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newEmail) return;

    setIsPending(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const res = await authClient.changeEmail({
        newEmail,
        callbackURL: window.location.href,
      });

      if (res?.error) {
        const code = normalizeAuthError(res.error);
        setErrorMsg(tAuth(authErrorMessageKey(code)));
        return;
      }

      setMessage(t('emailChangeSent'));
      setNewEmail('');
    } catch (err) {
      const code = normalizeAuthError(err);
      setErrorMsg(tAuth(authErrorMessageKey(code)));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Card className="ds-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          {t('emailTitle')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('emailDescription')}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {message ? (
          <div
            className="flex items-start gap-2.5 rounded-md bg-muted/60 border border-border/40 p-3 text-xs"
            aria-live="polite"
          >
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <p className="leading-5 text-muted-foreground">{message}</p>
          </div>
        ) : null}

        {errorMsg ? (
          <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <p className="leading-5">{errorMsg}</p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/40 bg-muted/30 p-3">
          <div className="space-y-0.5 min-w-0">
            <div className="text-xs font-medium text-muted-foreground">
              {t('currentEmail')}
            </div>
            <div className="text-xs font-semibold text-foreground truncate">
              {session.user.email}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {session.user.emailVerified ? (
              <Badge
                variant="outline"
                className="text-xs border-border/40 text-foreground bg-background"
              >
                {t('verifiedBadge')}
              </Badge>
            ) : (
              <>
                <Badge
                  variant="secondary"
                  className="text-xs text-destructive bg-destructive/10"
                >
                  {t('unverifiedBadge')}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleResend()}
                  disabled={isResending}
                  className="h-7 text-xs border-border/60"
                >
                  {isResending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  {t('resendVerification')}
                </Button>
              </>
            )}
          </div>
        </div>

        <form noValidate className="space-y-4" onSubmit={handleChangeEmail}>
          <FormField
            type="email"
            autoComplete="email"
            label={t('newEmail')}
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />

          <SubmitButton
            isPending={isPending}
            className="w-full sm:w-auto h-8 text-xs font-semibold"
          >
            {t('changeEmailSubmit')}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export function SecuritySection() {
  const t = useTranslations('UserSettings.security');
  const tAuth = useTranslations('Auth');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [isPending, setIsPending] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErrorMsg(null);
    setIsSaved(false);

    if (newPassword !== confirmPassword) {
      setErrorMsg(t('mismatch'));
      return;
    }

    setIsPending(true);
    try {
      const res = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions,
      });

      if (res?.error) {
        const code = normalizeAuthError(res.error);
        setErrorMsg(tAuth(authErrorMessageKey(code)));
        return;
      }

      setIsSaved(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      const code = normalizeAuthError(err);
      setErrorMsg(tAuth(authErrorMessageKey(code)));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Card className="ds-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {isSaved ? (
          <div className="flex items-start gap-2.5 rounded-md bg-muted/60 border border-border/40 p-3 text-xs">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <p className="leading-5 text-muted-foreground">{t('updated')}</p>
          </div>
        ) : null}

        {errorMsg ? (
          <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <p className="leading-5">{errorMsg}</p>
          </div>
        ) : null}

        <form noValidate className="space-y-4" onSubmit={handleSubmit}>
          <PasswordField
            label={t('currentPassword')}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(val) => setCurrentPassword(val)}
          />

          <PasswordField
            label={t('newPassword')}
            autoComplete="new-password"
            value={newPassword}
            onChange={(val) => setNewPassword(val)}
          />

          <PasswordField
            label={t('confirmPassword')}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(val) => setConfirmPassword(val)}
          />

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="revokeOtherSessions"
              checked={revokeOtherSessions}
              onChange={(e) => setRevokeOtherSessions(e.target.checked)}
              className="size-4 rounded border-border/60 text-primary focus:ring-1 focus:ring-ring"
            />
            <Label
              htmlFor="revokeOtherSessions"
              className="text-xs text-muted-foreground cursor-pointer"
            >
              {t('revokeOtherSessions')}
            </Label>
          </div>

          <SubmitButton
            isPending={isPending}
            icon={<KeyRound className="size-3.5" />}
            className="w-full sm:w-auto h-8 text-xs font-semibold"
          >
            {t('submit')}
          </SubmitButton>
        </form>
      </CardContent>
    </Card>
  );
}

export function SessionsSection() {
  const t = useTranslations('UserSettings.sessions');
  const activeLocale = useAppLocale();
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRevokingAll, setIsRevokingAll] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await authClient.listSessions();
      if (res.data) {
        setSessions(res.data);
        setErrorMsg(null);
      } else if (res.error) {
        setErrorMsg(res.error.message || t('loadingError'));
      }
    } catch {
      setErrorMsg(t('loadingError'));
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const init = async () => {
      await loadSessions();
    };
    void init();
  }, [loadSessions]);

  const handleRevoke = async (token: string) => {
    setErrorMsg(null);
    try {
      const res = await authClient.revokeSession({ token });
      if (res?.error) {
        setErrorMsg(res.error.message || t('revokeError'));
        return;
      }
      await loadSessions();
    } catch {
      setErrorMsg(t('revokeError'));
    }
  };

  const handleRevokeOther = async () => {
    setIsRevokingAll(true);
    setErrorMsg(null);
    try {
      const res = await authClient.revokeOtherSessions();
      if (res?.error) {
        setErrorMsg(res.error.message || t('revokeOtherError'));
        return;
      }
      await loadSessions();
    } catch {
      setErrorMsg(t('revokeOtherError'));
    } finally {
      setIsRevokingAll(false);
    }
  };

  return (
    <Card className="ds-card">
      <CardHeader className="flex flex-row items-center justify-between p-4 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground">
            {t('title')}
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground">
            {t('description')}
          </CardDescription>
        </div>

        {sessions.length > 1 ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRevokeOther()}
            disabled={isRevokingAll}
            className="h-7 text-xs border border-border/50 gap-1.5"
          >
            {isRevokingAll ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogOut className="size-3.5" />
            )}
            {t('revokeOther')}
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="p-0">
        {errorMsg ? (
          <div className="m-4 flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <p className="leading-5">{errorMsg}</p>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin me-2" /> {t('loading')}
          </div>
        ) : sessions.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader className="ds-table-header">
              <TableRow className="hover:bg-transparent">
                <TableHead className="ds-table-head">
                  {t('userAgent')}
                </TableHead>
                <TableHead className="ds-table-head">
                  {t('ipAddress')}
                </TableHead>
                <TableHead className="ds-table-head">{t('location')}</TableHead>
                <TableHead className="ds-table-head">
                  {t('createdAt')}
                </TableHead>
                <TableHead className="py-2.5 px-3">
                  <span className="sr-only">{t('actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((sess) => (
                <TableRow
                  key={sess.id}
                  className="border-b border-border/30 hover:bg-sidebar-accent/50 transition-colors"
                >
                  <TableCell className="py-2.5 px-3 text-xs font-medium text-foreground">
                    <div className="flex items-center gap-2">
                      <Laptop className="size-4 text-muted-foreground shrink-0" />
                      <span className="truncate max-w-xs">
                        {sess.userAgent || t('unknownDevice')}
                      </span>
                      {sess.isCurrent ? (
                        <Badge
                          variant="secondary"
                          className="text-2xs rounded px-1.5 py-0.2"
                        >
                          {t('current')}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="py-2.5 px-3 text-xs text-muted-foreground font-mono">
                    {sess.ipAddress || '—'}
                  </TableCell>
                  <TableCell className="py-2.5 px-3 text-xs text-muted-foreground">
                    {[sess.city, sess.country].filter(Boolean).join(', ') ||
                      '—'}
                  </TableCell>
                  <TableCell className="py-2.5 px-3 text-xs text-muted-foreground">
                    {new Date(sess.createdAt).toLocaleDateString(activeLocale)}
                  </TableCell>
                  <TableCell className="py-2.5 px-3 text-end">
                    {!sess.isCurrent ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleRevoke(sess.token)}
                        className="h-7 text-xs text-destructive hover:bg-destructive/10"
                      >
                        {t('revoke')}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function LifecycleSection() {
  const t = useTranslations('UserSettings.lifecycle');
  const [isOpen, setIsOpen] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleDeactivate = async () => {
    setIsPending(true);
    setErrorMsg(null);
    try {
      await deactivateSelfAccount();
      window.location.reload();
    } catch {
      setErrorMsg(t('deactivateError'));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Card className="border border-destructive/40 rounded-lg shadow-2xs bg-card">
      <CardHeader className="p-4 pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold tracking-tight text-destructive">
          {t('deactivateTitle')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          {t('deactivateExplanation')}
        </CardDescription>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {errorMsg ? (
          <div className="flex items-start gap-2.5 rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <p className="leading-5">{errorMsg}</p>
          </div>
        ) : null}

        <Button
          variant="destructive"
          size="sm"
          onClick={() => setIsOpen(true)}
          className="h-8 text-xs font-semibold gap-1.5"
        >
          <ShieldAlert className="size-3.5" />
          {t('deactivateAction')}
        </Button>
      </CardContent>

      <ConfirmDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        isDestructive
        isPending={isPending}
        title={t('confirmTitle')}
        description={t('confirmDescription')}
        confirmLabel={t('confirmButton')}
        cancelLabel={t('cancel')}
        onConfirm={() => void handleDeactivate()}
      />
    </Card>
  );
}
