import { Avatar, AvatarFallback, AvatarImage, cn } from '@repo/ui';
import { Building2 } from 'lucide-react';

/**
 * An organization's mark.
 *
 * The logo when there is one, a neutral glyph when there is not — never
 * initials. An organization name is frequently a single Arabic word or an
 * acronym, and reducing it to one letter produces a row of identical circles
 * that identify nothing.
 *
 * It takes no name, and that is the accessibility decision rather than an
 * omission: the name is always rendered beside this mark, so `alt=""` on the
 * image and no title on the fallback keep a screen reader from announcing the
 * organization twice.
 */
export function OrganizationAvatar({
  logo,
  size = 'default',
  className,
}: {
  logo?: string | null;
  size?: 'default' | 'lg';
  className?: string;
}) {
  return (
    <Avatar
      size={size === 'lg' ? 'lg' : undefined}
      className={cn('rounded-lg', className)}
    >
      {logo ? <AvatarImage src={logo} alt="" className="rounded-lg" /> : null}

      <AvatarFallback className="rounded-lg">
        <Building2 className={size === 'lg' ? 'size-5' : 'size-4'} />
      </AvatarFallback>
    </Avatar>
  );
}
