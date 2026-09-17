import { z } from 'zod';
import { AiCategory, type QuestionStatus } from '@eventq/contracts';
import { AI_LIMITS } from './ai-limits';

/**
 * Prompts, schemas and validators for every AI feature.
 *
 * Pure functions: records in, text and a schema out, a model's reply in, a
 * validated result out. No I/O, no SDK, no clock. That is what makes the
 * two things that matter most here testable in microseconds:
 *
 *   - DATA MINIMISATION. The builders take a `MinimalQuestion`, which is the
 *     whole of what a model is allowed to see about a question: its text and
 *     its status. Not who asked it, not their name or email, not the vote
 *     count, not the UUID. Questions are referenced by a 1-based index that
 *     exists only for the duration of one call, and the caller maps indexes
 *     back to ids afterwards. A test serialises a prompt built from records
 *     carrying every sensitive field and asserts none of them survived.
 *
 *   - HALLUCINATION CONTAINMENT. A model can only be wrong INSIDE the shapes
 *     below: a category must be one of eight, a question reference must be an
 *     index we sent, a similar-question pick must be a candidate we offered.
 *     Anything else is discarded by the validators here, counted, and never
 *     stored. The model cannot invent a question, a category or a link.
 */

/** Everything a model may know about a question. Nothing else is expressible. */
export interface MinimalQuestion {
  id: string;
  body: string;
  status: QuestionStatus;
}

/** Everything a model may know about an event. Organizer-authored text only. */
export interface MinimalEvent {
  title: string;
  description: string | null;
}

/** Bounds a body to the limit, marking the cut so the model does not read a
 *  truncated sentence as a complete one. */
export function boundQuestion(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= AI_LIMITS.maxQuestionChars) return flat;
  return `${flat.slice(0, AI_LIMITS.maxQuestionChars)} […truncated]`;
}

function boundContext(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= AI_LIMITS.maxEventContextChars
    ? flat
    : `${flat.slice(0, AI_LIMITS.maxEventContextChars)} […truncated]`;
}

/** Numbered list, the only form questions ever take in a prompt. */
function numbered(questions: readonly MinimalQuestion[]): string {
  return questions.map((question, i) => `${i + 1}. ${boundQuestion(question.body)}`).join('\n');
}

function eventContext(event: MinimalEvent): string {
  const lines = [`Event: ${boundContext(event.title)}`];
  if (event.description) lines.push(`About: ${boundContext(event.description)}`);
  return lines.join('\n');
}

/** Rejects a prompt that grew past the input cap, whatever the counts said. */
export function assertWithinInputCap(input: string): void {
  if (input.length > AI_LIMITS.maxInputChars) {
    throw new Error(
      `AI input of ${input.length} characters exceeds the ${AI_LIMITS.maxInputChars} cap`,
    );
  }
}

/**
 * Turns a 1-based index from a model into the id it stands for, or null.
 *
 * Every reference a model makes goes through this. A non-integer, zero, a
 * negative number or anything past the end is a hallucination, and the
 * answer for a hallucination is "no such question", never a guess.
 */
export function resolveIndex(
  index: number,
  questions: readonly MinimalQuestion[],
): MinimalQuestion | null {
  if (!Number.isInteger(index) || index < 1 || index > questions.length) return null;
  return questions[index - 1] ?? null;
}

const GROUND_RULES = [
  'You are helping the organizer of a live audience Q&A event. You will be shown audience questions as a numbered list.',
  'Refer to questions ONLY by their number in the list. Never invent a question that is not in the list.',
  'Do not include any personal data in your output. You have not been given any, and you must not guess at any.',
  'Answer only in the structured format requested.',
].join(' ');

// ---------------------------------------------------------------------------
// 1. Categorisation
// ---------------------------------------------------------------------------

export const CATEGORIZE_SYSTEM = `${GROUND_RULES} Your task is to assign each question exactly one category from a fixed list. Choose "Other" whenever no listed category clearly fits; do not force a fit.`;

export const CategorizeOutput = z.object({
  assignments: z.array(
    z.object({
      question: z.number().int(),
      /** Free text here on purpose: the VALIDATOR decides whether it is one of
       *  ours, and a reply outside the set is counted as rejected rather than
       *  failing the whole batch on one bad item. */
      category: z.string(),
    }),
  ),
});
export type CategorizeOutput = z.infer<typeof CategorizeOutput>;

