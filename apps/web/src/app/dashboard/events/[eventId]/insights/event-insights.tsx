'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type {
  AiStatusResponse,
  CategoryBreakdownResponse,
  EventInsightsResponse,
  EventResponse,
  EventSummaryResponse,
  InsightQuestion,
  QuestionStatus,
  TopicResponse,
} from '@eventq/contracts';
import { Alert, Button, Spinner } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  getAiStatus,
  getCategoryBreakdown,
  getEvent,
  getEventInsights,
  getLatestSummary,
  listTopics,
} from '@/lib/api-client/organizer';
import { AiLabel } from '../ai-panel';
import { TimelineChart } from './timeline-chart';

/**
 * Event Insights: what happened at an event, in two clearly separate parts.
 *
 *   1. MEASURED FACTS — counted from questions, votes and moderation records.
 *      Fetched from `/insights`, whose contract has no field a model could fill.
 *   2. AI INTERPRETATION — categories, topics and the summary that earlier AI
 *      runs stored. Fetched from `/ai/*`, shown in its own bordered section
 *      under an "AI-generated" label, each block with the model, the date and
 *      how many questions it actually covered.
 *
 * The split is the point of the page. An AI grouping presented in the same
 * typeface and box as a vote count would read as equally certain, and it is
 * not — so the two never share a card, and the AI section says in words what
 * it is before showing anything.
 *
 * This page calls no model. It only reads what is stored, so opening it costs
 * nothing. Generating the AI half is done from the AI panel on the moderation
 * page, where the cost is shown next to the button.
 */

interface AiInterpretation {
  status: AiStatusResponse;
  categories: CategoryBreakdownResponse;
  topics: TopicResponse[];
  summary: EventSummaryResponse | null;
}

