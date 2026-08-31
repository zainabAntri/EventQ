import type { QuestionSort } from '@eventq/contracts';
import { ValidationError } from '../../../shared/errors/domain-error';

/**
 * Sort orders and the cursors that paginate them.
 *
 * Pure functions over plain data — no database, no clock, no framework — so the
 * pagination arithmetic is testable in microseconds rather than only observable
 * through a live queue.
 *
 * ---------------------------------------------------------------------------
 * Why the cursor carries a VALUE and not just an id
 * ---------------------------------------------------------------------------
 *
 * Phase 3 paginated with Prisma's `cursor: { id }`, and that was correct there:
 * the only order was `createdAt DESC`, and ids are UUID v7 — time-sortable — so
 * "everything after this id" and "everything older than this row" were the same
 * set.
 *
 * That equivalence breaks the moment the dashboard can sort by rank or by
 * votes. Ordered by upvoteCount, the row after id X in the result is not the
 * row after X in id order, and Prisma's id cursor would silently return a page
 * from the wrong place — no error, just questions a moderator never sees.
 *
 * So a cursor here carries the SORT COLUMN'S VALUE from the last row of the
 * previous page, plus the id as a tiebreak, and the query resumes with a keyset
 * predicate on the pair. Both columns round-trip exactly through JSON — Prisma
 * stores DateTime as timestamp(3) and rankScore as double precision — so the
 * value that comes back is bit-identical to the one that went out, and no row
 * can fall between two pages.
 *
 * ---------------------------------------------------------------------------
 * A cursor is opaque, NOT trusted
 * ---------------------------------------------------------------------------
 *
 * It is base64url, which discourages tampering but does not prevent it, and it
 * is deliberately not signed. It does not have to be: every query it feeds is
 * already scoped to the caller's organization by the repository, so the worst a
 * forged cursor achieves is a different window over rows the caller may already
 * read. Signing it would add key management to protect nothing.
 *
 * What IS enforced is that the cursor was minted for the sort it is being
 * replayed against — otherwise a cursor holding a rankScore would be compared
 * against a vote count, and the page boundary would land somewhere arbitrary.
 */

export type SortColumn = 'rankScore' | 'createdAt' | 'upvoteCount';
export type SortDirection = 'asc' | 'desc';

export interface SortDefinition {
  readonly column: SortColumn;
  readonly direction: SortDirection;
}

/**
 * Every sort is (column, id) so the order is TOTAL.
 *
 * The id tiebreak is not decoration. Two questions can share a rank score, a
 * vote count or — during a burst of submissions — a millisecond, and Postgres
 * is free to return tied rows in any order it likes, differently on each call.
 * A page boundary landing inside a tie would then repeat or drop rows. The
 * tiebreak runs in the same direction as the column so that one keyset
 * comparison covers both.
 */
const SORTS: Readonly<Record<QuestionSort, SortDefinition>> = Object.freeze({
  rank: { column: 'rankScore', direction: 'desc' },
  newest: { column: 'createdAt', direction: 'desc' },
  oldest: { column: 'createdAt', direction: 'asc' },
  votes: { column: 'upvoteCount', direction: 'desc' },
});

export function sortDefinition(sort: QuestionSort): SortDefinition {
  return SORTS[sort];
}

/** The columns a cursor may be built from, on a row of any shape. */
export interface SortableRow {
  id: string;
  rankScore: number;
  createdAt: Date;
  upvoteCount: number;
}

export interface QuestionCursor {
  /** The sort this cursor was minted for. Replaying it under another is refused. */
  sort: QuestionSort;
  /** The sort column's value on the last row of the previous page. */
  value: number | Date;
  id: string;
}

/** A malformed, truncated or mismatched cursor. Always the client's mistake. */
export class InvalidCursorError extends ValidationError {
  constructor(reason: string) {
    super('That page cursor is not valid. Start from the first page.', {
      fieldErrors: [{ path: 'cursor', message: 'Invalid or expired page cursor.' }],
      context: { reason },
    });
  }
}

export function encodeCursor(sort: QuestionSort, row: SortableRow): string {
  const { column } = SORTS[sort];
  const value = column === 'createdAt' ? row.createdAt.toISOString() : row[column];

  // base64url rather than base64: a cursor travels in a query string, and `+`
  // and `/` would need escaping that some clients get wrong.
  return Buffer.from(JSON.stringify({ s: sort, v: value, i: row.id }), 'utf8').toString(
    'base64url',
  );
}

/**
 * Reads a cursor back, refusing anything it cannot fully account for.
 *
 * Every failure below is one error: a client cannot learn anything from which
 * check rejected it, and the only useful recovery is the same either way —
 * start from the first page.
 */
export function decodeCursor(raw: string, expectedSort: QuestionSort): QuestionCursor {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('undecodable');
  }

  if (typeof parsed !== 'object' || parsed === null) throw new InvalidCursorError('not-an-object');

  const { s: sort, v: value, i: id } = parsed as { s?: unknown; v?: unknown; i?: unknown };

  if (sort !== expectedSort) throw new InvalidCursorError('sort-mismatch');
  if (typeof id !== 'string' || id.length === 0) throw new InvalidCursorError('missing-id');

  const { column } = SORTS[expectedSort];

  if (column === 'createdAt') {
    if (typeof value !== 'string') throw new InvalidCursorError('value-not-a-timestamp');

    const date = new Date(value);
    // An unparseable date yields NaN, which compares false against everything —
    // the query would return an empty page rather than an error, and a
    // moderator would conclude the queue had emptied.
    if (Number.isNaN(date.getTime())) throw new InvalidCursorError('unparseable-timestamp');

    return { sort: expectedSort, value: date, id };
  }

  // JSON has no Infinity literal, but it does not need one: `1e999` parses to
  // Infinity, which compares greater than every stored score and would hand
  // back a permanently empty page instead of an error.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidCursorError('value-not-a-finite-number');
  }

  return { sort: expectedSort, value, id };
}

/**
 * Narrows a cursor's key to the type its column holds.
 *
 * `decodeCursor` has already enforced the pairing, so these never throw in
 * practice. They exist so the query builder can use the value at its real type
 * without a cast — and a cast is exactly how a rank score would end up being
 * compared against a timestamp after someone adds a sort and forgets a branch.
 */
export function numericKey(cursor: QuestionCursor): number {
  if (typeof cursor.value !== 'number') throw new InvalidCursorError('expected-a-number');
  return cursor.value;
}

export function dateKey(cursor: QuestionCursor): Date {
  if (!(cursor.value instanceof Date)) throw new InvalidCursorError('expected-a-timestamp');
  return cursor.value;
}
