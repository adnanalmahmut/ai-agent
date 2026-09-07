import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui';

import { userInitials } from '@/lib/user-initials';

export function PersonIdentity({
  name,
  email,
  image,
}: {
  name: string | null;
  email: string;
  image?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className="shrink-0">
        {image ? <AvatarImage src={image} alt="" /> : null}
        <AvatarFallback>{userInitials(name, email)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0">
        {name ? <div className="truncate font-medium">{name}</div> : null}
        <bdi className="block truncate text-sm text-muted-foreground">
          {email}
        </bdi>
      </div>
    </div>
  );
}
