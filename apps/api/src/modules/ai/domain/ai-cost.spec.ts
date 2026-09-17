import { describe, expect, it } from 'vitest';
import { costMicros, estimateTokens, estimateWorstCaseMicros, priceFor } from './ai-cost';

describe('AI cost arithmetic', () => {
  it('prices a Haiku call from its token usage, in whole micro-dollars', () => {
    // 1000 in at $1/M = 1000µ$; 200 out at $5/M = 1000µ$.
    expect(
      costMicros('claude-haiku-4-5', {
        inputTokens: 1_000,
        outputTokens: 200,
        cachedReadTokens: 0,
      }),
    ).toBe(2_000);
  });

  it('charges cached input at the discounted rate', () => {
    const uncached = costMicros('claude-sonnet-5', {
      inputTokens: 10_000,
      outputTokens: 0,
      cachedReadTokens: 0,
    });
    const cached = costMicros('claude-sonnet-5', {
      inputTokens: 10_000,
      outputTokens: 0,
      cachedReadTokens: 10_000,
    });

    expect(cached).toBeLessThan(uncached);
    expect(cached).toBe(2_000); // 10k × $0.20/M
  });

  it('rounds UP, so a fraction of a micro-dollar is never billed as zero', () => {
    expect(
      costMicros('claude-haiku-4-5', { inputTokens: 1, outputTokens: 0, cachedReadTokens: 0 }),
    ).toBe(1);
  });

  it('prices an unknown model as the most expensive known one', () => {
    // The safe direction for a budget: a typo in AI_MODEL_CLASSIFY over-counts
    // toward the cap rather than sneaking under it.
    expect(priceFor('claude-made-up-9')).toEqual(priceFor('claude-opus-5'));
  });

  it('estimates tokens conservatively from text length', () => {
    // ~3.5 chars/token errs high against the real ~4, on purpose.
    expect(estimateTokens('a'.repeat(350))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });

  it('worst case assumes the whole output allowance and no cache', () => {
    const worst = estimateWorstCaseMicros('claude-haiku-4-5', 'a'.repeat(3_500), 2_000);

    // 1000 in + 2000 out on Haiku = 1000 + 10000 µ$.
    expect(worst).toBe(11_000);
  });
});
