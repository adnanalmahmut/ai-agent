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
import { Loader2, LogOut, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'use-intl';

import { MIRRORED_ICON } from '@/components/directional-icon';
import { useSignOut } from '@/features/auth/hooks/use-sign-out';
import { GlobalPermissionGate } from '@/features/authorization/permission-gate';

import { userInitials } from '@/lib/user-initials';

/**
 * Identity and the actions attached to it.
 *
 * The user's details are passed in rather than read from a client session
 * hook: the shell already has them from the server render, and re-fetching
 * would make the header pop in a beat after the page.
 *
 * The administration entry is wrapped in a permission gate purely so the menu
 * does not offer a door that opens onto a 403 — the gate asks whether the
 * user could list users, not whether they are an admin, which is what keeps
 * a role name out of this file. Nothing behind that door is protected by it.
 */
export function UserAccountMenu({
  name,
  email,
  image,
}: {
  name: string | null;
  email: string;
  image?: string | null;
}) {
  const t = useTranslations('Platform');
  const signOut = useSignOut();

  const initials = userInitials(name, email);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t('account.label')}
        >
          <Avatar>
            {image ? <AvatarImage src={image} alt="" /> : null}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        <div className="px-2 py-1.5">
          <div className="truncate text-sm font-medium">
            {name ?? t('account.unnamed')}
          </div>
          {/* Left-to-right text inside a possibly right-to-left menu. */}
          <bdi className="block truncate text-xs text-muted-foreground">
            {email}
          </bdi>
        </div>

        <GlobalPermissionGate permissions={{ user: ['list'] }}>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled>
            <ShieldCheck />
            {t('account.administration')}
          </DropdownMenuItem>
        </GlobalPermissionGate>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          disabled={signOut.isPending}
          onSelect={(event) => {
            event.preventDefault();
            void signOut.submit();
          }}
        >
          {signOut.isPending ? (
            <Loader2 className="animate-spin" />
          ) : (
            <LogOut className={MIRRORED_ICON} />
          )}
          {t('account.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
