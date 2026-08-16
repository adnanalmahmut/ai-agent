import type { ReactNode } from 'react';

/**
 * A labelled rule between two ways of signing in.
 *
 * Two flexible rules either side of the label rather than a centred label
 * over a border, so it mirrors correctly without a single directional class
 * and stays balanced however long the translation is — Arabic
 * "أو المتابعة باستخدام" is noticeably wider than "or continue with".
 */
export function AuthDivider({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3" role="presentation">
      <span className="h-px flex-1 bg-border" />
      <span className="text-xs text-muted-foreground">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
