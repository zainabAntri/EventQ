import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import type { FieldError } from '@eventq/contracts';
import { ValidationError } from '../errors/domain-error';

/**
 * Metadata key holding the zod schema attached by the @ZodSchema decorator.
 */
export const ZOD_SCHEMA_KEY = 'eventq:zod-schema';

/**
 * Global validation pipe.
 *
 * Validates every request payload against the zod schema declared for that
 * parameter, and converts a failure into a ValidationError — which the existing
 * global exception filter already renders as RFC 9457 problem+json with a
 * populated `errors[]` array. Validation and error formatting therefore share
 * one path with the rest of the system rather than being a special case.
 *
 * Deliberately hand-rolled rather than pulling in `nestjs-zod`: this is ~40
 * lines, and a third-party bridge straddling two fast-moving libraries is a
 * fragile dependency to own for that.
 *
 * A parameter with no schema passes through untouched, so controllers opt in
 * explicitly and nothing is silently coerced.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = resolveSchema(metadata);
    if (!schema) return value;

    const result = schema.safeParse(value);
    if (result.success) {
      // Returns the PARSED value, not the input: defaults are applied, strings
      // are coerced and unknown keys are stripped, so handlers downstream can
      // trust the shape completely.
      return result.data;
    }

    throw new ValidationError('The request payload failed validation.', {
      fieldErrors: toFieldErrors(result.error),
      context: { source: metadata.type },
    });
  }
}

function resolveSchema(metadata: ArgumentMetadata): ZodType | undefined {
  // metatype is Nest's `Type<any> | undefined`, which does not overlap with our
  // static-carrying shape, so it goes through `unknown` rather than being
  // force-cast. The runtime guard below is what actually establishes the type.
  const target = metadata.metatype as unknown as Record<typeof ZOD_SCHEMA_KEY, unknown> | undefined;

  const schema = target?.[ZOD_SCHEMA_KEY];
  return isZodType(schema) ? schema : undefined;
}

function isZodType(value: unknown): value is ZodType {
  // Duck-typed rather than `instanceof`: two copies of zod in a pnpm tree would
  // fail an instanceof check and silently disable validation, which is exactly
  // the kind of failure that must not be silent.
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function'
  );
}

function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    // Bracket notation for array indices so the path is unambiguous for a
    // client mapping errors back onto form fields.
    path: issue.path.reduce<string>((acc, segment) => {
      if (typeof segment === 'number') return `${acc}[${segment}]`;
      return acc === '' ? String(segment) : `${acc}.${String(segment)}`;
    }, ''),
    message: issue.message,
    code: issue.code,
  }));
}
