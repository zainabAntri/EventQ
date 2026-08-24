import { describe, expect, it } from 'vitest';
import { Email, JOIN_CODE_ALPHABET, JoinCode, pageOf } from './primitives.js';
import { z } from 'zod';

describe('JoinCode', () => {
  it('accepts a valid code and normalises case and whitespace', () => {
    // Someone typing a code read aloud will not match the case on the screen,
    // and will often paste it with surrounding whitespace.
    expect(JoinCode.parse('eventq26')).toBe('EVENTQ26');
    expect(JoinCode.parse('  EVENTQ26  ')).toBe('EVENTQ26');
  });

  it('rejects a code containing an excluded letter even though it looks valid', () => {
    // Regression guard: "DEMO2026" reads as a perfectly reasonable demo code
    // and is invalid, because O is not in the alphabet. The seed used it until
    // this test caught the mismatch.
    expect(JoinCode.safeParse('DEMO2026').success).toBe(false);
  });

  it('excludes characters that are ambiguous when read aloud', () => {
    // I/L (vs 1), O (vs 0) and U (accidental profanity) are excluded on
    // purpose — codes get shouted across a noisy room.
    for (const character of ['I', 'L', 'O', 'U']) {
      expect(JOIN_CODE_ALPHABET).not.toContain(character);
    }
  });

  it('rejects codes containing an excluded character', () => {
    expect(JoinCode.safeParse('EVENTQI6').success).toBe(false);
    expect(JoinCode.safeParse('EVENTQO6').success).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(JoinCode.safeParse('EVENTQ2').success).toBe(false);
    expect(JoinCode.safeParse('EVENTQ266').success).toBe(false);
  });

  it('rejects punctuation and whitespace inside the code', () => {
    expect(JoinCode.safeParse('EVENT-26').success).toBe(false);
    expect(JoinCode.safeParse('EVENT 26').success).toBe(false);
  });
});

describe('Email', () => {
  it('lowercases so the same address cannot register twice', () => {
    expect(Email.parse('Owner@EventQ.LOCAL')).toBe('owner@eventq.local');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['not-an-email', 'missing@tld', '@nolocal.com', 'spaces in@example.com']) {
      expect(Email.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('pageOf', () => {
  const Page = pageOf(z.object({ id: z.string() }));

  it('describes a page with an explicit hasMore rather than a total', () => {
    // Cursor pagination, because the question list mutates while it is being
    // read — offset paging would skip or repeat rows.
    const parsed = Page.parse({
      items: [{ id: 'a' }],
      nextCursor: 'cursor-1',
      hasMore: true,
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.hasMore).toBe(true);
  });

  it('allows a null cursor on the last page', () => {
    expect(Page.parse({ items: [], nextCursor: null, hasMore: false }).nextCursor).toBeNull();
  });

  it('rejects a page missing its pagination fields', () => {
    expect(Page.safeParse({ items: [] }).success).toBe(false);
  });
});
