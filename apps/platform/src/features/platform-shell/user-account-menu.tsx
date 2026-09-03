import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui';
import { ChevronUp, Loader2, LogOut, ShieldCheck, UserCog } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { MIRRORED_ICON } from '@/components/directional-icon';
import { PLATFORM_ROUTES } from '@/features/auth/routes';
import { useSignOut } from '@/features/auth/hooks/use-sign-out';
import { usePlatformSession } from '@/features/auth/use-platform-session';
import { GlobalPermissionGate } from '@/features/authorization/permission-gate';
import { Link } from '@/i18n/navigation';
import { userInitials } from '@/lib/user-initials';

type UserAccountMenuProps = {
  name?: string | null;
  email?: string;
  image?: string | null;
  user?: { name?: string | null; email?: string; image?: string | null } | null;
  variant?: 'compact' | 'full';
};

function ConnectedUserAccountMenu({
  variant,
}: {
  variant: 'compact' | 'full';
}) {
  const session = usePlatformSession();
  return (
    <UserAccountMenuContent
      name={session.user.name ?? null}
      email={session.user.email ?? ''}
      image={session.user.image ?? null}
      variant={variant}
    />
  );
}

export function UserAccountMenu({
  name,
  email,
  image,
  user,
  variant = 'compact',
}: UserAccountMenuProps) {
  const resolvedName = user?.name ?? name;
  const resolvedEmail = user?.email ?? email;
  const resolvedImage = user?.image ?? image;

  if (
    resolvedName !== undefined ||
    resolvedEmail !== undefined ||
    resolvedImage !== undefined
  ) {
    return (
      <UserAccountMenuContent
        name={resolvedName ?? null}
        email={resolvedEmail ?? ''}
        image={resolvedImage ?? null}
        variant={variant}
      />
    );
  }

  return <ConnectedUserAccountMenu variant={variant} />;
}

function UserAccountMenuContent({
  name,
  email,
  image,
  variant = 'compact',
}: {
  name: string | null;
  email: string;
  image: string | null;
  variant?: 'compact' | 'full';
}) {
  const t = useTranslations('Platform');
  const signOut = useSignOut();

  const initials = userInitials(name, email);

  if (variant === 'full') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="flex h-8 w-full items-center justify-between gap-2 rounded-md px-1.5 text-start hover:bg-sidebar-accent"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Avatar className="size-6 border border-border/50 text-xs font-semibold">
                {image ? <AvatarImage src={image} alt="" /> : null}
                <AvatarFallback className="bg-primary/10 text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 truncate">
                <div className="truncate text-xs font-semibold text-foreground">
                  {name ?? t('account.unnamed')}
                </div>
                <bdi className="block truncate text-xs text-muted-foreground">
                  {email}
                </bdi>
              </div>
            </div>
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          className="w-60 rounded-md border border-border shadow-md"
        >
          <div className="px-2 py-1.5">
            <div className="truncate text-xs font-semibold text-foreground">
              {name ?? t('account.unnamed')}
            </div>
            <bdi className="block truncate text-xs text-muted-foreground">
              {email}
            </bdi>
          </div>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild className="text-xs">
            <Link
              href={PLATFORM_ROUTES.userSettings}
              className="flex items-center gap-2"
            >
              <UserCog className="size-3.5 text-muted-foreground" />
              {t('account.userSettings')}
            </Link>
          </DropdownMenuItem>

          <GlobalPermissionGate permissions={{ user: ['list'] }}>
            <DropdownMenuItem asChild className="text-xs">
              <Link
                href={PLATFORM_ROUTES.adminUsers}
                className="flex items-center gap-2"
              >
                <ShieldCheck className="size-3.5 text-primary" />
                {t('account.administration')}
              </Link>
            </DropdownMenuItem>
          </GlobalPermissionGate>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            disabled={signOut.isPending}
            className="text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              void signOut.submit();
            }}
          >
            {signOut.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <LogOut className={`size-3.5 ${MIRRORED_ICON}`} />
            )}
            {t('account.signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full border border-border/40 hover:bg-sidebar-accent"
          aria-label={t('account.label')}
        >
          <Avatar className="size-7">
            {image ? <AvatarImage src={image} alt="" /> : null}
            <AvatarFallback className="text-xs font-semibold">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-60 rounded-md border border-border shadow-md"
      >
        <div className="px-2 py-1.5">
          <div className="truncate text-xs font-semibold text-foreground">
            {name ?? t('account.unnamed')}
          </div>
          <bdi className="block truncate text-xs text-muted-foreground">
            {email}
          </bdi>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild className="text-xs">
          <Link
            href={PLATFORM_ROUTES.userSettings}
            className="flex items-center gap-2"
          >
            <UserCog className="size-3.5 text-muted-foreground" />
            {t('account.userSettings')}
          </Link>
        </DropdownMenuItem>

        <GlobalPermissionGate permissions={{ user: ['list'] }}>
          <DropdownMenuItem asChild className="text-xs">
            <Link
              href={PLATFORM_ROUTES.adminUsers}
              className="flex items-center gap-2"
            >
              <ShieldCheck className="size-3.5 text-primary" />
              {t('account.administration')}
            </Link>
          </DropdownMenuItem>
        </GlobalPermissionGate>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          disabled={signOut.isPending}
          className="text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"
          onSelect={(event) => {
            event.preventDefault();
            void signOut.submit();
          }}
        >
          {signOut.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <LogOut className={`size-3.5 ${MIRRORED_ICON}`} />
          )}
          {t('account.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
