'use client';

import { createContext, forwardRef, useContext, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Accessible form field.
 *
 * The wiring between a label, its control, its hint and its error message is
 * where form accessibility is usually lost — not because people disagree with
 * it, but because doing it by hand means inventing and threading three ids
 * through four components every single time, and one of them eventually gets
 * missed.
 *
 * FormField generates the ids once and distributes them by context, so:
 *   - the label is programmatically associated with the control
 *   - hint and error are joined into aria-describedby (both, in reading order)
 *   - aria-invalid is set only when there is an actual error
 *   - the error is announced politely rather than stealing focus
 *
 * Getting this wrong is invisible to a sighted mouse user and completely
 * blocking for a screen-reader user, which is exactly why it is a component
 * rather than a convention.
 */

interface FieldContextValue {
  controlId: string;
  hintId: string;
  errorId: string;
  hasError: boolean;
  hasHint: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

function useField(component: string): FieldContextValue {
  const context = useContext(FieldContext);
  if (!context) {
    throw new Error(`<${component}> must be rendered inside <FormField>.`);
  }
  return context;
}

export interface FormFieldProps {
  children: React.ReactNode;
  /** Presence of a message switches the field into its invalid state. */
  error?: string | undefined;
  hint?: string | undefined;
  className?: string;
}

export function FormField({ children, error, hint, className }: FormFieldProps) {
  const base = useId();

  return (
    <FieldContext.Provider
      value={{
        controlId: `${base}-control`,
        hintId: `${base}-hint`,
        errorId: `${base}-error`,
        hasError: Boolean(error),
        hasHint: Boolean(hint),
      }}
    >
      <div className={cn('flex flex-col gap-1.5', className)}>
        {children}
        {hint ? <FieldHint>{hint}</FieldHint> : null}
        <FieldError>{error}</FieldError>
      </div>
    </FieldContext.Provider>
  );
}

export function Label({
  children,
  className,
  requiredMarker = false,
}: {
  children: React.ReactNode;
  className?: string;
  requiredMarker?: boolean;
}) {
  const { controlId } = useField('Label');
  return (
    <label htmlFor={controlId} className={cn('text-sm font-medium', className)}>
      {children}
      {requiredMarker ? (
        <>
          {/* The asterisk is decorative; the control carries `required`, which
              is what assistive tech actually reports. */}
          <span aria-hidden="true" className="ml-0.5 text-red-600">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  const { hintId } = useField('FieldHint');
  return (
    <p id={hintId} className="text-xs text-[var(--color-muted,#666)]">
      {children}
    </p>
  );
}

function FieldError({ children }: { children?: React.ReactNode }) {
  const { errorId } = useField('FieldError');
  return (
    // Always rendered, even when empty. A live region must exist in the DOM
    // *before* its content changes, otherwise the first error is never
    // announced — a classic and very easy mistake to make.
    <p
      id={errorId}
      role="alert"
      aria-live="polite"
      className="text-xs font-medium text-red-600 empty:hidden"
    >
      {children}
    </p>
  );
}

/** Joins hint and error ids in reading order for aria-describedby. */
function describedBy(field: FieldContextValue): string | undefined {
  const ids = [field.hasHint ? field.hintId : null, field.hasError ? field.errorId : null].filter(
    Boolean,
  );
  return ids.length > 0 ? ids.join(' ') : undefined;
}

const controlStyles = [
  'w-full rounded-md border bg-transparent px-3 py-2 text-sm',
  'border-[var(--border,#e5e7eb)]',
  'placeholder:text-[var(--color-muted,#999)]',
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500',
  'aria-[invalid=true]:border-red-500',
  'disabled:opacity-50',
];

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    const field = useField('Input');
    return (
      <input
        ref={ref}
        id={field.controlId}
        aria-invalid={field.hasError || undefined}
        aria-describedby={describedBy(field)}
        className={cn(controlStyles, className)}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  const field = useField('Textarea');
  return (
    <textarea
      ref={ref}
      id={field.controlId}
      aria-invalid={field.hasError || undefined}
      aria-describedby={describedBy(field)}
      className={cn(controlStyles, 'min-h-24 resize-y', className)}
      {...props}
    />
  );
});