export function buildCategorizePrompt(event: MinimalEvent, questions: readonly MinimalQuestion[]) {
  const input = [
    eventContext(event),
    '',
    `Categories: ${AiCategory.options.join(', ')}`,
    '',
    'Questions:',
    numbered(questions),
  ].join('\n');
  assertWithinInputCap(input);

  return { system: CATEGORIZE_SYSTEM, input, schema: CategorizeOutput };
}

export interface CategorizeResult {
  assignments: Array<{ questionId: string; category: AiCategory }>;
  /** Replies naming a category outside the set or a question outside the list. */
  rejected: number;
}

export function validateCategorize(
  output: CategorizeOutput,
  questions: readonly MinimalQuestion[],
): CategorizeResult {
  const seen = new Set<string>();
  const assignments: CategorizeResult['assignments'] = [];
  let rejected = 0;

  for (const item of output.assignments) {
    const question = resolveIndex(item.question, questions);
    const category = AiCategory.safeParse(item.category.trim());

    if (!question || !category.success || seen.has(question.id)) {
      rejected += 1;
      continue;
    }

    seen.add(question.id);
    assignments.push({ questionId: question.id, category: category.data });
  }

  return { assignments, rejected };
}

// ---------------------------------------------------------------------------
// 2. Similar-question detection
// ---------------------------------------------------------------------------

export const SIMILAR_SYSTEM = `${GROUND_RULES} Your task is to decide whether the NEW question is asking the same underlying thing as one of the EXISTING questions — the same question in different words, such that one answer would satisfy both. Sharing a topic is not enough. If none is the same question, say so; a false match wastes the organizer's time more than a miss does.`;

export const SimilarOutput = z.object({
  /** The existing question's number, or null when none is the same. */
  match: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
});
export type SimilarOutput = z.infer<typeof SimilarOutput>;

export function buildSimilarPrompt(
  event: MinimalEvent,
  question: MinimalQuestion,
  candidates: readonly MinimalQuestion[],
) {
  const input = [
    eventContext(event),
    '',
    `NEW question: ${boundQuestion(question.body)}`,
    '',
    'EXISTING questions:',
    numbered(candidates),
  ].join('\n');
  assertWithinInputCap(input);

  return { system: SIMILAR_SYSTEM, input, schema: SimilarOutput };
}

export interface SimilarResult {
  match: { questionId: string; confidence: number; reason: string } | null;
}

/**
 * A match is only a match if it names a candidate we offered AND clears a
 * confidence floor. Below it, the model is guessing, and a guess that becomes
 * a suggestion on a moderator's screen is exactly the noise this must not add.
 */
export const SIMILAR_CONFIDENCE_FLOOR = 0.6;

export function validateSimilar(
  output: SimilarOutput,
  candidates: readonly MinimalQuestion[],
): SimilarResult {
  if (output.match === null) return { match: null };

  const candidate = resolveIndex(output.match, candidates);
  if (!candidate || output.confidence < SIMILAR_CONFIDENCE_FLOOR) return { match: null };

  return {
    match: { questionId: candidate.id, confidence: output.confidence, reason: output.reason },
  };
}

// ---------------------------------------------------------------------------
// 3. Clustering
// ---------------------------------------------------------------------------

export const CLUSTER_SYSTEM = `${GROUND_RULES} Your task is to group the questions into topics an organizer could hand to a speaker. Prefer a few well-defined topics over many thin ones; a topic should have at least two questions. Every question belongs to at most one topic. Leave a question out rather than force it into a topic where it does not belong. Give each topic a short label (at most six words) and a one-sentence summary of what the group is asking.`;

export const ClusterOutput = z.object({
  topics: z.array(
    z.object({
      label: z.string().min(1).max(80),
      summary: z.string().max(300),
      questions: z.array(z.number().int()),
    }),
  ),
});
export type ClusterOutput = z.infer<typeof ClusterOutput>;

export function buildClusterPrompt(event: MinimalEvent, questions: readonly MinimalQuestion[]) {
  const input = [eventContext(event), '', 'Questions:', numbered(questions)].join('\n');
  assertWithinInputCap(input);

  return { system: CLUSTER_SYSTEM, input, schema: ClusterOutput };
}

export interface ClusterResult {
  topics: Array<{ label: string; summary: string; questionIds: string[] }>;
  /** Questions the model did not place, plus any it placed only by invalid reference. */
  unclustered: number;
}

/**
 * A question lands in the first topic that claims it, and only there. A
 * topic left with fewer than two valid questions is dropped — a "group" of
 * one is not a group, and a label with nothing under it is clutter.
 */
