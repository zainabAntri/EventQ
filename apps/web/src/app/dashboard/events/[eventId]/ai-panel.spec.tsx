import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiStatusResponse } from '@eventq/contracts';
import { ApiError } from '@/lib/api-client';
import { AiPanel } from './ai-panel';

/**
 * The AI panel: the organizer's switch and their bill.
 *
 * What these tests protect is the promise that nothing runs without a click
 * and nothing costs money the organizer was not shown. Every button is
 * asserted to be absent, disabled or offered depending on the switches, and
 * every result is asserted to say what it cost.
 */
const {
  getAiStatus,
  listTopics,
  getLatestSummary,
  runCategorize,
  runCluster,
  runSummary,
  updateEvent,
} = vi.hoisted(() => ({
  getAiStatus: vi.fn(),
  listTopics: vi.fn(),
  getLatestSummary: vi.fn(),
  runCategorize: vi.fn(),
  runCluster: vi.fn(),
  runSummary: vi.fn(),
  updateEvent: vi.fn(),
}));

vi.mock('@/lib/api-client/organizer', () => ({
  getAiStatus,
  listTopics,
  getLatestSummary,
  runCategorize,
  runCluster,
  runSummary,
  updateEvent,
}));

const EVENT_ID = '01930000-0000-7000-8000-0000000000e1';

function status(overrides: Partial<AiStatusResponse> = {}): AiStatusResponse {
  return {
    availableOnServer: true,
    enabledForEvent: true,
    eventSpendMicros: 150_000,
    eventBudgetMicros: 2_000_000,
    monthlySpendMicros: 900_000,
    monthlyBudgetMicros: 50_000_000,
    callsByFeature: {
      CLASSIFICATION: 2,
      DEDUPLICATION: 0,
      CLUSTERING: 1,
      ANSWER_SUGGESTION: 0,
      SUMMARIZATION: 0,
    },
    models: {
      CLASSIFICATION: 'claude-haiku-4-5',
      DEDUPLICATION: 'claude-haiku-4-5',
      CLUSTERING: 'claude-sonnet-5',
      ANSWER_SUGGESTION: 'claude-sonnet-5',
      SUMMARIZATION: 'claude-sonnet-5',
    },
    ...overrides,
  };
}

const USAGE = {
  modelId: 'claude-haiku-4-5',
  inputTokens: 500,
  outputTokens: 80,
  costMicros: 900,
  cached: false,
};

async function renderOpen() {
  const onQuestionsChanged = vi.fn();
  render(<AiPanel eventId={EVENT_ID} onQuestionsChanged={onQuestionsChanged} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Show' }));
  return { onQuestionsChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAiStatus.mockResolvedValue(status());
  listTopics.mockResolvedValue([]);
  getLatestSummary.mockResolvedValue({ summary: null });
});

describe('the switches', () => {
  it('offers nothing when AI is off at the server, and says why', async () => {
    getAiStatus.mockResolvedValue(status({ availableOnServer: false, enabledForEvent: false }));
    await renderOpen();

    expect(screen.getByText(/not enabled on this server/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is sent to any ai provider/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /categorise|group|summarise|turn ai/i }),
    ).not.toBeInTheDocument();
  });

  it('disables every action while the event switch is off', async () => {
    getAiStatus.mockResolvedValue(status({ enabledForEvent: false }));
    await renderOpen();

    expect(screen.getByRole('button', { name: /turn ai on/i })).toBeInTheDocument();
    for (const name of [/categorise/i, /group into topics/i, /summarise/i]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('turns AI on for the event through the event settings, and only there', async () => {
    getAiStatus.mockResolvedValue(status({ enabledForEvent: false }));
    updateEvent.mockResolvedValue({});
    await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /turn ai on/i }));

    expect(updateEvent).toHaveBeenCalledWith(EVENT_ID, { settings: { aiEnabled: true } });
    // Switching on runs nothing.
    expect(runCategorize).not.toHaveBeenCalled();
    expect(runCluster).not.toHaveBeenCalled();
    expect(runSummary).not.toHaveBeenCalled();
    expect(await screen.findByText(/nothing runs until you press a button/i)).toBeInTheDocument();
  });
});

