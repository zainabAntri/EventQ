import type { QuestionStatus } from './enums.js';

/**
 * Question ranking.
 *
 * Lives in the shared contract rather than in the API, for the same reason
 * ROLE_PERMISSIONS does: the server orders by this and the dashboard EXPLAINS
 * it, and a ranking a moderator cannot account for is one they stop trusting
 * the first time it surprises them. One definition means the explanation shown
 * next to a question is arithmetic on the same numbers the sort used, not a
 * second implementation that agrees until it doesn't.
 *
 * ---------------------------------------------------------------------------
 * Why the score ACCUMULATES with time instead of decaying
 * ---------------------------------------------------------------------------
 *
 * The obvious formula for a live board is a decay: votes / (age + 2)^gravity.
 * It is also the wrong one here, and the reason is pagination.
 *
 * A decaying score changes every second WITHOUT ANY WRITE. That breaks two
 * things at once: a stored column is stale the moment it is written (so it
 * needs a sweep job to recompute rows nobody touched), and keyset pagination
 * over it is unstable — the scores shift between the request for page 1 and the
 * request for page 2, so rows silently duplicate or vanish across the boundary.
 * On a moderation queue that means a moderator misses a question entirely, and
 * nothing about the UI would reveal it.
 *
 * So the recency term counts UP from a fixed epoch instead: a newer question
 * simply starts higher. The ordering that produces is identical to a decay —
 * newer outranks older, all else equal — but the score of a given question now
 * changes ONLY when a column it is computed from changes. That makes the stored
 * `rankScore` exactly correct at all times with no background job, and makes
 * (rankScore, id) a stable keyset.
 *
 * ---------------------------------------------------------------------------
 * Why the magnitudes look strange
 * ---------------------------------------------------------------------------
 *
 * The four terms are deliberately on wildly different scales, so that they form
 * strict tiers rather than trading off against each other:
 *
 *   moderation status  ±1e9   a coarse tier; nothing outranks its way out of it
 *   organizer priority  1e6   pinned sits above everything in its own tier
 *   recency            ~1e4   grows ~17,500/year from the epoch
 *   popularity          0–6   log10 of the vote count
 *
 * Only DIFFERENCES matter to an ORDER BY, and the differences that can occur
 * within one event are what the gaps are sized against. Recency separates two
 * questions by (seconds apart / 1800), so even a year-long event spreads its
 * questions across ~17,500 points — comfortably inside the 1e6 gap to the
 * pinned tier, which is itself comfortably inside the 1e9 gap between statuses.
 *
 * The absolute number is therefore meaningless on its own and is never shown as
 * one. `explainRankScore` returns the components, and that is what the UI
 * renders.
 */

/**
 * Fixed anchor for the recency term: 2026-01-01T00:00:00Z.
 *
 * A constant rather than "now" because the score must be reproducible. Deriving
 * it from the current time would make the same question score differently on
 * every call, which is precisely the staleness this design exists to avoid.
 *
 * Questions predating it score negatively on recency. That is fine — it is an
 * offset, and ordering is unaffected.
 */
export const RANKING_EPOCH_SECONDS = 1_767_225_600;

export const RANKING_WEIGHTS = Object.freeze({
  /**
   * Multiplier on log10(votes + 1).
   *
   * At 2, ten votes is worth ~2.08 points and a hundred is worth ~4.01 — so
   * every tenfold increase in support buys about an hour of freshness against
   * the recency term below. That ratio is the actual product decision here: a
   * well-supported question stays near the top for roughly an hour before newer
   * material displaces it, which is about the length of one conference session.
   */
  popularity: 2,

  /**
   * Seconds of age equivalent to one point, so 30 minutes of freshness is worth
   * one point and is outweighed by roughly five upvotes.
   */
  recencySecondsPerPoint: 1_800,

  /** Organizer priority. Large enough that a pinned question cannot be
   *  displaced by votes or freshness, small enough not to escape its status
   *  tier — a pinned rejected question must not outrank an approved one. */
  pinnedBoost: 1_000_000,

  /** Distance between adjacent moderation tiers. */
  statusTierSpan: 1_000_000_000,
});

/**
 * Coarse ordering by moderation status.
 *
 * PENDING and APPROVED deliberately share a tier. On the moderation queue the
 * list is usually filtered to one status anyway, and on an unfiltered view a
 * moderator wants the newest and most-supported material together regardless of
 * whether they have got to it yet.
 *
 * ANSWERED sinks one tier: an answered question stays visible — that is the
 * point of keeping it out of the archive — but it should not hold the top of a
 * board while unanswered questions wait below it.
 */
export const QUESTION_STATUS_TIER: Readonly<Record<QuestionStatus, number>> = Object.freeze({
  PENDING: 0,
  APPROVED: 0,
  ANSWERED: -1,
  REJECTED: -2,
  SPAM: -2,
  ARCHIVED: -3,
});

/** The columns a score is computed from. Nothing else may influence ordering. */
export interface RankableQuestion {
  upvoteCount: number;
  createdAt: Date | string;
  status: QuestionStatus;
  pinnedAt: Date | string | null;
}

/** The score, decomposed. This is what a dashboard shows to justify an order. */
export interface RankScoreBreakdown {
  /** log10 of the vote count, weighted. Rises with attendee support. */
  popularity: number;
  /** Counts up from the epoch, so newer is always higher. */
  recency: number;
  /** Non-zero only for a pinned question. */
  priority: number;
  /** The moderation tier. */
  moderation: number;
  total: number;
}

function toSeconds(value: Date | string): number {
  return (value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000;
}

/**
 * Decomposes a question's score into the four terms above.
 *
 * `computeRankScore` is this function's `total`, so the number stored in the
 * database and the number explained in the UI cannot diverge — there is only
 * one calculation.
 */
export function explainRankScore(question: RankableQuestion): RankScoreBreakdown {
  // +1 so a question with no votes scores 0 rather than -Infinity, and so the
  // first vote is worth more than the tenth. Support is most informative when
  // it is scarce.
  const popularity = RANKING_WEIGHTS.popularity * Math.log10(question.upvoteCount + 1);

  const recency =
    (toSeconds(question.createdAt) - RANKING_EPOCH_SECONDS) /
    RANKING_WEIGHTS.recencySecondsPerPoint;

  const priority = question.pinnedAt ? RANKING_WEIGHTS.pinnedBoost : 0;

  const moderation = QUESTION_STATUS_TIER[question.status] * RANKING_WEIGHTS.statusTierSpan;

  return {
    popularity,
    recency,
    priority,
    moderation,
    total: popularity + recency + priority + moderation,
  };
}

/** The value stored in `questions.rankScore` and used by every ORDER BY. */
export function computeRankScore(question: RankableQuestion): number {
  return explainRankScore(question).total;
}