export function validateCluster(
  output: ClusterOutput,
  questions: readonly MinimalQuestion[],
): ClusterResult {
  const placed = new Set<string>();
  const topics: ClusterResult['topics'] = [];

  for (const topic of output.topics) {
    const questionIds: string[] = [];
    for (const index of topic.questions) {
      const question = resolveIndex(index, questions);
      if (!question || placed.has(question.id)) continue;
      placed.add(question.id);
      questionIds.push(question.id);
    }

    if (questionIds.length < 2) {
      // Release them so a later, larger topic could still claim them.
      for (const id of questionIds) placed.delete(id);
      continue;
    }

    topics.push({ label: topic.label.trim(), summary: topic.summary.trim(), questionIds });
  }

  return { topics, unclustered: questions.length - placed.size };
}

// ---------------------------------------------------------------------------
// 4. Suggested answer
// ---------------------------------------------------------------------------

export const ANSWER_SYSTEM = `${GROUND_RULES} Your task is to DRAFT a possible answer to one audience question, for a human speaker to review, edit or discard. You do not know the speaker's views or the event's private context, so write a helpful general answer, keep it under 150 words, and list every assumption or gap as a caveat. If the question cannot be answered generally, say so in the draft and explain why in the caveats. Never claim specific facts about this event, its organizers or its speakers.`;

export const AnswerOutput = z.object({
  draft: z.string().min(1).max(2_000),
  caveats: z.array(z.string().max(300)).max(8),
});
export type AnswerOutput = z.infer<typeof AnswerOutput>;

export function buildAnswerPrompt(event: MinimalEvent, question: MinimalQuestion) {
  const input = [eventContext(event), '', `Question: ${boundQuestion(question.body)}`].join('\n');
  assertWithinInputCap(input);

  return { system: ANSWER_SYSTEM, input, schema: AnswerOutput };
}

// ---------------------------------------------------------------------------
// 5. Event summary
// ---------------------------------------------------------------------------

export const SUMMARY_SYSTEM = `${GROUND_RULES} Your task is to summarise what the audience at this event wanted to know, for the organizer to read afterwards. Write a one-sentence headline; three to six themes, each with a short title, a two-sentence description and the numbers of the questions it covers; up to five notable questions with one sentence each on why they stand out; and up to five follow-up actions the organizer could take. Base everything on the questions given. Do not invent attendance figures, names, or outcomes.`;

export const SummaryOutput = z.object({
  headline: z.string().min(1).max(300),
  themes: z
    .array(
      z.object({
        title: z.string().min(1).max(80),
        description: z.string().max(600),
        questions: z.array(z.number().int()),
      }),
    )
    .max(8),
  notableQuestions: z
    .array(z.object({ question: z.number().int(), why: z.string().max(300) }))
    .max(5),
  suggestedFollowUps: z.array(z.string().max(300)).max(5),
});
export type SummaryOutput = z.infer<typeof SummaryOutput>;

export function buildSummaryPrompt(event: MinimalEvent, questions: readonly MinimalQuestion[]) {
  const input = [
    eventContext(event),
    '',
    `Questions (${questions.length}):`,
    numbered(questions),
  ].join('\n');
  assertWithinInputCap(input);

  return { system: SUMMARY_SYSTEM, input, schema: SummaryOutput };
}

export interface SummaryResult {
  headline: string;
  themes: Array<{ title: string; description: string; questionIds: string[] }>;
  notableQuestions: Array<{ questionId: string; why: string }>;
  suggestedFollowUps: string[];
}

export function validateSummary(
  output: SummaryOutput,
  questions: readonly MinimalQuestion[],
): SummaryResult {
  const seenNotable = new Set<string>();
  const notableQuestions: SummaryResult['notableQuestions'] = [];
  for (const item of output.notableQuestions) {
    const question = resolveIndex(item.question, questions);
    if (!question || seenNotable.has(question.id)) continue;
    seenNotable.add(question.id);
    notableQuestions.push({ questionId: question.id, why: item.why.trim() });
  }

  return {
    headline: output.headline.trim(),
    themes: output.themes.map((theme) => ({
      title: theme.title.trim(),
      description: theme.description.trim(),
      questionIds: [
        ...new Set(
          theme.questions
            .map((index) => resolveIndex(index, questions)?.id)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ],
    })),
    notableQuestions,
    suggestedFollowUps: output.suggestedFollowUps.map((item) => item.trim()).filter(Boolean),
  };
}
