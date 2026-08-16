import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui';
import type { ReactNode } from 'react';

/**
 * The frame every authentication screen sits in.
 *
 * Presentational and translation-free on purpose: it takes already-translated
 * nodes, so it can be rendered from a Server Component and never needs a
 * dictionary of its own. Every string it displays was chosen by its caller.
 */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="w-full gap-5 shadow-sm">
      <CardHeader className="gap-1.5">
        {/*
          A real `<h1>` inside the design system's title slot. Every screen
          under this card *is* a page, and a page whose title is a `<div>`
          gives a screen-reader user no landmark to jump to.
        */}
        <CardTitle>
          <h1 className="text-xl tracking-tight">{title}</h1>
        </CardTitle>

        {description ? (
          <p className="text-sm leading-6 text-muted-foreground text-pretty">
            {description}
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5">{children}</CardContent>

      {footer ? (
        <div className="border-t px-6 pt-5 text-sm text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
