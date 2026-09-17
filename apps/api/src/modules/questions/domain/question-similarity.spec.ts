import { describe, expect, it } from 'vitest';
import { normalizeForComparison } from './question-text';
import {
  contentTerms,
  DUPLICATE_SUGGESTION_THRESHOLD,
  findBestDuplicate,
  termSimilarity,
  type SimilarityCandidate,
} from './question-similarity';

/**
 * These tests pin the detector to specific sentences on purpose. The threshold
 * and the stopword list are judgement calls, and the only honest way to change
 * either is to see exactly which real pairs start or stop matching.
 */

const terms = (text: string) => contentTerms(normalizeForComparison(text));
const similarity = (a: string, b: string) => termSimilarity(terms(a), terms(b));

/** A candidate as the repository would hand it over, with a trigram score. */
function candidate(id: string, text: string, trigramSimilarity: number): SimilarityCandidate {
  return { id, normalizedBody: normalizeForComparison(text), trigramSimilarity };
}

describe('content terms', () => {
  it('keeps the words that carry topic and drops the ones that do not', () => {
    // "how", "can", "i", "in", "my" say nothing about what is being asked.
    expect(terms('How can I use AI in my company?')).toEqual(new Set(['use', 'ai', 'company']));
  });

  it('folds simple plurals so "businesses" and "business" compare equal', () => {
    expect(terms('businesses')).toEqual(new Set(['business']));
    expect(terms('companies')).toEqual(new Set(['company']));
    expect(terms('questions')).toEqual(new Set(['question']));
  });

  it('leaves short words alone rather than mangling them', () => {
    // "was" -> "wa" is the kind of damage that makes a stemmer worse than none.
    expect(terms('bus gas')).toEqual(new Set(['bus', 'gas']));
  });

  it('is empty for a question made only of filler', () => {
    expect(terms('What about this?')).toEqual(new Set());
  });
});

describe('term similarity', () => {
  it('scores the reworded pair from the requirements above the threshold', () => {
    // The pair trigrams miss: little shared spelling, the same underlying
    // question. {use, ai, company} vs {business, use, ai} -> 2·2 / (3+3).
    const score = similarity('How can I use AI in my company?', 'How can businesses use AI?');

    expect(score).toBeCloseTo(0.67, 2);
    expect(score).toBeGreaterThanOrEqual(DUPLICATE_SUGGESTION_THRESHOLD);
  });

  it('scores an unrelated question at zero', () => {
    expect(similarity('How can I use AI in my company?', 'What time is lunch served today?')).toBe(
      0,
    );
  });

  it('scores identical content at one regardless of filler and order', () => {
    expect(
      similarity('Should we hire a data scientist first?', 'A data scientist: hire first?'),
    ).toBe(1);
  });

  it('reports nothing-to-compare as 0, never as a perfect match', () => {
    // Two questions with no content words share an EMPTY set. An empty match
    // must not count as a match, or every vague question would be a duplicate
    // of every other vague question.
    expect(similarity('What about this?', 'And that one?')).toBe(0);
  });
});

describe('finding the best duplicate', () => {
  const asked = normalizeForComparison('How can I use AI in my company?');

  it('suggests the reworded question that trigrams alone would have missed', () => {
    const match = findBestDuplicate(asked, [
      candidate('q-business', 'How can businesses use AI?', 0.31),
      candidate('q-lunch', 'What time is lunch served today?', 0.05),
    ]);

    expect(match?.id).toBe('q-business');
    expect(match?.similarity).toBeCloseTo(0.67, 2);
  });

  it('still lets a near-verbatim repeat win on its trigram score', () => {
    // Character trigrams catch typos and punctuation that word overlap can miss
    // — "AI" against "A.I" is one term against another to this module, but
    // almost identical spelling to pg_trgm. The max of the two keeps both.
    const match = findBestDuplicate(asked, [
      candidate('q-verbatim', 'how can i use a i in my company', 0.82),
      candidate('q-business', 'How can businesses use AI?', 0.31),
    ]);

    expect(match?.id).toBe('q-verbatim');
    expect(match?.similarity).toBe(0.82);
  });

  it('returns null when nothing clears the threshold', () => {
    expect(
      findBestDuplicate(asked, [
        candidate('q-lunch', 'What time is lunch served today?', 0.05),
        candidate('q-parking', 'Is there parking at the venue?', 0.1),
      ]),
    ).toBeNull();
  });

  it('returns null with no candidates at all', () => {
    expect(findBestDuplicate(asked, [])).toBeNull();
  });

  /**
   * The documented false positive.
   *
   * Word overlap cannot tell that swapping "AI" for "Excel" changes the topic
   * entirely. This test exists to keep that limitation VISIBLE: it asserts the
   * detector does suggest the pair — so nobody is surprised in production —
   * and the integration suite asserts that a suggestion never deletes, hides
   * or merges anything on its own. A human decides. That boundary is the whole
   * reason the output of this module is called a suggestion.
   */
  it('KNOWN LIMITATION: suggests a pair that differs by one key noun', () => {
    const match = findBestDuplicate(asked, [
      candidate('q-excel', 'How can I use Excel in my company?', 0.7),
    ]);

    expect(match?.id).toBe('q-excel');
    // Both measures agree it looks similar; neither can see that it is not.
    expect(match?.similarity).toBeGreaterThanOrEqual(DUPLICATE_SUGGESTION_THRESHOLD);
  });
});
