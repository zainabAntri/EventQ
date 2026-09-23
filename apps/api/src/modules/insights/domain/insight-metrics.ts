import { contentWords } from '../../questions/domain/question-similarity';

/**
 * The arithmetic behind Event Insights.
 *
 * Pure functions over numbers, dates and strings: no I/O, no framework, no
 * clock. Counting is the database's job; what lives here is every decision
 * about what a count MEANS — when a rate is undefined, how wide a bar on the
 * timeline is, which words are worth reporting — because those are the parts
 * that can be quietly wrong and so are the parts that need tests.
 */

/**
 * Share of approved questions that were answered, 0–1.
 *
 * Null rather than 0 when nothing was approved: an event with no approved
 * questions did not answer "0% of them", it had nothing to answer, and a
 * dashboard showing 0% would read as a failure that never happened.
 */
export function answerRate(approvedUnanswered: number, answered: number): number | null {
  const approved = approvedUnanswered + answered;
  return approved === 0 ? null : answered / approved;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/** Readable bucket widths, in minutes: 5 minutes up to one week. */
const BUCKET_MINUTES = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080] as const;
const NARROWEST_BUCKET = 5;
const WIDEST_BUCKET = 10080;

/**
 * Most bars the timeline will draw.
 *
 * Enough to show the shape of a two-hour session in ten-minute steps, few
 * enough that each bar is still wide enough to read and hover on a phone.
 */
export const MAX_TIMELINE_BUCKETS = 24;

/**
 * The narrowest bucket width that fits the whole span in the bar budget.
 *
 * Chosen from the event's own first and last question rather than its
 * scheduled times, because those are optional and often wrong — the room
 * starts asking when it starts asking.
 */
export function chooseBucketMinutes(first: Date, last: Date): number {
  const spanMinutes = Math.max(0, last.getTime() - first.getTime()) / 60_000;

  for (const minutes of BUCKET_MINUTES) {
    // +1 because a span that starts mid-bucket can touch one more bucket than
    // span ÷ width suggests.
    if (Math.floor(spanMinutes / minutes) + 1 <= MAX_TIMELINE_BUCKETS) return minutes;
  }

  return WIDEST_BUCKET;
}

export interface Timeline {
  bucketMinutes: number;
  buckets: Array<{ start: Date; count: number }>;
}

/**
 * Submissions per bucket, with the empty buckets in between filled in.
 *
 * A quiet stretch is information — "nobody asked anything during the panel"
 * — and a chart that skipped empty buckets would draw it as if the questions
 * had kept coming. Buckets are aligned to whole multiples of their width
 * (in UTC), so the same event always produces the same bars.
 */
export function buildTimeline(submittedAt: readonly Date[]): Timeline {
  if (submittedAt.length === 0) return { bucketMinutes: NARROWEST_BUCKET, buckets: [] };

  let first = Infinity;
  let last = -Infinity;
  for (const date of submittedAt) {
    const time = date.getTime();
    if (time < first) first = time;
    if (time > last) last = time;
  }

  const bucketMinutes = chooseBucketMinutes(new Date(first), new Date(last));
  const width = bucketMinutes * 60_000;
  const origin = Math.floor(first / width) * width;
  const counts = new Array<number>(Math.floor((last - origin) / width) + 1).fill(0);

  for (const date of submittedAt) {
    const index = Math.floor((date.getTime() - origin) / width);
    counts[index] = (counts[index] ?? 0) + 1;
  }

  return {
    bucketMinutes,
    buckets: counts.map((count, index) => ({ start: new Date(origin + index * width), count })),
  };
}

// ---------------------------------------------------------------------------
// Frequent terms
// ---------------------------------------------------------------------------

/** A word must appear in at least this many questions to be reported. One
 *  question mentioning something is not a theme. */
export const MIN_TERM_QUESTIONS = 2;

export const MAX_TERMS = 10;

export interface TermCount {
  term: string;
  questions: number;
  share: number;
}

/**
 * The content words that recur across questions, most widespread first.
 *
 * Counts QUESTIONS containing a word, not occurrences of it: one attendee
 * typing "AI" five times is one question about AI, not five. Grouped by stem
 * so "business" and "businesses" are one term, and reported as the spelling
 * most questions actually used.
 *
 * Takes the comparison form of each question (lowercased, accents and
 * punctuation removed) — the same text duplicate detection runs on — so the
 * two features can never disagree about what a word is.
 *
 * Bare numbers are dropped: "2026" recurring in questions about a 2026 event
 * says nothing about what anyone wanted to know.
 */
export function frequentTerms(
  normalizedBodies: readonly string[],
  options: { limit?: number; minQuestions?: number } = {},
): TermCount[] {
  const limit = options.limit ?? MAX_TERMS;
  const minQuestions = options.minQuestions ?? MIN_TERM_QUESTIONS;
  const total = normalizedBodies.length;
  if (total === 0) return [];

  const questionsByStem = new Map<string, number>();
  const spellingsByStem = new Map<string, Map<string, number>>();

  for (const body of normalizedBodies) {
    for (const [stem, word] of contentWords(body)) {
      if (/^\d+$/u.test(word)) continue;

      questionsByStem.set(stem, (questionsByStem.get(stem) ?? 0) + 1);

      const spellings = spellingsByStem.get(stem) ?? new Map<string, number>();
      spellings.set(word, (spellings.get(word) ?? 0) + 1);
      spellingsByStem.set(stem, spellings);
    }
  }

  return [...questionsByStem]
    .filter(([, questions]) => questions >= minQuestions)
    .map(([stem, questions]) => ({
      term: mostCommon(spellingsByStem.get(stem) ?? new Map([[stem, 1]])),
      questions,
      share: questions / total,
    }))
    .sort((a, b) => b.questions - a.questions || a.term.localeCompare(b.term))
    .slice(0, limit);
}

/** The most frequent key; ties go to the alphabetically first, so output is stable. */
function mostCommon(counts: ReadonlyMap<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && key.localeCompare(best) < 0)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}
