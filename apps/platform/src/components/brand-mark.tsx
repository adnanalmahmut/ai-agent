import { cn } from '@repo/ui';

/**
 * The application's mark.
 *
 * One component so the authentication pages and the platform shell cannot
 * drift apart — a sign-in screen that looks like a different product is the
 * classic tell of an auth flow bolted on afterwards.
 *
 * Deliberately geometric and token-driven: no image asset to load before the
 * first paint of a page whose whole job is to be fast.
 */
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
