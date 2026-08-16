import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui';

import { userInitials } from '@/lib/user-initials';

/**
 * A person, as a row of a list sees them: avatar, name, address.
 *
 * The email is wrapped in `<bdi>` — it is left-to-right text, and inside an
 * Arabic interface its punctuation reorders without the isolation, which turns
 * `name@example.com` into something that is not an address.
 *
 * `alt=""` on the avatar because the name is right beside it; describing the
 * photograph as well would announce the person twice.
 */
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
