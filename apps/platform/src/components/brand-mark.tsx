import { cn } from '@repo/ui';

export function BrandMark({
  className,
  size = 'default',
}: {
  className?: string;
  size?: 'default' | 'lg';
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'flex items-center justify-center rounded-lg border bg-card',
        size === 'lg' ? 'size-11' : 'size-9',
        className,
      )}
    >
      <div
        className={cn(
          'rounded-sm bg-primary',
          size === 'lg' ? 'size-4' : 'size-3',
        )}
      />
    </div>
  );
}
