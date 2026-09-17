/**
 * Deterministic question similarity — the tier that runs BEFORE any model.
 *
 * Two questions can mean the same thing while sharing very little text:
 *
 *   "How can I use AI in my company?"
 *   "How can businesses use AI?"
 *
 * Character trigrams (pg_trgm, the Phase 3 detector) score that pair at about
 * 0.3, because trigrams reward shared SPELLING and these share little of it.
 * They are the right tool for typos and punctuation, and the wrong one for a
 * reworded sentence. This module adds a second measure that looks at the words
 * that carry meaning and ignores the rest:
 *
 *   1. drop STOPWORDS  ─ "how", "can", "i", "in", "my" say nothing about topic
 *   2. STEM lightly    ─ "businesses" → "business", so plurals compare equal
 *   3. compare the surviving CONTENT WORDS as sets with the Dice coefficient:
 *      2 × |shared| ÷ (|A| + |B|)
 *
 * The example becomes {use, ai, company} against {business, use, ai}: two of
 * three words shared on each side, Dice = 2·2 ÷ (3+3) = 0.67. Flagged.
 *
 * The final score is the MAX of the two measures — trigrams still win on a
 * near-verbatim repeat, words win on a paraphrase — and the threshold below
 * decides whether a moderator is asked to look.
 *
 * ---------------------------------------------------------------------------
 * What this cannot do, stated plainly
 * ---------------------------------------------------------------------------
 *
 * "How can I use EXCEL in my company?" scores the same 0.67 against the AI
 * question. Word overlap has no idea that swapping one noun changes the whole
 * topic. That is a genuine false positive and it is why the output of this
 * module is a SUGGESTION a human confirms, never an action the system takes:
 * the cost of a wrong suggestion is one dismissed prompt, and the cost of a
 * wrong merge is an attendee's question silently vanishing.
 *
 * It is also exactly the boundary where a semantic model would earn its keep —
 * and where it would start costing money per question. That tier stays off
 * until it is switched on per event; this one runs everywhere at zero cost.
 *
 * Pure functions over strings. No I/O, no framework, no clock.
 */

/**
 * Similarity at or above which a moderator is asked to compare two questions.
 *
 * 0.6 is the same bar the trigram detector used in Phase 3, so promoting a
 * paraphrase to the same tier does not change how strict a verbatim match is.
 * Lower would flag every question on a shared topic and make the signal
 * worthless; higher would miss the reworded pairs this module exists to catch.
 */
export const DUPLICATE_SUGGESTION_THRESHOLD = 0.6;

/**
 * Words that carry no topic on their own.
 *
 * English only, and deliberately short: a stopword list is a bet that a word
 * never matters, and each entry is one more way for two different questions to
 * look alike. Question openers ("how", "what", "why") are the important ones —
 * almost every question starts with one, and treating it as content would make
 * "how do I…" match "how do I…" regardless of what follows.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // Question openers and auxiliaries
  'how',
  'what',
  'which',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'why',
  'can',
  'could',
  'would',
  'should',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  // Pronouns and determiners
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'our',
  'you',
  'your',
  'he',
  'she',
  'it',
  'its',
  'they',
  'them',
  'their',
  'this',
  'that',
  'these',
  'those',
  'a',
  'an',
  'the',
  'some',
  'any',
  'one',
  // Prepositions and conjunctions
  'in',
  'on',
  'at',
  'to',
  'of',
  'for',
  'with',
  'by',
  'from',
  'about',
  'into',
  'as',
  'and',
  'or',
  'but',
  'if',
  'so',
  'than',
  'then',
  'there',
  'here',
  'not',
  'no',
  // Filler that appears in questions without carrying topic
  'get',
  'go',
  'make',
  'like',
  'just',
  'really',
  'also',
  'very',
  'please',
  'thanks',
  'think',
  'know',
  'want',
  'need',
  'best',
  'way',
  'ways',
  'people',
  'thing',
  'things',
  'good',
  'more',
  'most',
  'much',
  'many',
  'still',
  'yet',
  'ever',
  'even',
  'own',
  'other',
  'others',
  'lot',
  'lots',
]);

/**
 * Reduces a word to a rough stem so simple inflections compare equal.
 *
 * NOT a real stemmer. Porter's algorithm handles hundreds of cases this does
 * not, and it also over-stems in ways that produce surprising matches
 * ("organisation" and "organ"). These four rules cover the plural and
 * gerund forms that actually occur in questions — "businesses"/"business",
 * "companies"/"company", "hiring"/"hire" — and nothing else. A word shorter
 * than five characters is left alone: "was" → "wa" is the kind of damage that
 * makes a stemmer worse than none.
 */
function stem(word: string): string {
  if (word.length < 5) return word;

  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('es') && !word.endsWith('ees')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);

  return word;
}

/**
 * The words of a question that carry its topic, as a set of stems.
 *
 * Takes the COMPARISON form of the text (already lowercased, accent-stripped,
 * punctuation removed — see question-text.ts), so this never has to know how
 * text is folded and cannot disagree with the hash and the trigram index that
 * use the same form.
 */
export function contentTerms(normalizedBody: string): ReadonlySet<string> {
  const terms = new Set<string>();

  for (const word of normalizedBody.split(' ')) {
    if (word.length === 0 || STOPWORDS.has(word)) continue;
    terms.add(stem(word));
  }

  return terms;
}

/**
 * Dice coefficient over content terms: 2·|A∩B| ÷ (|A| + |B|), in 0–1.
 *
 * Dice rather than Jaccard because it is gentler on short questions. With
 * three words a side and two shared, Jaccard gives 2/4 = 0.5 and Dice gives
 * 4/6 = 0.67; questions ARE short, and the stricter measure would push real
 * paraphrases under the threshold.
 *
 * Two questions with no content words at all ("what about this?" against
 * "and that?") are reported as 0, not 1: there is nothing to compare, and an
 * empty match must not be a match.
 */
export function termSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;

  return (2 * shared) / (a.size + b.size);
}

export interface SimilarityCandidate {
  id: string;
  normalizedBody: string;
  /** Character-trigram similarity, as computed by Postgres for the candidate. */
  trigramSimilarity: number;
}

export interface SimilarityMatch {
  id: string;
  /** The combined score, 0–1. */
  similarity: number;
}

/**
 * Picks the candidate most likely to be the same question, if any clears the
 * threshold.
 *
 * The database does the cheap part — a handful of nearest questions by
 * trigram — and this does the precise part, so the decision is a pure function
 * that a unit test can pin to specific sentences. Each candidate's score is
 * the max of its trigram similarity and its content-term similarity.
 */
export function findBestDuplicate(
  normalizedBody: string,
  candidates: readonly SimilarityCandidate[],
  threshold: number = DUPLICATE_SUGGESTION_THRESHOLD,
): SimilarityMatch | null {
  const terms = contentTerms(normalizedBody);
  let best: SimilarityMatch | null = null;

  for (const candidate of candidates) {
    const similarity = Math.max(
      candidate.trigramSimilarity,
      termSimilarity(terms, contentTerms(candidate.normalizedBody)),
    );

    if (similarity >= threshold && (best === null || similarity > best.similarity)) {
      best = { id: candidate.id, similarity };
    }
  }

  return best;
}
