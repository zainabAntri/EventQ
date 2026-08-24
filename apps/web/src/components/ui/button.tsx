import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { Spinner } from './spinner';

/**
 * Button.
 *
 * Built on the native <button> rather than a div with a click handler, so
 * keyboard activation, focus order, disabled semantics and form submission all
 * come from the platform instead of being reimplemented (usually incompletely).
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 rounded-md font-medium',
    'transition-colors',
    // Focus ring is non-negotiable: the moderation queue is designed to be
    // driven entirely from the keyboard.
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
    // aria-disabled is styled alongside :disabled so a button that stays
    // focusable while busy still looks unavailable.
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white hover:bg-brand-700',
        secondary: 'bg-brand-50 text-brand-700 hover:bg-brand-100',
        outline: 'border border-current/20 hover:bg-current/5',
        ghost: 'hover:bg-current/5',
        danger: 'bg-red-600 text-white hover:bg-red-700',
      },
      size: {
        // 44px minimum touch target: attendees use this on a phone, standing up,
        // in a dim room.
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
      },
      fullWidth: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'primary', size: 'md', fullWidth: false },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and blocks activation without removing focus. */
  isLoading?: boolean;
  /** Announced while loading. Silence would leave screen readers guessing. */
  loadingLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    fullWidth,
    isLoading = false,
    loadingLabel = 'Loading',
    children,
    disabled,
    onClick,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      // The spread MUST come first. With it last, a caller's onClick silently
      // overrides the loading guard below and a double-click submits twice —
      // exactly the bug this component exists to prevent.
      {...props}
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, fullWidth }), className)}
      // aria-disabled rather than `disabled` while loading: a disabled element
      // loses focus, which silently drops the keyboard user back to the top of
      // the page mid-task.
      disabled={disabled}
      aria-disabled={isLoading || disabled || undefined}
      aria-busy={isLoading || undefined}
      onClick={
        isLoading
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          : onClick
      }
    >
      {isLoading ? (
        <>
          <Spinner className="size-4" />
          <span className="sr-only">{loadingLabel}</span>
        </>
      ) : null}
      {children}
    </button>
  );
});

export { buttonVariants };
