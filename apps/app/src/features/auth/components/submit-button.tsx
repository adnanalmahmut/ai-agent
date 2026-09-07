import { Button } from '@repo/ui';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

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
