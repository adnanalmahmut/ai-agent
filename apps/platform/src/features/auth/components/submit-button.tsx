import { Button } from '@repo/ui';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A submit button that cannot be double-fired and says so.
 *
 * The spinner replaces the leading icon rather than sitting beside it, so the
 * button keeps its width and the form does not reflow the moment it is
 * pressed. `aria-busy` carries the same news to assistive technology, which
 * cannot see the spinner.
 */
export function SubmitButton({
  isPending,
  children,
  icon,
  className,
}: {
  isPending: boolean;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <Button
      type="submit"
      className={className ?? 'w-full'}
      disabled={isPending}
      aria-busy={isPending}
    >
      {isPending ? <Loader2 className="animate-spin" /> : icon}
      {children}
    </Button>
  );
}
