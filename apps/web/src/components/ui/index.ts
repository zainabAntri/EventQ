/**
 * UI foundation.
 *
 * Deliberately small. Every primitive here exists because the foundation needs
 * it now — a component library added before there is a component to build is
 * the "unnecessary dependency" the architecture warns against.
 *
 * Radix is intentionally NOT a dependency yet. It earns its place when the
 * first real dialog, menu or combobox appears (Phase 2); until then these are
 * native elements, which already have correct keyboard and focus behaviour.
 */

export { Button, buttonVariants, type ButtonProps } from './button';
export { Alert, type AlertProps } from './alert';
export { Spinner } from './spinner';
export { FormField, Label, Input, Textarea, type FormFieldProps } from './field';
export { LiveRegion, VisuallyHidden } from './live-region';
