import type { ReactNode } from 'react';

/**
 * The heading every dashboard page opens with.
 *
 * One component so the pages cannot drift: the same `<h1>`, the same measure
 * on the description, the same place for the primary action. It takes
 * already-translated nodes and holds no dictionary of its own — every string
 * it shows was chosen by its caller.
 *
 * The actions sit after the text in source order and are pushed to the far
 * edge by `justify-between`, which mirrors for free. On a narrow screen the
 * row wraps and they fall below the heading rather than squeezing it.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight text-balance">
          {title}
        </h1>

        {description ? (
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground text-pretty">
            {description}
          </p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
