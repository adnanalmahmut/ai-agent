import type { ReactNode } from 'react';

export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3" role="presentation">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
