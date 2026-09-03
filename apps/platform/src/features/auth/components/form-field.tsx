import { Input, Label, cn } from '@repo/ui';
import { useTranslations } from 'use-intl';
import type { ComponentProps, ReactNode } from 'react';
import { useId } from 'react';

export function FormField({
  label,
  issue,
  hint,
  trailing,
  className,
  ...inputProps
}: Omit<ComponentProps<typeof Input>, 'id'> & {
  label: string;
  issue?: string;
  hint?: ReactNode;
  trailing?: ReactNode;
}) {
  const t = useTranslations('Auth');
  const id = useId();
  const messageId = `${id}-message`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>

      <div className="relative">
        <Input
          id={id}
          aria-invalid={issue ? true : undefined}
          aria-describedby={issue || hint ? messageId : undefined}
          className={cn(trailing ? 'pe-10' : undefined, className)}
          {...inputProps}
        />

        {trailing ? (
          // `end-0` rather than `right-0`: the reveal button belongs at the
          // trailing edge of the field, which is the left in Arabic.
          <div className="absolute inset-y-0 end-0 flex items-center pe-1">
            {trailing}
          </div>
        ) : null}
      </div>

      {issue ? (
        <p id={messageId} className="text-sm text-destructive">
          {t(`validation.${issue}`)}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
