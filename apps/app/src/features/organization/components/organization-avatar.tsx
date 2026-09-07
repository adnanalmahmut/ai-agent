import { Avatar, AvatarFallback, AvatarImage, cn } from '@repo/ui';
import { Building2 } from 'lucide-react';

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
