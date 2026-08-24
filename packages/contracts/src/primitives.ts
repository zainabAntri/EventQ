import { z } from 'zod';

/** Every entity id is a UUID v7 — time-sortable, so it indexes well as a PK. */
export const EntityId = z.uuid();
export type EntityId = z.infer<typeof EntityId>;

/**
 * Crockford base32 alphabet: no I, L, O or U.
 *
 * Chosen because join codes get read aloud across a noisy room ("go to
 * eventq.io and enter H4K2..."). Excluding ambiguous characters removes the
 * 1/I/L and 0/O confusions, and U is excluded to avoid accidental profanity.
 */
export const JOIN_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 8;

export const JoinCode = z
  .string()
  .trim()
  .toUpperCase()
  .length(JOIN_CODE_LENGTH)
  .regex(new RegExp(`^[${JOIN_CODE_ALPHABET}]+$`), {
    error: 'Join code contains characters that are not part of the code alphabet.',
  });
export type JoinCode = z.infer<typeof JoinCode>;

export const Email = z.email().toLowerCase().max(320);
export type Email = z.infer<typeof Email>;

/**
 * Cursor pagination.
 *
 * Offset pagination is wrong for this product: the question list mutates while
 * an attendee is reading it, so page 2 of an offset query silently skips or
 * repeats rows. A cursor is stable against inserts.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const CursorPaginationQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type CursorPaginationQuery = z.infer<typeof CursorPaginationQuery>;

/** Builds a typed page envelope for any item schema. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    /** Cursor for the next page, or null when this is the last page. */
    nextCursor: z.string().nullable(),
    /** True when another page exists. Cheaper for clients than comparing counts. */
    hasMore: z.boolean(),
  });
}

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};
