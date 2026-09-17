import type { AiUsage } from './ai-provider.port';

/**
 * Money, in micro-dollars: 1_000_000 = $1.00.
 *
 * Integers throughout. A budget enforced with floating-point arithmetic can
 * be off by a rounding error in either direction, and "the cap is $2.00 give
 * or take" is not a cap.
 */

/** Per-million-token prices, first-party Claude API rates, cached 2026-06. */
interface ModelPrice {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  /** Prompt-cache reads are billed at a discount; 0.1× is the common rate. */
  cachedReadMicrosPerMillion: number;
}

const PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  'claude-haiku-4-5': {
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 5_000_000,
    cachedReadMicrosPerMillion: 100_000,
  },
  'claude-sonnet-5': {
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 10_000_000,
    cachedReadMicrosPerMillion: 200_000,
  },
  'claude-sonnet-4-6': {
    inputMicrosPerMillion: 3_000_000,
    outputMicrosPerMillion: 15_000_000,
    cachedReadMicrosPerMillion: 300_000,
  },
  'claude-opus-5': {
    inputMicrosPerMillion: 5_000_000,
    outputMicrosPerMillion: 25_000_000,
    cachedReadMicrosPerMillion: 500_000,
  },
});

/**
 * An unknown model is priced as the MOST expensive one we know.
 *
 * This is the safe direction for a budget check: a misconfigured model id
 * over-counts toward the cap rather than sneaking under it. It is also
 * loud — the status endpoint shows the model name, and an organizer seeing
 * Opus prices for a Haiku call will ask.
 */
const FALLBACK_PRICE: ModelPrice = PRICES['claude-opus-5']!;

export function priceFor(modelId: string): ModelPrice {
  return PRICES[modelId] ?? FALLBACK_PRICE;
}

/** Cost of a call from its reported token usage. */
export function costMicros(modelId: string, usage: AiUsage): number {
  const price = priceFor(modelId);
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedReadTokens);

  return Math.ceil(
    (uncachedInput * price.inputMicrosPerMillion +
      usage.cachedReadTokens * price.cachedReadMicrosPerMillion +
      usage.outputTokens * price.outputMicrosPerMillion) /
      1_000_000,
  );
}

/**
 * Rough token count from text length, for the BEFORE-dispatch check.
 *
 * ~3.5 characters per token is conservative for English prose (the real
 * figure is nearer 4), so the estimate errs high. This is only used to decide
 * whether a call may start; the ledger is corrected to the provider's own
 * count once the answer is back.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * The worst case a call could cost: the whole input plus the whole output
 * allowance, none of it cached. If even THIS fits under the cap, the real
 * cost certainly will.
 */
export function estimateWorstCaseMicros(
  modelId: string,
  inputText: string,
  maxOutputTokens: number,
): number {
  return costMicros(modelId, {
    inputTokens: estimateTokens(inputText),
    outputTokens: maxOutputTokens,
    cachedReadTokens: 0,
  });
}
