'use client';

import {
  explainRankScore,
  type DuplicateSuggestion,
  type QuestionModerationAction,
  type QuestionResponse,
  type QuestionStatus,
} from '@eventq/contracts';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * One question in the moderation queue.
 *
 * Everything a moderator needs to make a decision is on the card, because the
 * alternative — clicking through to a detail view — is unusable when there are
 * forty questions waiting and a speaker is already on stage.
 *
 * The action buttons come from `allowedActions`, which the API derives from the
 * same transition table it enforces. The card never works out for itself what
 * is legal, so it cannot offer a button that returns 422.
 */

const STATUS_LABEL: Readonly<Record<QuestionStatus, string>> = {
  PENDING: 'Waiting',
  APPROVED: 'Approved',
  ANSWERED: 'Answered',
  REJECTED: 'Rejected',
  SPAM: 'Spam',
  ARCHIVED: 'Archived',
};

/**
 * Colour is never the only signal — every badge also carries its label as text,
 * so the status is readable to someone who cannot distinguish the colours and
 * to a screen reader that reports neither.
 */
const STATUS_STYLE: Readonly<Record<QuestionStatus, string>> = {
  PENDING: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  APPROVED: 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300',
  ANSWERED: 'border-brand-500/40 bg-brand-500/10 text-brand-700 dark:text-brand-300',
  REJECTED: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  SPAM: 'border-red-600/50 bg-red-600/15 text-red-700 dark:text-red-300',
  ARCHIVED: 'border-current/20 bg-current/5 text-[var(--muted)]',
};

const ACTION_LABEL: Readonly<Record<QuestionModerationAction, string>> = {
  approve: 'Approve',
  reject: 'Reject',
  spam: 'Mark as spam',
  answer: 'Mark answered',
  archive: 'Archive',
  restore: 'Restore',
};

/** Approve is the action a moderator reaches for most, so it leads and is the
 *  only one styled as primary. Destructive actions are never the easy click. */
const ACTION_VARIANT: Readonly<
  Record<QuestionModerationAction, 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'>
> = {
  approve: 'primary',
  answer: 'secondary',
  restore: 'secondary',
  reject: 'outline',
  spam: 'outline',
  archive: 'ghost',
};

/** Flags come from the spam heuristics as machine names; a moderator needs
 *  sentences. An unknown signal falls back to its own name rather than
 *  disappearing — a held question with no visible reason is worse than an ugly
 *  label. */
const FLAG_LABEL: Readonly<Record<string, string>> = {
  possible_duplicate: 'Looks like an existing question',
  disallowed_url_scheme: 'Contains an executable link',
  link_spam: 'Reads as link spam',
  excessive_links: 'Several links',
  contains_link: 'Contains a link',
  shouting: 'Mostly capitals',
  repeated_characters: 'Long run of repeated characters',
  low_alphabetic_ratio: 'Mostly symbols or digits',
  repeated_word: 'Same word repeated',
  profanity: 'Flagged language',
};

export interface QuestionCardProps {
  question: QuestionResponse;
  isBusy: boolean;
  onModerate: (questionId: string, action: QuestionModerationAction) => void;
  /** Confirm a duplicate: fold this question into the suggested original. */
  onMerge: (questionId: string, intoQuestionId: string) => void;
  /** "No, these are different questions." */
  onDismissDuplicate: (questionId: string) => void;
  /**
   * AI is on for this event. Only then are the per-question AI buttons
   * offered; each is one model call the organizer chose to make.
   */
  aiEnabled?: boolean;
  onDraftAnswer?: (questionId: string) => void;
  onFindSimilar?: (questionId: string) => void;
}

