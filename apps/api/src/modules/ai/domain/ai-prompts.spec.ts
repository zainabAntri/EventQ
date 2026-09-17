import { describe, expect, it } from 'vitest';
import { AI_LIMITS } from './ai-limits';
import {
  boundQuestion,
  buildAnswerPrompt,
  buildCategorizePrompt,
  buildClusterPrompt,
  buildSimilarPrompt,
  buildSummaryPrompt,
  resolveIndex,
  SIMILAR_CONFIDENCE_FLOOR,
  validateCategorize,
  validateCluster,
  validateSimilar,
  validateSummary,
  type MinimalQuestion,
} from './ai-prompts';

/**
 * Two properties of every prompt, proven rather than promised.
 *
 * MINIMISATION: a record carrying every sensitive field the system has is
 * built into a prompt, and the prompt is searched for each of them. If a
 * builder ever starts spreading a record instead of picking from it, this is
 * the test that goes red.
 *
 * CONTAINMENT: every way a model can be wrong outside the shape it was
 * given — a category it invented, a question number past the end, a
 * duplicate reference, a confident-sounding guess — is fed to the validators
 * and shown to be discarded rather than stored.
 */

const EVENT = { title: 'AI in Business Breakfast', description: 'Founders and investors.' };

/**
 * A record with everything a model must NEVER see. The builders accept it
 * because MinimalQuestion is a structural type — which is exactly why the
 * assertion below matters: the type does not stop a leak, the builder does.
 */
const LEAKY_RECORD = {
  id: '01930000-0000-7000-8000-00000000abcd',
  body: 'How can I use AI in my company?',
  status: 'APPROVED' as const,
  attendeeId: '01930000-0000-7000-8000-00000000dead',
  authorName: 'Priya Raman',
  email: 'priya@example.com',
  upvoteCount: 42,
  ipAddress: '203.0.113.7',
  passwordHash: '$argon2id$v=19$m=65536',
  sessionToken: 'eyJhbGciOiJIUzI1NiJ9.leak',
};

const SENSITIVE_VALUES = [
  LEAKY_RECORD.id,
  LEAKY_RECORD.attendeeId,
  LEAKY_RECORD.authorName,
  LEAKY_RECORD.email,
  String(LEAKY_RECORD.upvoteCount),
  LEAKY_RECORD.ipAddress,
  LEAKY_RECORD.passwordHash,
  LEAKY_RECORD.sessionToken,
];