export function EventInsights({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [event, setEvent] = useState<EventResponse | null>(null);
  const [insights, setInsights] = useState<EventInsightsResponse | null>(null);
  const [ai, setAi] = useState<AiInterpretation | null>(null);
  const [aiFailed, setAiFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);

      // The facts and the interpretation load independently: a failure on the
      // AI side must never take the measured numbers down with it.
      const [facts, eventResult, interpretation] = await Promise.allSettled([
        getEventInsights(eventId, signal),
        getEvent(eventId, signal),
        Promise.all([
          getAiStatus(eventId, signal),
          getCategoryBreakdown(eventId, signal),
          listTopics(eventId, signal),
          getLatestSummary(eventId, signal),
        ]),
      ]);
      if (signal?.aborted) return;

      if (facts.status === 'rejected') {
        const caught: unknown = facts.reason;
        if (caught instanceof ApiError && caught.httpStatus === 401) {
          router.replace(
            `/sign-in?next=${encodeURIComponent(`/dashboard/events/${eventId}/insights`)}`,
          );
          return;
        }
        // Missing and not-yours are one 404 on purpose; so is the response to it.
        if (caught instanceof ApiError && caught.httpStatus === 404) {
          router.replace('/dashboard');
          return;
        }
        setError('Could not load insights for this event.');
      } else {
        setInsights(facts.value);
      }

      if (eventResult.status === 'fulfilled') setEvent(eventResult.value);

      if (interpretation.status === 'fulfilled') {
        const [status, categories, topics, latest] = interpretation.value;
        setAi({ status, categories, topics, summary: latest.summary });
        setAiFailed(false);
      } else {
        setAiFailed(true);
      }

      setLoading(false);
    },
    [eventId, router],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-8 sm:px-5 sm:py-10">
      <Link
        href={`/dashboard/events/${eventId}`}
        className="text-sm font-medium text-brand-600 hover:underline dark:text-brand-300"
      >
        ← Back to moderation
      </Link>

      <header className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium tracking-wide text-brand-600 uppercase dark:text-brand-300">
            Event insights
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-balance sm:text-3xl">
            {event ? event.title : 'Loading…'}
          </h1>
          {insights ? (
            <p className="mt-1 text-xs text-[var(--muted)]">
              Counted {new Date(insights.computedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </header>

      {error ? (
        <Alert severity="error" className="mt-6">
          {error}
        </Alert>
      ) : null}

      {!insights && loading ? (
        <div className="mt-10 flex justify-center">
          <Spinner />
          <span className="sr-only">Loading insights</span>
        </div>
      ) : null}

      {insights ? <MeasuredFacts insights={insights} /> : null}

      {insights ? (
        <AiInterpretationSection
          eventId={eventId}
          ai={ai}
          failed={aiFailed}
          liveQuestions={liveCount(insights)}
        />
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Measured facts
// ---------------------------------------------------------------------------

function MeasuredFacts({ insights }: { insights: EventInsightsResponse }) {
  const { questions, engagement, highlights, duplicates, moderation, frequentTerms } = insights;

  return (
    <section aria-labelledby="facts-heading" className="mt-8">
      <h2 id="facts-heading" className="text-lg font-semibold">
        Measured facts
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Counted from the questions, votes and moderation decisions recorded for this event. Nothing
        in this section was generated by AI.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Questions submitted" value={questions.submitted} />
        <Stat label="Unanswered" value={questions.unanswered} hint="Approved, never answered" />
        <Stat
          label="Answer rate"
          value={questions.answerRate === null ? '—' : percent(questions.answerRate)}
          hint={questions.answerRate === null ? 'Nothing approved yet' : 'Of approved questions'}
        />
        <Stat
          label="People taking part"
          value={engagement.participants}
          hint={`${engagement.askers} asked · ${engagement.voters} voted`}
        />
      </dl>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <Card title="What happened to the questions">
          <StatusBreakdown byStatus={questions.byStatus} merged={questions.mergedAsDuplicate} />
          <p className="mt-3 text-sm">
            <span className="tabular-nums font-medium">{engagement.votes}</span>{' '}
            {engagement.votes === 1 ? 'vote' : 'votes'} cast
          </p>
        </Card>

        <Card title="Room's top question">
          {highlights.mostUpvoted ? (
            <QuestionLine question={highlights.mostUpvoted} />
          ) : (
            <Empty>No question has a vote yet.</Empty>
          )}
          {highlights.mostAsked ? (
            <>
              <h4 className="mt-4 text-xs font-medium text-[var(--muted)] uppercase">
                Asked by the most people
              </h4>
              <QuestionLine question={highlights.mostAsked} />
            </>
          ) : null}
        </Card>
      </div>

      <Card title="Follow-up list" className="mt-6">
        <p className="text-sm text-[var(--muted)]">
          Approved questions nobody answered, most supported first.
        </p>
        {highlights.unanswered.length > 0 ? (
          <ol className="mt-3 space-y-2">
            {highlights.unanswered.map((question) => (
              <li key={question.id}>
                <QuestionLine question={question} />
              </li>
            ))}
          </ol>
        ) : (
          <Empty>Every approved question was answered.</Empty>
        )}
        {questions.unanswered > highlights.unanswered.length ? (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Showing {highlights.unanswered.length} of {questions.unanswered}. The rest are on the
            Approved tab of the moderation page.
          </p>
        ) : null}
      </Card>

      <Card title="Questions over time" className="mt-6">
        <TimelineChart timeline={insights.timeline} />
      </Card>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <Card title="Same question, several people">
          <p className="text-sm">
            <span className="tabular-nums font-medium">{duplicates.groups}</span>{' '}
            {duplicates.groups === 1 ? 'question was' : 'questions were'} asked by more than one
            person.
          </p>
          {duplicates.largest.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {duplicates.largest.map((question) => (
                <li key={question.id}>
                  <QuestionLine question={question} />
                </li>
              ))}
            </ul>
          ) : null}
          {duplicates.awaitingReview > 0 ? (
            <p className="mt-3 text-xs text-[var(--muted)]">
              {duplicates.awaitingReview} possible{' '}
              {duplicates.awaitingReview === 1 ? 'duplicate is' : 'duplicates are'} still waiting
              for a moderator, and not counted until confirmed.
            </p>
          ) : null}
        </Card>

        <Card title="Moderation wait">
          {moderation.medianWaitSeconds !== null ? (
            <>
              <p className="text-2xl font-semibold tabular-nums">
                {duration(moderation.medianWaitSeconds)}
              </p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Typical (median) time from submitting to approval, across{' '}
                {moderation.moderatorApproved}{' '}
                {moderation.moderatorApproved === 1 ? 'question' : 'questions'} a moderator
                approved.
              </p>
            </>
          ) : (
            <Empty>
              {moderation.mode === 'POST'
                ? 'Questions went live as soon as they were sent, so nobody waited for approval.'
                : 'No question has been approved by a moderator yet.'}
            </Empty>
          )}
        </Card>
      </div>

      <Card title="Words that came up most" className="mt-6">
        <p className="text-sm text-[var(--muted)]">
          How many questions contain each word. This counts words, not meaning: it cannot tell what
          a question was really about, and one question can count toward several words.
        </p>
        {frequentTerms.terms.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {frequentTerms.terms.map((term) => (
              <ShareBar
                key={term.term}
                label={term.term}
                share={term.share}
                detail={`${term.questions} of ${frequentTerms.analysed}`}
              />
            ))}
          </ul>
        ) : (
          <Empty>No word appears in more than one question yet.</Empty>
        )}
        {frequentTerms.truncated ? (
          <p className="mt-2 text-xs text-[var(--muted)]">
            Counted over the newest {frequentTerms.analysed} questions.
          </p>
        ) : null}
      </Card>
    </section>
  );
}

const STATUS_ROWS: ReadonlyArray<{ status: QuestionStatus; label: string }> = [
  { status: 'ANSWERED', label: 'Answered' },
  { status: 'APPROVED', label: 'Approved, not answered' },
  { status: 'PENDING', label: 'Still waiting for review' },
  { status: 'REJECTED', label: 'Rejected' },
  { status: 'SPAM', label: 'Spam' },
];

function StatusBreakdown({
  byStatus,
  merged,
}: {
  byStatus: Record<QuestionStatus, number>;
  merged: number;
}) {
  const otherArchived = Math.max(0, byStatus.ARCHIVED - merged);

  return (
    <dl className="space-y-1 text-sm">
      {STATUS_ROWS.map(({ status, label }) => (
        <Row key={status} label={label} value={byStatus[status]} />
      ))}
      <Row label="Merged into another question" value={merged} />
      {otherArchived > 0 ? <Row label="Archived" value={otherArchived} /> : null}
    </dl>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI interpretation
// ---------------------------------------------------------------------------

function AiInterpretationSection({
  eventId,
  ai,
  failed,
  liveQuestions,
}: {
  eventId: string;
  ai: AiInterpretation | null;
  failed: boolean;
  liveQuestions: number;
}) {
  const hasAnything =
    ai !== null && (ai.categories.categorized > 0 || ai.topics.length > 0 || ai.summary !== null);

  return (
    <section
      aria-labelledby="ai-heading"
      className="mt-10 rounded-lg border-2 border-dashed border-violet-500/40 p-4 sm:p-5"
    >
      <h2 id="ai-heading" className="text-lg font-semibold">
        AI interpretation <AiLabel />
      </h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Produced by a language model reading the question text. These are interpretations, not
        measurements — a model can group or summarise questions wrongly. Check them against the
        questions before acting on them.
      </p>

      {failed ? (
        <Alert severity="error" className="mt-4">
          Could not load the AI interpretation. The measured facts above are unaffected.
        </Alert>
      ) : null}

      {ai && !hasAnything ? (
        <p className="mt-4 text-sm">
          Nothing has been generated for this event.{' '}
          {ai.status.availableOnServer
            ? 'AI is off by default; it can be switched on and run from the AI panel on the '
            : 'AI is not enabled on this server, so nothing can be generated. The AI panel is on the '}
          <Link
            href={`/dashboard/events/${eventId}`}
            className="font-medium text-brand-600 hover:underline dark:text-brand-300"
          >
            moderation page
          </Link>
          .
        </p>
      ) : null}

      {ai && ai.categories.categorized > 0 ? <CategoryBlock categories={ai.categories} /> : null}
      {ai && ai.topics.length > 0 ? (
        <TopicBlock topics={ai.topics} liveQuestions={liveQuestions} />
      ) : null}
      {ai?.summary ? <SummaryBlock summary={ai.summary} liveQuestions={liveQuestions} /> : null}
    </section>
  );
}

function CategoryBlock({ categories }: { categories: CategoryBreakdownResponse }) {
  const covered = categories.categorized;
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold">Questions by category</h3>
      <Provenance>
        A model placed {covered} of {covered + categories.uncategorized} current questions in one of
        eight fixed categories
        {categories.modelIds.length > 0 ? ` · ${categories.modelIds.join(', ')}` : ''}
        {categories.lastCategorizedAt
          ? ` · last run ${new Date(categories.lastCategorizedAt).toLocaleString()}`
          : ''}
      </Provenance>
      <ul className="mt-2 space-y-1.5">
        {categories.categories.map((entry) => (
          <ShareBar
            key={entry.category}
            label={entry.category}
            share={entry.questions / covered}
            detail={`${entry.questions} of ${covered} categorised`}
            tone="ai"
          />
        ))}
      </ul>
    </div>
  );
}

function TopicBlock({ topics, liveQuestions }: { topics: TopicResponse[]; liveQuestions: number }) {
  const grouped = topics.reduce((sum, topic) => sum + topic.questionCount, 0);
  const generatedAt = topics[0]?.generatedAt;

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold">Topics</h3>
      <Provenance>
        A model grouped {grouped} of {liveQuestions} current questions
        {generatedAt ? ` · ${new Date(generatedAt).toLocaleString()}` : ''}. Questions asked since
        then are in no topic.
      </Provenance>
      <ol className="mt-2 space-y-1.5">
        {topics.map((topic) => (
          <ShareBar
            key={topic.id}
            label={topic.label}
            share={liveQuestions === 0 ? 0 : topic.questionCount / liveQuestions}
            detail={`${topic.questionCount} ${topic.questionCount === 1 ? 'question' : 'questions'}`}
            tone="ai"
          />
        ))}
      </ol>
    </div>
  );
}

function SummaryBlock({
  summary,
  liveQuestions,
}: {
  summary: EventSummaryResponse;
  liveQuestions: number;
}) {
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold">
        {summary.kind === 'FINAL' ? 'Summary after the event' : 'Summary during the event'}
      </h3>
      <Provenance>
        Written by {summary.modelId} from {summary.questionCount} questions ·{' '}
        {new Date(summary.generatedAt).toLocaleString()}
        {liveQuestions > summary.questionCount
          ? ` · ${liveQuestions - summary.questionCount} newer questions are not in it`
          : ''}
      </Provenance>

      <p className="mt-2 font-medium">{summary.headline}</p>

      {summary.themes.length > 0 ? (
        <dl className="mt-3 space-y-2 text-sm">
          {summary.themes.map((theme) => (
            <div key={theme.title}>
              <dt className="font-medium">{theme.title}</dt>
              <dd className="text-[var(--muted)]">{theme.description}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {summary.suggestedFollowUps.length > 0 ? (
        <>
          <h4 className="mt-3 text-xs font-medium text-[var(--muted)] uppercase">
            Suggested follow-ups
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {summary.suggestedFollowUps.map((followUp) => (
              <li key={followUp}>{followUp}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Provenance({ children }: { children: React.ReactNode }) {
  return <p className="mt-0.5 text-xs text-[var(--muted)]">{children}</p>;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] p-3">
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-[var(--muted)]">{hint}</dd> : null}
    </div>
  );
}

function Card({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border border-[var(--border)] p-4 ${className ?? ''}`}>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function QuestionLine({ question }: { question: InsightQuestion }) {
  return (
    <div className="rounded-md bg-current/5 px-3 py-2 text-sm">
      <p className="break-words">{question.body}</p>
      <p className="mt-0.5 text-xs text-[var(--muted)] tabular-nums">
        {question.upvoteCount} {question.upvoteCount === 1 ? 'vote' : 'votes'}
        {question.askedByCount > 1 ? ` · asked by ${question.askedByCount} people` : ''}
        {question.status === 'ANSWERED' ? ' · answered' : ''}
      </p>
    </div>
  );
}

/**
 * A labelled proportion. The number is always written out beside the bar:
 * the bar shows the shape at a glance, the text is what gets read and quoted.
 */
function ShareBar({
  label,
  share,
  detail,
  tone = 'fact',
}: {
  label: string;
  share: number;
  detail: string;
  tone?: 'fact' | 'ai';
}) {
  return (
    <li className="text-sm">
      <div className="flex justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{label}</span>
        <span className="shrink-0 tabular-nums text-[var(--muted)]">
          {percent(share)} · {detail}
        </span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-current/10" aria-hidden="true">
        <div
          className={`h-full rounded-full ${tone === 'ai' ? 'bg-violet-500 dark:bg-violet-400' : 'bg-brand-500 dark:bg-brand-300'}`}
          style={{ width: `${Math.max(1, Math.round(share * 100))}%` }}
        />
      </div>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[var(--muted)]">{children}</p>;
}

function liveCount(insights: EventInsightsResponse): number {
  const { byStatus } = insights.questions;
  return byStatus.PENDING + byStatus.APPROVED + byStatus.ANSWERED;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
