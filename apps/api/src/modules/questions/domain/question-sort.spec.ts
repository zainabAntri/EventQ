import { describe, expect, it } from 'vitest';
import { QuestionSort } from '@eventq/contracts';
import {
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  sortDefinition,
  type SortableRow,
} from './question-sort';

/**
 * Cursor bugs are the quiet kind: nothing throws, a page simply comes back from
 * the wrong place and a moderator never learns that four questions between page
 * one and page two were never shown to them. These tests exist to make that
 * class of failure loud.
 */

const ROW: SortableRow = {
  id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  rankScore: 1_234.567_890_123,
  createdAt: new Date('2026-06-01T12:34:56.789Z'),
  upvoteCount: 42,
};

describe('question sort definitions', () => {
  it('defines an order for every sort the contract offers', () => {
    // A missing entry would be `undefined` at the query site and order by
    // nothing at all — a stable-looking list in a random order.
    for (const sort of QuestionSort.options) {
      expect(sortDefinition(sort)).toMatchObject({
        column: expect.any(String),
        direction: expect.stringMatching(/^(asc|desc)$/),
      });
    }
  });

  it('reads oldest-first as the exact reverse of newest-first', () => {
    expect(sortDefinition('oldest').column).toBe(sortDefinition('newest').column);
    expect(sortDefinition('oldest').direction).not.toBe(sortDefinition('newest').direction);
  });
});

describe('cursor round trip', () => {
  it('preserves a floating-point rank score exactly', () => {
    // Approximately-equal is not good enough: the keyset predicate compares for
    // equality to break ties, so a score that comes back rounded matches no row
    // and the tied questions at the page boundary are dropped.
    const decoded = decodeCursor(encodeCursor('rank', ROW), 'rank');

    expect(decoded.value).toBe(ROW.rankScore);
    expect(decoded.id).toBe(ROW.id);
  });

  it('preserves a timestamp to the millisecond', () => {
    // Prisma stores DateTime as timestamp(3), so a millisecond is the full
    // stored precision and nothing is lost in either direction.
    const decoded = decodeCursor(encodeCursor('newest', ROW), 'newest');

    expect(decoded.value).toBeInstanceOf(Date);
    expect((decoded.value as Date).toISOString()).toBe(ROW.createdAt.toISOString());
  });

  it('preserves a vote count', () => {
    expect(decodeCursor(encodeCursor('votes', ROW), 'votes').value).toBe(ROW.upvoteCount);
  });

  it('produces a url-safe token needing no escaping in a query string', () => {
    const cursor = encodeCursor('rank', ROW);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });
});

describe('cursor rejection', () => {
  it('refuses a cursor minted for a different sort', () => {
    // The important one. A rank cursor replayed against a vote sort would
    // compare a score of 1234.56 against a vote count and silently return a
    // page from nowhere in particular.
    expect(() => decodeCursor(encodeCursor('rank', ROW), 'votes')).toThrow(InvalidCursorError);
  });

  it('refuses text that is not a cursor at all', () => {
    expect(() => decodeCursor('not-a-cursor', 'rank')).toThrow(InvalidCursorError);
  });

  it('refuses valid base64 that does not decode to a cursor object', () => {
    const notAnObject = Buffer.from('"just a string"', 'utf8').toString('base64url');

    expect(() => decodeCursor(notAnObject, 'rank')).toThrow(InvalidCursorError);
  });

  it('refuses a cursor with no id, rather than paginating without a tiebreak', () => {
    const noId = Buffer.from(JSON.stringify({ s: 'rank', v: 1 }), 'utf8').toString('base64url');

    expect(() => decodeCursor(noId, 'rank')).toThrow(InvalidCursorError);
  });

  it('refuses an unparseable timestamp instead of comparing against NaN', () => {
    // NaN compares false against everything, so the query would succeed and
    // return an empty page — indistinguishable from having reached the end.
    const bad = Buffer.from(JSON.stringify({ s: 'newest', v: 'yesterday', i: ROW.id })).toString(
      'base64url',
    );

    expect(() => decodeCursor(bad, 'newest')).toThrow(InvalidCursorError);
  });

  it('refuses a numeric overflow that JSON silently parses as Infinity', () => {
    // `1e999` is legal JSON and parses to Infinity, which is greater than every
    // stored score and would pin the queue permanently empty.
    const overflow = Buffer.from(`{"s":"rank","v":1e999,"i":"${ROW.id}"}`, 'utf8').toString(
      'base64url',
    );

    expect(() => decodeCursor(overflow, 'rank')).toThrow(InvalidCursorError);
  });

  it('reports a cursor failure as a client validation error, not a server fault', () => {
    // A tampered cursor is a 400. Letting it surface as a 500 would turn a
    // trivially forgeable input into a way to fill the error budget.
    try {
      decodeCursor('!!!not base64!!!', 'rank');
      expect.unreachable('decodeCursor should have thrown');
    } catch (caught) {
      expect(caught).toBeInstanceOf(InvalidCursorError);
      expect((caught as InvalidCursorError).status).toBe(400);
      expect((caught as InvalidCursorError).code).toBe('VALIDATION_FAILED');
    }
  });
});