function question(index: number, body: string): MinimalQuestion {
  return {
    id: `01930000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    body,
    status: 'APPROVED',
  };
}

const THREE = [
  question(1, 'How can I use AI in my company?'),
  question(2, 'What time is lunch served today?'),
  question(3, 'Should we hire a data scientist first?'),
];

describe('data minimisation', () => {
  const prompts = {
    categorize: () => buildCategorizePrompt(EVENT, [LEAKY_RECORD]),
    similar: () => buildSimilarPrompt(EVENT, LEAKY_RECORD, [LEAKY_RECORD]),
    cluster: () => buildClusterPrompt(EVENT, [LEAKY_RECORD, LEAKY_RECORD]),
    answer: () => buildAnswerPrompt(EVENT, LEAKY_RECORD),
    summary: () => buildSummaryPrompt(EVENT, [LEAKY_RECORD]),
  };

  for (const [name, build] of Object.entries(prompts)) {
    it(`${name}: sends the question text and nothing else about the record`, () => {
      const { system, input } = build();
      const everything = `${system}\n${input}`;

      expect(input).toContain('How can I use AI in my company?');
      for (const value of SENSITIVE_VALUES) {
        expect(everything).not.toContain(value);
      }
    });
  }

  it('refers to questions by a per-call number, never by id', () => {
    const { input } = buildCategorizePrompt(EVENT, THREE);

    expect(input).toContain('1. How can I use AI in my company?');
    expect(input).toContain('3. Should we hire a data scientist first?');
    for (const item of THREE) expect(input).not.toContain(item.id);
  });

  it('includes the event title and description, which the organizer wrote', () => {
    const { input } = buildSummaryPrompt(EVENT, THREE);

    expect(input).toContain('AI in Business Breakfast');
    expect(input).toContain('Founders and investors.');
  });
});

describe('input limits', () => {
  it('truncates a long question and says so', () => {
    const long = 'x'.repeat(AI_LIMITS.maxQuestionChars + 500);
    const bounded = boundQuestion(long);

    expect(bounded.length).toBeLessThan(long.length);
    expect(bounded).toMatch(/truncated/);
    expect(bounded.startsWith('x'.repeat(AI_LIMITS.maxQuestionChars))).toBe(true);
  });

  it('collapses whitespace so a question padded with newlines costs no more tokens', () => {
    expect(boundQuestion('How  \n\n  can   I \t use AI?')).toBe('How can I use AI?');
  });

  it('refuses a prompt that would exceed the total input cap', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      question(i + 1, 'y'.repeat(AI_LIMITS.maxQuestionChars)),
    );

    // 200 × 600 chars is past 80k, however the per-feature count was set.
    expect(() => buildClusterPrompt(EVENT, many)).toThrow(/exceeds/);
  });
});

describe('resolving a model’s question references', () => {
  it('maps a valid number to the question it stands for', () => {
    expect(resolveIndex(2, THREE)?.id).toBe(THREE[1]!.id);
  });

  it.each([0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'treats %s as no question at all',
    (index) => {
      expect(resolveIndex(index, THREE)).toBeNull();
    },
  );
});

describe('categorisation', () => {
  it('stores only categories from the fixed set and counts the rest as rejected', () => {
    const result = validateCategorize(
      {
        assignments: [
          { question: 1, category: 'AI' },
          { question: 2, category: 'Catering' }, // invented
          { question: 3, category: ' Business ' }, // sloppy but valid
          { question: 9, category: 'Finance' }, // no such question
          { question: 1, category: 'Technology' }, // second answer for one question
        ],
      },
      THREE,
    );

    expect(result.assignments).toEqual([
      { questionId: THREE[0]!.id, category: 'AI' },
      { questionId: THREE[2]!.id, category: 'Business' },
    ]);
    expect(result.rejected).toBe(3);
  });
});

describe('similar-question detection', () => {
  const candidates = THREE.slice(1);

  it('accepts a confident match to a candidate we offered', () => {
    const result = validateSimilar({ match: 2, confidence: 0.9, reason: 'Same ask.' }, candidates);

    expect(result.match).toEqual({
      questionId: candidates[1]!.id,
      confidence: 0.9,
      reason: 'Same ask.',
    });
  });

  it('turns a guess below the confidence floor into no match', () => {
    const result = validateSimilar(
      { match: 1, confidence: SIMILAR_CONFIDENCE_FLOOR - 0.01, reason: 'Maybe.' },
      candidates,
    );

    expect(result.match).toBeNull();
  });

  it('turns a reference to a question we never sent into no match', () => {
    expect(
      validateSimilar({ match: 7, confidence: 0.99, reason: '' }, candidates).match,
    ).toBeNull();
  });

  it('honours an explicit "none of these"', () => {
    expect(
      validateSimilar({ match: null, confidence: 0.8, reason: '' }, candidates).match,
    ).toBeNull();
  });
});

describe('clustering', () => {
  const six = [
    ...THREE,
    question(4, 'Which AI tools are worth paying for?'),
    question(5, 'Is the coffee free?'),
    question(6, 'How do I find a technical co-founder?'),
  ];

  it('places each question in at most one topic, first claim wins', () => {
    const result = validateCluster(
      {
        topics: [
          { label: 'AI adoption', summary: '', questions: [1, 4] },
          { label: 'Also AI', summary: '', questions: [4, 1, 3] }, // 4 and 1 already taken
        ],
      },
      six,
    );

    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]!.questionIds).toEqual([six[0]!.id, six[3]!.id]);
  });

  it('drops a topic left with fewer than two valid questions', () => {
    const result = validateCluster(
      {
        topics: [
          { label: 'Hiring', summary: '', questions: [3, 6] },
          { label: 'Ghosts', summary: '', questions: [42, 43] }, // nothing real
          { label: 'Lonely', summary: '', questions: [5] },
        ],
      },
      six,
    );

    expect(result.topics.map((topic) => topic.label)).toEqual(['Hiring']);
    expect(result.unclustered).toBe(4);
  });

  it('counts questions the model left out as unclustered, not lost', () => {
    const result = validateCluster({ topics: [] }, six);

    expect(result.topics).toEqual([]);
    expect(result.unclustered).toBe(6);
  });
});

describe('event summary', () => {
  it('keeps only references to questions that were actually sent', () => {
    const result = validateSummary(
      {
        headline: ' Mostly about AI. ',
        themes: [{ title: 'AI', description: 'd', questions: [1, 1, 99] }],
        notableQuestions: [
          { question: 3, why: 'Hiring is on their minds.' },
          { question: 3, why: 'Again' },
          { question: 0, why: 'Invented' },
        ],
        suggestedFollowUps: [' Share a tools list ', ''],
      },
      THREE,
    );

    expect(result.headline).toBe('Mostly about AI.');
    expect(result.themes[0]!.questionIds).toEqual([THREE[0]!.id]);
    expect(result.notableQuestions).toEqual([
      { questionId: THREE[2]!.id, why: 'Hiring is on their minds.' },
    ]);
    expect(result.suggestedFollowUps).toEqual(['Share a tools list']);
  });
});
