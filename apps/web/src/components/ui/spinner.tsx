import { cn } from '@/lib/cn';

/**
 * Purely decorative spinner.
 *
 * aria-hidden by design: the surrounding control announces the busy state via
 * aria-busy and a visually-hidden label. A spinner that announces itself
 * produces duplicate, confusing screen-reader output.
 *
 * Honours prefers-reduced-motion through the global rule in globals.css.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn('size-5 animate-spin', className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
