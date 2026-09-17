'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  AiStatusResponse,
  EventSummaryResponse,
  QuestionStatus,
  TopicResponse,
} from '@eventq/contracts';
import { Alert, Button } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  getAiStatus,
  getLatestSummary,
  listTopics,
  runCategorize,
  runCluster,
  runSummary,
  updateEvent,
} from '@/lib/api-client/organizer';
import { cn } from '@/lib/cn';

/**
 * The AI panel: the organizer's switch, their bill, and three buttons.
 *
 * Built around one rule: nothing here runs on its own, and nothing here
 * costs money the organizer has not been shown first. The spend and the cap
 * sit above the buttons, every result reports what it cost, and the switch
 * is theirs. When AI is off at the server the panel says so and offers
 * nothing — a row of buttons that would only fail invites confusion.
 *
 * Everything the panel shows that a model produced is labelled as such. An
 * AI summary looks like an AI summary, not like a note from a colleague.
 */

export interface AiPanelProps {
  eventId: string;
  /** Called after any run that changed questions, so the queue can refresh. */
  onQuestionsChanged: () => void;
}

type Busy = 'toggle' | 'categorize' | 'cluster' | 'summary' | null;

export function AiPanel({ eventId, onQuestionsChanged }: AiPanelProps) {
  const [status, setStatus] = useState<AiStatusResponse | null>(null);
  const [topics, setTopics] = useState<TopicResponse[]>([]);
  const [summary, setSummary] = useState<EventSummaryResponse | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const reload = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      try {
        const [nextStatus, nextTopics, latest] = await Promise.all([
          getAiStatus(eventId, signal),
          listTopics(eventId, signal),
          getLatestSummary(eventId, signal),
        ]);
        setStatus(nextStatus);
        setTopics(nextTopics);
        setSummary(latest.summary);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(messageFor(caught));
      }
    },
    [eventId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const run = useCallback(
    async (what: Exclude<Busy, null>, action: () => Promise<string>): Promise<void> => {
      setBusy(what);
      setError(null);
      setNotice(null);
      try {
        setNotice(await action());
        await reload();
      } catch (caught) {
        setError(messageFor(caught));
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const toggle = () =>
    run('toggle', async () => {
      const next = !status?.enabledForEvent;
      await updateEvent(eventId, { settings: { aiEnabled: next } });
      return next
        ? 'AI is on for this event. Nothing runs until you press a button below.'
        : 'AI is off for this event.';
    });

  const categorize = () =>
    run('categorize', async () => {
      const result = await runCategorize(eventId);
      onQuestionsChanged();
      if (result.usage === null) return 'Every question already has a category.';
      return `${result.categorized} categorised${result.rejected ? `, ${result.rejected} rejected` : ''}${
        result.remaining ? `, ${result.remaining} still to do — press again` : ''
      }. ${describeUsage(result.usage)}`;
    });

  const cluster = () =>
    run('cluster', async () => {
      const result = await runCluster(eventId);
      onQuestionsChanged();
      if (result.usage === null) return 'Not enough questions to group yet.';
      return `${result.topics.length} ${result.topics.length === 1 ? 'topic' : 'topics'}, ${result.unclustered} left ungrouped. ${describeUsage(result.usage)}`;
    });

  const summarize = () =>
    run('summary', async () => {
      const result = await runSummary(eventId);
      return `Summary of ${result.questionCount} questions ready.${result.usage ? ` ${describeUsage(result.usage)}` : ''}`;
    });

  if (!status) return null;

  const available = status.availableOnServer;
  const enabled = available && status.enabledForEvent;
  const eventPercent = Math.min(
    100,
    Math.round((status.eventSpendMicros / Math.max(1, status.eventBudgetMicros)) * 100),
  );

  return (
    <section
      aria-labelledby="ai-panel-heading"
      className="mt-6 rounded-lg border border-[var(--border)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="ai-panel-heading" className="text-base font-semibold">
          AI assistance
          <span className="ml-2 rounded-full border border-current/20 px-2 py-0.5 text-xs font-normal text-[var(--muted)]">
            optional
          </span>
        </h2>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="ai-panel-body"
          className="text-sm text-[var(--muted)] underline decoration-dotted underline-offset-2"
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open ? (
        <div id="ai-panel-body" className="mt-4 space-y-4">
          {!available ? (
            <p className="text-sm text-[var(--muted)]">
              AI features are not enabled on this server, so this event cannot use them. Nothing is
              sent to any AI provider.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  variant={status.enabledForEvent ? 'outline' : 'primary'}
                  isLoading={busy === 'toggle'}
                  loadingLabel="Saving"
                  onClick={toggle}
                  aria-pressed={status.enabledForEvent}
                >
                  {status.enabledForEvent
                    ? 'Turn AI off for this event'
                    : 'Turn AI on for this event'}
                </Button>
                <p className="text-xs text-[var(--muted)]">
                  {status.enabledForEvent
                    ? 'On. Each button below makes one model call and shows what it cost.'
                    : 'Off. Nothing is sent to an AI provider for this event.'}
                </p>
              </div>

              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="font-medium">This event</dt>
                  <dd className="tabular-nums text-[var(--muted)]">
                    {dollars(status.eventSpendMicros)} of {dollars(status.eventBudgetMicros)} cap
                    <span
                      role="progressbar"
                      aria-label="Event AI budget used"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={eventPercent}
                      className="mt-1 block h-1.5 w-full overflow-hidden rounded bg-current/10"
                    >
                      <span
                        className={cn(
                          'block h-full',
                          eventPercent >= 90 ? 'bg-red-500' : 'bg-brand-600',
                        )}
                        style={{ width: `${eventPercent}%` }}
                      />
                    </span>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">This month, all events</dt>
                  <dd className="tabular-nums text-[var(--muted)]">
                    {dollars(status.monthlySpendMicros)} of {dollars(status.monthlyBudgetMicros)}{' '}
                    cap
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!enabled || busy !== null}
                  isLoading={busy === 'categorize'}
                  loadingLabel="Categorising"
                  onClick={categorize}
                  title={`Uses ${status.models.CLASSIFICATION}. Up to 50 questions per press.`}
                >
                  Categorise questions
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!enabled || busy !== null}
                  isLoading={busy === 'cluster'}
                  loadingLabel="Grouping"
                  onClick={cluster}
                  title={`Uses ${status.models.CLUSTERING}. Up to 200 questions.`}
                >
                  Group into topics
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!enabled || busy !== null}
                  isLoading={busy === 'summary'}
                  loadingLabel="Summarising"
                  onClick={summarize}
                  title={`Uses ${status.models.SUMMARIZATION}. Up to 200 questions.`}
                >
                  Summarise the event
                </Button>
              </div>
            </>
          )}

          {notice ? (
            <p role="status" className="text-sm">
              {notice}
            </p>
          ) : null}
          {error ? (
            <Alert severity="error" title="That did not run">
              {error}
            </Alert>
          ) : null}

          {topics.length > 0 ? <TopicList topics={topics} /> : null}
          {summary ? <SummaryView summary={summary} /> : null}
        </div>
      ) : null}
    </section>
  );
}

