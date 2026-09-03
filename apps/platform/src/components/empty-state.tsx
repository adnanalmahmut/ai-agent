import { cn } from '@repo/ui';
import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center',
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden
          className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          {icon}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <p className="font-medium text-balance">{title}</p>

        {description ? (
          <p className="mx-auto max-w-md text-sm leading-6 text-muted-foreground text-pretty">
            {description}
          </p>
        ) : null}
      </div>

      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