export function QuestionCard({
  question,
  isBusy,
  onModerate,
  onMerge,
  onDismissDuplicate,
  aiEnabled = false,
  onDraftAnswer,
  onFindSimilar,
}: QuestionCardProps) {
  const submitted = new Date(question.createdAt);
  const suggestion = question.possibleDuplicate;

  return (
    <li
      className={cn(
        'rounded-lg border border-[var(--border)] p-4 transition-opacity sm:p-5',
        isBusy && 'opacity-60',
      )}
      aria-busy={isBusy || undefined}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 font-medium',
            STATUS_STYLE[question.status],
          )}
        >
          {STATUS_LABEL[question.status]}
        </span>

        <span className="text-[var(--muted)]">
          {/* The author's name when they gave one. Anonymity is a property of
              the question, resolved server-side against the event's identity
              policy — this only renders the answer. */}
          {question.isAnonymous || !question.authorName ? 'Anonymous' : question.authorName}
        </span>

        <span aria-hidden="true" className="text-[var(--muted)]">
          ·
        </span>

        <time
          dateTime={question.createdAt}
          title={submitted.toLocaleString()}
          className="text-[var(--muted)]"
        >
          {formatRelativeTime(submitted)}
        </time>

        {/* Category and topic are AI-produced, and say so: a chip that looked
            like something a person typed would be a small lie on every card. */}
        {question.category ? (
          <span
            className="rounded-full border border-violet-500/40 px-2 py-0.5"
            title="Category suggested by AI"
          >
            {question.category}
            <span className="sr-only"> (AI-suggested category)</span>
          </span>
        ) : null}
        {question.topic ? (
          <span
            className="rounded-full border border-violet-500/40 px-2 py-0.5"
            title="Topic grouped by AI"
          >
            {question.topic.label}
            <span className="sr-only"> (AI-grouped topic)</span>
          </span>
        ) : null}

        {question.askedByCount > 1 ? (
          // Only when duplicates were merged in: a badge reading "1 person"
          // on every card would be noise, and the number only means anything
          // once a moderator has confirmed that several people asked this.
          <span
            className="rounded-full border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 font-medium text-brand-700 dark:text-brand-300"
            title="Asked by several attendees; their questions were merged into this one"
          >
            Asked by {question.askedByCount} people
          </span>
        ) : null}

        <span className="ml-auto font-medium tabular-nums">
          {question.upvoteCount}
          <span className="ml-1 font-normal text-[var(--muted)]">
            {question.upvoteCount === 1 ? 'vote' : 'votes'}
          </span>
        </span>
      </div>

      {/* Rendered as TEXT. React escapes it, which is the control that actually
          prevents XSS — never dangerouslySetInnerHTML for attendee input. */}
      <p className="mt-3 text-base leading-relaxed break-words whitespace-pre-wrap">
        {question.body}
      </p>

      {question.answeredAt ? (
        <p className="mt-2 text-xs text-[var(--muted)]">
          Answered {formatRelativeTime(new Date(question.answeredAt))}
        </p>
      ) : null}

      {question.flags.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Why this question was held">
          {question.flags.map((flag) => (
            <li
              key={flag}
              className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
            >
              {FLAG_LABEL[flag] ?? flag}
            </li>
          ))}
        </ul>
      ) : null}

      {suggestion ? (
        <DuplicatePanel
          suggestion={suggestion}
          isBusy={isBusy}
          onMerge={() => onMerge(question.id, suggestion.questionId)}
          onDismiss={() => onDismissDuplicate(question.id)}
        />
      ) : null}

      {question.mergedIntoQuestionId ? (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Merged into another question. Its votes now count towards that one.
        </p>
      ) : null}

      {question.aiSuggestedAnswer ? <DraftAnswer draft={question.aiSuggestedAnswer} /> : null}

      <RankExplanation question={question} />

      {aiEnabled && question.status !== 'ARCHIVED' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {onDraftAnswer ? (
            <Button
              size="sm"
              variant="ghost"
              isLoading={isBusy}
              loadingLabel="Drafting"
              onClick={() => onDraftAnswer(question.id)}
              title="One model call. Produces a draft for you to edit; nothing is published."
            >
              {question.aiSuggestedAnswer ? 'Redraft answer with AI' : 'Draft an answer with AI'}
            </Button>
          ) : null}
          {onFindSimilar && !question.possibleDuplicate ? (
            <Button
              size="sm"
              variant="ghost"
              isLoading={isBusy}
              loadingLabel="Checking"
              onClick={() => onFindSimilar(question.id)}
              title="One model call. Suggests a duplicate for you to confirm; nothing is merged."
            >
              Check for a duplicate with AI
            </Button>
          ) : null}
        </div>
      ) : null}

      {question.allowedActions.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {question.allowedActions.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={ACTION_VARIANT[action]}
              isLoading={isBusy}
              loadingLabel={`${ACTION_LABEL[action]} in progress`}
              onClick={() => onModerate(question.id, action)}
            >
              {ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * An AI-drafted answer, shown as exactly that.
 *
 * The label is text, not colour, so it survives a screen reader and a
 * monochrome projector alike; the caveats the model gave are printed beneath
 * it rather than folded away, because a draft that hides its own doubts
 * reads as more certain than it is. There is no "Publish" button here on
 * purpose: the draft is for the person to read and, if they choose, to say
 * in their own words. Nothing on this card can send it to the room.
 */
function DraftAnswer({ draft }: { draft: NonNullable<QuestionResponse['aiSuggestedAnswer']> }) {
  return (
    <aside
      aria-label="AI-drafted answer"
      className="mt-3 rounded-md border border-violet-500/40 bg-violet-500/5 p-3 text-sm"
    >
      <p className="text-xs font-medium text-violet-700 dark:text-violet-300">
        AI-generated draft · {draft.modelId} · not shown to attendees
      </p>
      <p className="mt-1.5 leading-relaxed break-words whitespace-pre-wrap">{draft.draft}</p>
      {draft.caveats.length > 0 ? (
        <ul
          className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[var(--muted)]"
          aria-label="Caveats"
        >
          {draft.caveats.map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2 text-xs text-[var(--muted)]">
        Read it, check it, and answer in your own words. It is a starting point, not an answer.
      </p>
    </aside>
  );
}

/**
 * The system thinks this question repeats an earlier one.
 *
 * Shown as a SUGGESTION with the original's text alongside, because the
 * decision is the moderator's and they cannot make it from an id. Two buttons,
 * neither styled as the obvious click: merging archives an attendee's question,
 * and dismissing releases one the system had doubts about. Both deserve a
 * moment's thought, and a primary-coloured "Merge" would get pressed by reflex.
 *
 * The similarity is shown as a percentage so a 95% and a 62% read differently
 * — the detector is deliberately generous, and a moderator who knows that
 * treats a low score as "have a look" rather than "the machine is sure".
 */
function DuplicatePanel({
  suggestion,
  isBusy,
  onMerge,
  onDismiss,
}: {
  suggestion: DuplicateSuggestion;
  isBusy: boolean;
  onMerge: () => void;
  onDismiss: () => void;
}) {
  const percent = Math.round(suggestion.similarity * 100);

  return (
    <aside
      aria-label="Possible duplicate"
      className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
    >
      <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
        Possible duplicate · {percent}% similar to a {STATUS_LABEL[suggestion.status].toLowerCase()}{' '}
        question with {suggestion.upvoteCount} {suggestion.upvoteCount === 1 ? 'vote' : 'votes'}
      </p>

      {/* The original, as TEXT. React escapes it. */}
      <blockquote className="mt-1.5 border-l-2 border-amber-500/40 pl-2 leading-relaxed break-words whitespace-pre-wrap">
        {suggestion.body}
      </blockquote>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          isLoading={isBusy}
          loadingLabel="Merging"
          onClick={onMerge}
          title="Archive this question and move its votes onto the original"
        >
          Merge into that question
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isLoading={isBusy}
          loadingLabel="Dismissing"
          onClick={onDismiss}
        >
          Not a duplicate
        </Button>
      </div>
    </aside>
  );
}

/**
 * Why this question is where it is in the list.
 *
 * The single most useful thing a ranked queue can do is account for itself. A
 * moderator who cannot see why one question outranks another stops trusting the
 * order and falls back to sorting by time, which throws away the ranking
 * entirely.
 *
 * The numbers are computed here from the fields on the question using the same
 * shared function the server ordered by, so this is genuinely the arithmetic
 * that produced the position — not a plausible-looking reconstruction of it.
 *
 * A native <details> rather than a custom popover: correct keyboard behaviour,
 * correct screen-reader semantics, and no JavaScript.
 */
function RankExplanation({ question }: { question: QuestionResponse }) {
  const parts = explainRankScore({
    upvoteCount: question.upvoteCount,
    askedByCount: question.askedByCount,
    createdAt: question.createdAt,
    status: question.status,
    pinnedAt: question.pinnedAt,
  });

  const rows: Array<{ label: string; value: number; note: string }> = [
    {
      label: 'Support',
      value: parts.popularity,
      note: `${question.upvoteCount} ${question.upvoteCount === 1 ? 'vote' : 'votes'}, with diminishing returns`,
    },
    {
      label: 'Demand',
      value: parts.demand,
      note:
        question.askedByCount > 1
          ? `asked by ${question.askedByCount} people; merged duplicates count as askers`
          : 'asked once; grows when duplicates are merged in',
    },
    { label: 'Recency', value: parts.recency, note: 'newer questions start higher' },
    {
      label: 'Priority',
      value: parts.priority,
      note: question.pinnedAt ? 'pinned by an organizer' : 'not pinned',
    },
    {
      label: 'Status',
      value: parts.moderation,
      note: `${STATUS_LABEL[question.status].toLowerCase()} questions rank in their own band`,
    },
  ];

  return (
    <details className="group mt-3">
      <summary className="cursor-pointer list-none text-xs text-[var(--muted)] underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
        Why is this ranked here?
      </summary>

      <dl className="mt-2 space-y-1 rounded-md bg-current/5 p-3 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline gap-2">
            <dt className="w-16 shrink-0 font-medium">{row.label}</dt>
            <dd className="w-20 shrink-0 text-right tabular-nums">{formatPoints(row.value)}</dd>
            <dd className="text-[var(--muted)]">{row.note}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * Shows a component's contribution at a readable scale.
 *
 * The status band is measured in billions and recency in thousands, and neither
 * absolute figure means anything on its own — only the differences between
 * questions do. Printing the raw doubles would be accurate and useless, so
 * large values are summarised rather than spelled out.
 */
function formatPoints(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1_000) return value > 0 ? 'large boost' : 'lower band';

  return value.toFixed(2);
}

/**
 * "4 minutes ago", from the browser's own formatter.
 *
 * Recomputed on every render rather than driven by a timer: the queue already
 * re-renders when the counts poll returns, which is far more often than a
 * minute, so a timer would buy nothing and leak on unmount.
 */
function formatRelativeTime(value: Date): string {
  const seconds = Math.round((value.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];

  let amount = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(amount) < step) return formatter.format(Math.round(amount), unit);
    amount /= step;
  }

  return formatter.format(Math.round(amount), 'year');
}