function TopicList({ topics }: { topics: TopicResponse[] }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">
        Topics <AiLabel />
      </h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {topics.map((topic) => (
          <li key={topic.id} className="rounded-md bg-current/5 px-3 py-2">
            <span className="font-medium">{topic.label}</span>
            <span className="ml-2 tabular-nums text-[var(--muted)]">
              {topic.questionCount} {topic.questionCount === 1 ? 'question' : 'questions'}
            </span>
            {topic.summary ? (
              <p className="mt-0.5 text-xs text-[var(--muted)]">{topic.summary}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STATUS_WORD: Readonly<Record<QuestionStatus, string>> = {
  PENDING: 'waiting',
  APPROVED: 'approved',
  ANSWERED: 'answered',
  REJECTED: 'rejected',
  SPAM: 'spam',
  ARCHIVED: 'archived',
};

function SummaryView({ summary }: { summary: EventSummaryResponse }) {
  return (
    <div className="rounded-md border border-[var(--border)] p-3 text-sm">
      <h3 className="text-sm font-semibold">
        {summary.kind === 'FINAL' ? 'Final summary' : 'Summary so far'} <AiLabel />
      </h3>
      <p className="mt-1 text-xs text-[var(--muted)]">
        From {summary.questionCount} questions · {summary.modelId} ·{' '}
        {new Date(summary.generatedAt).toLocaleString()}
      </p>

      <p className="mt-3 font-medium">{summary.headline}</p>

      {summary.themes.length > 0 ? (
        <dl className="mt-3 space-y-2">
          {summary.themes.map((theme) => (
            <div key={theme.title}>
              <dt className="font-medium">
                {theme.title}
                <span className="ml-2 text-xs font-normal text-[var(--muted)]">
                  {theme.questionIds.length}{' '}
                  {theme.questionIds.length === 1 ? 'question' : 'questions'}
                </span>
              </dt>
              <dd className="text-[var(--muted)]">{theme.description}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {summary.notableQuestions.length > 0 ? (
        <div className="mt-3">
          <p className="font-medium">Worth a look</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--muted)]">
            {summary.notableQuestions.map((item) => (
              <li key={item.questionId}>
                {item.why} <span className="text-xs">({STATUS_WORD[item.status]})</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary.suggestedFollowUps.length > 0 ? (
        <div className="mt-3">
          <p className="font-medium">Suggested follow-ups</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[var(--muted)]">
            {summary.suggestedFollowUps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The label every AI-produced thing carries. Text, so a screen reader hears it. */
export function AiLabel() {
  return (
    <span className="ml-1 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 align-middle text-[10px] font-medium tracking-wide text-violet-700 uppercase dark:text-violet-300">
      AI-generated
    </span>
  );
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function describeUsage(usage: { costMicros: number; cached: boolean; modelId: string }): string {
  if (usage.cached) return 'Served from cache, no cost.';
  return `Cost ${dollars(usage.costMicros)} (${usage.modelId}).`;
}

function messageFor(caught: unknown): string {
  if (!(caught instanceof ApiError)) return 'Could not reach the server.';
  switch (caught.code) {
    case 'AI_DISABLED':
    case 'AI_BUDGET_EXCEEDED':
    case 'AI_PROVIDER_ERROR':
    case 'AI_BUSY':
      return caught.problem.detail ?? caught.problem.title;
    case 'FORBIDDEN':
      return 'Your role does not allow running AI features.';
    default:
      return caught.problem.detail ?? 'Something went wrong.';
  }
}