describe('the bill', () => {
  it('shows spend against both caps before any button', async () => {
    await renderOpen();

    expect(screen.getByText(/\$0\.15 of \$2\.00 cap/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.90 of \$50\.00 cap/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: /event ai budget/i })).toHaveAttribute(
      'aria-valuenow',
      '8',
    );
  });

  it('names the model a button would use', async () => {
    await renderOpen();

    expect(screen.getByRole('button', { name: /categorise/i })).toHaveAttribute(
      'title',
      expect.stringContaining('claude-haiku-4-5'),
    );
    expect(screen.getByRole('button', { name: /summarise/i })).toHaveAttribute(
      'title',
      expect.stringContaining('claude-sonnet-5'),
    );
  });
});

describe('running a feature', () => {
  it('categorises on request and reports the count and the cost', async () => {
    runCategorize.mockResolvedValue({ categorized: 12, rejected: 1, remaining: 0, usage: USAGE });
    const { onQuestionsChanged } = await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /categorise/i }));

    expect(runCategorize).toHaveBeenCalledWith(EVENT_ID);
    expect(await screen.findByRole('status')).toHaveTextContent(/12 categorised, 1 rejected/);
    expect(screen.getByRole('status')).toHaveTextContent(/Cost \$0\.00 \(claude-haiku-4-5\)/);
    expect(onQuestionsChanged).toHaveBeenCalled();
  });

  it('says when a result came from the cache at no cost', async () => {
    runCategorize.mockResolvedValue({
      categorized: 3,
      rejected: 0,
      remaining: 0,
      usage: { ...USAGE, cached: true, costMicros: 0 },
    });
    await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /categorise/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/Served from cache, no cost/);
  });

  it('shows the topics after grouping, labelled as AI-generated', async () => {
    runCluster.mockResolvedValue({ topics: [], unclustered: 0, usage: USAGE });
    listTopics.mockResolvedValueOnce([]).mockResolvedValue([
      {
        id: '01930000-0000-7000-8000-00000000cccc',
        label: 'AI adoption',
        summary: 'How to start with AI.',
        questionCount: 4,
        questionIds: [],
      },
    ]);
    await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /group into topics/i }));

    expect(await screen.findByText('AI adoption')).toBeInTheDocument();
    expect(screen.getByText('4 questions')).toBeInTheDocument();
    expect(screen.getAllByText('AI-generated').length).toBeGreaterThan(0);
  });

  it('shows the summary, labelled, with its model and question count', async () => {
    const summary = {
      id: '01930000-0000-7000-8000-00000000dddd',
      kind: 'LIVE' as const,
      headline: 'The room wanted practical AI advice.',
      themes: [{ title: 'AI', description: 'Getting started.', questionIds: ['a'] }],
      notableQuestions: [
        { questionId: 'b', status: 'APPROVED' as const, why: 'Hiring is the blocker.' },
      ],
      suggestedFollowUps: ['Share a starter checklist.'],
      questionCount: 17,
      modelId: 'claude-sonnet-5',
      generatedAt: '2026-09-18T10:00:00.000Z',
      usage: null,
    };
    runSummary.mockResolvedValue(summary);
    getLatestSummary.mockResolvedValueOnce({ summary: null }).mockResolvedValue({ summary });
    await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /summarise/i }));

    expect(await screen.findByText('The room wanted practical AI advice.')).toBeInTheDocument();
    const heading = screen.getByRole('heading', { name: /summary so far/i });
    expect(within(heading).getByText('AI-generated')).toBeInTheDocument();
    expect(screen.getByText(/From 17 questions · claude-sonnet-5/)).toBeInTheDocument();
    expect(screen.getByText('Hiring is the blocker.')).toBeInTheDocument();
    expect(screen.getByText('Share a starter checklist.')).toBeInTheDocument();
  });

  it('shows a budget refusal in the organizer’s words', async () => {
    runSummary.mockRejectedValue(
      new ApiError(
        {
          type: 'https://docs.eventq.io/errors/ai_budget_exceeded',
          title: 'Unprocessable',
          status: 422,
          code: 'AI_BUDGET_EXCEEDED',
          detail:
            'This event has reached its AI budget ($2.00). No further AI calls will be made for it.',
          traceId: 't',
        },
        422,
      ),
    );
    await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /summarise/i }));

    expect(await screen.findByText(/reached its AI budget/)).toBeInTheDocument();
  });

  it('blocks a second click while one action is running', async () => {
    let release: (value: unknown) => void = () => {};
    runCluster.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    await renderOpen();

    await userEvent.click(screen.getByRole('button', { name: /group into topics/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /summarise/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /categorise/i })).toBeDisabled();
    release({ topics: [], unclustered: 0, usage: null });
  });
});
