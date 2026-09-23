import { describe, expect, it } from 'vitest';
import { normalizeForComparison } from '../../questions/domain/question-text';
import {
  answerRate,
  buildTimeline,
  chooseBucketMinutes,
  frequentTerms,
  MAX_TIMELINE_BUCKETS,
} from './insight-metrics';

const at = (iso: string): Date => new Date(iso);
const normalized = (...questions: string[]): string[] => questions.map(normalizeForComparison);

describe('answerRate', () => {
  it('is answered over everything the room could see', () => {
    expect(answerRate(3, 1)).toBe(0.25);
    expect(answerRate(0, 4)).toBe(1);
  });

  it('is null, not 0%, when nothing was approved', () => {
    // 0% would read as "answered none of them" — a failure that never happened.
    expect(answerRate(0, 0)).toBeNull();
  });
});

describe('chooseBucketMinutes', () => {
  it('uses five-minute bars for a short burst', () => {
    expect(chooseBucketMinutes(at('2026-09-23T10:00:00Z'), at('2026-09-23T10:40:00Z'))).toBe(5);
  });

  it('widens the bars for a two-hour session so it stays readable', () => {
    expect(chooseBucketMinutes(at('2026-09-23T10:00:00Z'), at('2026-09-23T12:00:00Z'))).toBe(10);
  });

  it('uses day-long bars for a multi-day conference', () => {
    expect(chooseBucketMinutes(at('2026-09-20T09:00:00Z'), at('2026-09-23T18:00:00Z'))).toBe(360);
  });
});

describe('buildTimeline', () => {
  it('returns no bars for an event with no questions', () => {
    expect(buildTimeline([]).buckets).toEqual([]);
  });

  it('fills the quiet stretches in between with zeros', () => {
    // A gap is information: "nobody asked anything during the panel".
    const timeline = buildTimeline([
      at('2026-09-23T10:01:00Z'),
      at('2026-09-23T10:02:00Z'),
      at('2026-09-23T10:21:00Z'),
    ]);

    expect(timeline.bucketMinutes).toBe(5);
    expect(timeline.buckets.map((bucket) => bucket.count)).toEqual([2, 0, 0, 0, 1]);
    expect(timeline.buckets[0]?.start.toISOString()).toBe('2026-09-23T10:00:00.000Z');
  });

  it('counts every question exactly once, in any order', () => {
    const times = Array.from({ length: 50 }, (_, index) =>
      at(
        `2026-09-23T${String(9 + (index % 8)).padStart(2, '0')}:${String(index).padStart(2, '0')}:00Z`,
      ),
    ).reverse();

    const timeline = buildTimeline(times);
    const total = timeline.buckets.reduce((sum, bucket) => sum + bucket.count, 0);

    expect(total).toBe(50);
    expect(timeline.buckets.length).toBeLessThanOrEqual(MAX_TIMELINE_BUCKETS);
  });
});

describe('frequentTerms', () => {
  it('counts questions, not occurrences', () => {
    const terms = frequentTerms(
      normalized(
        'AI AI AI AI — what about AI?',
        'How do small businesses start with AI?',
        'Is marketing still worth it?',
      ),
    );

    expect(terms.find((term) => term.term === 'ai')).toEqual({
      term: 'ai',
      questions: 2,
      share: 2 / 3,
    });
  });

  it('folds plurals into one term and shows the spelling people used', () => {
    const terms = frequentTerms(
      normalized(
        'How can businesses grow?',
        'What should businesses automate first?',
        'Is my business too small?',
      ),
    );

    expect(terms[0]).toMatchObject({ term: 'businesses', questions: 3 });
  });

  it('ignores question openers and filler words', () => {
    const terms = frequentTerms(
      normalized('How can I use this?', 'How can I do that?', 'What can I try?'),
    );

    expect(terms.map((term) => term.term)).not.toContain('how');
    expect(terms.map((term) => term.term)).not.toContain('can');
  });

  it('does not report a word only one question used', () => {
    expect(frequentTerms(normalized('Pricing for enterprise?', 'Roadmap for 2027?'))).toEqual([]);
  });

  it('drops bare numbers', () => {
    const terms = frequentTerms(normalized('Plans for 2027 hiring?', 'Budget for 2027 events?'));
    expect(terms.map((term) => term.term)).not.toContain('2027');
  });

  it('orders by reach, then alphabetically, so output is stable', () => {
    const terms = frequentTerms(
      normalized('pricing roadmap', 'roadmap pricing', 'hiring roadmap', 'hiring pricing'),
    );

    expect(terms.map((term) => term.term)).toEqual(['pricing', 'roadmap', 'hiring']);
  });
});
