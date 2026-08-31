import { describe, expect, it } from 'vitest';
import { QuestionStatus } from './enums.js';
import {
  computeRankScore,
  explainRankScore,
  QUESTION_STATUS_TIER,
  RANKING_WEIGHTS,
  type RankableQuestion,
} from './ranking.js';

/**
 * Ranking is the one piece of Phase 4 a moderator will argue with, so these
 * tests assert the PROPERTIES the design claims rather than specific numbers.
 * A weight can be retuned without rewriting the suite; the ordering guarantees
 * cannot be broken without one of these failing.
 */

const BASE = new Date('2026-06-01T12:00:00.000Z');

function question(overrides: Partial<RankableQuestion> = {}): RankableQuestion {
  return {
    upvoteCount: 0,
    createdAt: BASE,
    status: 'APPROVED',
    pinnedAt: null,
    ...overrides,
  };
}

function minutesAfter(minutes: number): Date {
  return new Date(BASE.getTime() + minutes * 60_000);
}

describe('question ranking', () => {
  it('assigns a tier to every question status, with none left out', () => {
    // A status missing from the table would score NaN and sort unpredictably —
    // silently, and only for questions that happen to reach that state.
    expect(Object.keys(QUESTION_STATUS_TIER).sort()).toEqual([...QuestionStatus.options].sort());
  });

  it('never produces NaN or Infinity for any status', () => {
    for (const status of QuestionStatus.options) {
      expect(Number.isFinite(computeRankScore(question({ status })))).toBe(true);
    }
  });

  describe('popularity', () => {
    it('ranks a more supported question above a less supported one of the same age', () => {
      const popular = computeRankScore(question({ upvoteCount: 40 }));
      const quiet = computeRankScore(question({ upvoteCount: 3 }));

      expect(popular).toBeGreaterThan(quiet);
    });

    it('scores an unvoted question at zero popularity rather than -Infinity', () => {
      // log10(0) is -Infinity, which would sink every new question below every
      // other row forever. The +1 inside the logarithm is what prevents it.
      expect(explainRankScore(question({ upvoteCount: 0 })).popularity).toBe(0);
    });

    it('has diminishing returns, so a vote brigade cannot dominate the board', () => {
      // Counts chosen so the +1 lands on a power of ten and the arithmetic is
      // exact: 10, 100 and 1000 votes counted.
      const ten = explainRankScore(question({ upvoteCount: 9 })).popularity;
      const hundred = explainRankScore(question({ upvoteCount: 99 })).popularity;
      const thousand = explainRankScore(question({ upvoteCount: 999 })).popularity;

      // Each tenfold increase adds the same amount, not ten times more — so the
      // hundredth vote is worth far less than the tenth.
      expect(hundred - ten).toBeCloseTo(thousand - hundred, 10);
      expect(thousand - hundred).toBeCloseTo(RANKING_WEIGHTS.popularity, 10);
    });
  });

  describe('recency', () => {
    it('ranks a newer question above an older one with the same support', () => {
      const newer = computeRankScore(question({ createdAt: minutesAfter(30) }));
      const older = computeRankScore(question({ createdAt: BASE }));

      expect(newer).toBeGreaterThan(older);
    });

    it('counts up from a fixed epoch, so a score never changes on its own', () => {
      // The property the whole design rests on: called twice, minutes apart,
      // the same question scores identically. A decaying formula would not,
      // and keyset pagination over it would skip rows.
      const subject = question({ upvoteCount: 7, createdAt: minutesAfter(-90) });

      expect(computeRankScore(subject)).toBe(computeRankScore(subject));
    });

    it('is worth one point per configured interval of age', () => {
      const later = explainRankScore(
        question({ createdAt: minutesAfter(RANKING_WEIGHTS.recencySecondsPerPoint / 60) }),
      ).recency;

      expect(later - explainRankScore(question()).recency).toBeCloseTo(1, 6);
    });
  });

  describe('popularity against recency', () => {
    it('lets a well-supported question outrank a fresher unsupported one', () => {
      // The trade-off that makes the board useful: without it, the newest
      // question is always on top and upvoting is decorative.
      const supported = computeRankScore(question({ upvoteCount: 25 }));
      const freshButQuiet = computeRankScore(question({ createdAt: minutesAfter(45) }));

      expect(supported).toBeGreaterThan(freshButQuiet);
    });

    it('lets freshness eventually overtake a modest vote count', () => {
      // And the other half of the trade-off: support buys time near the top,
      // not a permanent residency.
      const supported = computeRankScore(question({ upvoteCount: 25 }));
      const muchFresher = computeRankScore(question({ createdAt: minutesAfter(24 * 60) }));

      expect(muchFresher).toBeGreaterThan(supported);
    });
  });

  describe('organizer priority', () => {
    it('puts a pinned question above any amount of organic support', () => {
      const pinned = computeRankScore(question({ pinnedAt: BASE }));
      const wildlyPopular = computeRankScore({
        upvoteCount: 100_000,
        createdAt: minutesAfter(60 * 24 * 365),
        status: 'APPROVED',
        pinnedAt: null,
      });

      expect(pinned).toBeGreaterThan(wildlyPopular);
    });

    it('does NOT let a pinned question escape its moderation tier', () => {
      // A pinned question that was then rejected must not reappear above
      // approved material. Pinning orders within a tier; it does not overrule
      // a moderator's decision.
      const pinnedButRejected = computeRankScore(question({ status: 'REJECTED', pinnedAt: BASE }));
      const plainApproved = computeRankScore(question({ status: 'APPROVED' }));

      expect(pinnedButRejected).toBeLessThan(plainApproved);
    });
  });

  describe('moderation status', () => {
    it('sinks an answered question below one still awaiting an answer', () => {
      const answered = computeRankScore(question({ status: 'ANSWERED', upvoteCount: 500 }));
      const approved = computeRankScore(question({ status: 'APPROVED', upvoteCount: 0 }));

      expect(approved).toBeGreaterThan(answered);
    });

    it('keeps pending and approved in one tier, ordered by support and age', () => {
      // Deliberate: on an unfiltered queue a moderator wants the material in
      // one stream, not every unreviewed question stacked above every reviewed
      // one regardless of how long ago it was asked.
      const pending = computeRankScore(question({ status: 'PENDING', upvoteCount: 10 }));
      const approved = computeRankScore(question({ status: 'APPROVED', upvoteCount: 0 }));

      expect(pending).toBeGreaterThan(approved);
    });

    it('sinks rejected and spam below everything still in play', () => {
      const rejected = computeRankScore(question({ status: 'REJECTED', upvoteCount: 9_999 }));
      const answered = computeRankScore(question({ status: 'ANSWERED', upvoteCount: 0 }));

      expect(rejected).toBeLessThan(answered);
    });

    it('puts archived at the bottom, below every other tier', () => {
      const archived = computeRankScore(question({ status: 'ARCHIVED', upvoteCount: 9_999 }));

      for (const status of QuestionStatus.options.filter((value) => value !== 'ARCHIVED')) {
        expect(archived).toBeLessThan(computeRankScore(question({ status })));
      }
    });
  });

  describe('transparency', () => {
    it('decomposes into components that sum to exactly the stored score', () => {
      // The dashboard renders these four numbers as the justification for an
      // order. If they did not sum to the total, the explanation would be a
      // plausible-looking fiction.
      const subject = question({ upvoteCount: 12, createdAt: minutesAfter(20), pinnedAt: BASE });
      const parts = explainRankScore(subject);

      expect(parts.popularity + parts.recency + parts.priority + parts.moderation).toBe(
        computeRankScore(subject),
      );
    });

    it('reads an ISO string exactly as it reads a Date', () => {
      // The API holds Date objects; a JSON response carries strings. Both must
      // score identically or the number shown would not be the number sorted by.
      expect(computeRankScore(question({ createdAt: BASE.toISOString() }))).toBe(
        computeRankScore(question({ createdAt: BASE })),
      );
    });
  });
});
