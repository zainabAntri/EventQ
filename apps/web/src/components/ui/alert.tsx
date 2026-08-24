import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Alert.
 *
 * The `role` is derived from severity rather than hard-coded, because the two
 * behave very differently for assistive technology:
 *   - role="alert" interrupts immediately (assertive) — correct for an error
 *   - role="status" waits for a pause (polite)       — correct for info
 *
 * Marking everything as `alert` trains users to ignore it, which defeats the
 * purpose the first time something genuinely matters.
 */
const alertVariants = cva('rounded-md border px-4 py-3 text-sm', {
  variants: {
    severity: {
      info: 'border-brand-300 bg-brand-50 text-brand-900',
      success: 'border-green-300 bg-green-50 text-green-900',
      warning: 'border-amber-300 bg-amber-50 text-amber-900',
      error: 'border-red-300 bg-red-50 text-red-900',
    },
  },
  defaultVariants: { severity: 'info' },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
}

export function Alert({ className, severity = 'info', title, children, ...props }: AlertProps) {
  const isUrgent = severity === 'error';

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      className={cn(alertVariants({ severity }), className)}
      {...props}
    >
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title && 'mt-1')}>{children}</div> : null}
    </div>
  );
}
