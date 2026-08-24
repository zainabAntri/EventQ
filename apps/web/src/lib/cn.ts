import { cx } from 'class-variance-authority';
import type { ClassValue } from 'class-variance-authority/types';

/**
 * Conditional class name joiner.
 *
 * Re-exported from `cva` rather than adding `clsx` + `tailwind-merge`: those
 * two solve a conflict-resolution problem we do not have yet, because variants
 * here are defined once in `cva` rather than being overridden ad hoc at call
 * sites. Revisit if genuine class conflicts start appearing.
 */
export function cn(...inputs: ClassValue[]): string {
  return cx(inputs);
}
