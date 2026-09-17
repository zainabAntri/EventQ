import type { AiFeature } from '@eventq/contracts';

/**
 * The bounds every AI call lives inside.
 *
 * These are the "token/input limits" and "maximum question length" of the
 * cost-control requirement, made into numbers with a reason each. None of
 * them is configurable per event on purpose: a limit an organizer can raise
 * from a dashboard is a limit that will be raised at the wrong moment.
 */
export const AI_LIMITS = Object.freeze({
  /**
   * Characters of a question body that reach the model.
   *
   * The default maximum question length is 500 and organizers rarely raise
   * it; 600 covers that with room, and cuts off the rare wall of text before
   * it becomes a wall of tokens. A truncated question is marked as such in
   * the prompt so the model does not treat the cut as the end of a sentence.
   */
  maxQuestionChars: 600,

  /** Event title and description are organizer-authored; bounded anyway. */
  maxEventContextChars: 1_500,

  /**
   * Questions per call, by feature.
   *
   * Categorisation is cheap per question and benefits from small batches
   * (a model asked to label fifty things is more accurate than one asked to
   * label five hundred). Clustering and summarising need to see the whole
   * event to be useful, so their cap is the event size this product is
   * specified for, and the input cap below is the backstop.
   */
  maxQuestionsPerCall: Object.freeze({
    CLASSIFICATION: 50,
    DEDUPLICATION: 20,
    CLUSTERING: 200,
    ANSWER_SUGGESTION: 1,
    SUMMARIZATION: 200,
  }) satisfies Readonly<Record<AiFeature, number>>,

  /** Total characters of input across everything, whatever the count above says. */
  maxInputChars: 80_000,

  /**
   * Output allowances. Each is sized to the shape it must fill and no more:
   * the cost of an oversized allowance is only paid if the model uses it, but
   * the budget check counts it in full, so an inflated number shrinks what
   * an event can do for no benefit.
   */
  maxOutputTokens: Object.freeze({
    CLASSIFICATION: 2_000,
    DEDUPLICATION: 400,
    CLUSTERING: 4_000,
    ANSWER_SUGGESTION: 1_200,
    SUMMARIZATION: 4_000,
  }) satisfies Readonly<Record<AiFeature, number>>,

  /**
   * Wall-clock limit per attempt. Runs inside the request, so this is also
   * how long an organizer's click can spin. A timeout is NOT retried.
   */
  timeoutMs: 45_000,

  /**
   * Attempts per call, including the first. Two, not three: one retry
   * absorbs a transient rate limit or a brief overload, and anything that
   * fails twice in a row is an outage the organizer should hear about rather
   * than a queue of silent re-bills. This is the only retry loop in the AI
   * path and it cannot exceed this number.
   */
  maxAttempts: 2,

  /** Pause before the single retry. Short: the organizer is waiting. */
  retryDelayMs: 1_500,

  /**
   * How long a cached result is reused. A day covers an event and its
   * aftermath; asking the same question of the same text twice inside that
   * window costs nothing.
   */
  cacheTtlSeconds: 24 * 60 * 60,

  /** How long the per-event, per-feature lock is held if the holder crashes. */
  lockTtlSeconds: 120,
});

/**
 * Bumped whenever a prompt's wording or a schema changes.
 *
 * Part of the cache key and stored on every result. Two purposes: a changed
 * prompt must not be served an answer produced by the old one, and a stored
 * result must be traceable to the exact instructions that produced it, so a
 * regression can be rolled back rather than guessed at.
 */
export const PROMPT_VERSION = '2026-09-18.1';
