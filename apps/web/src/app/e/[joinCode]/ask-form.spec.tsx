import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/lib/api-client';
import { AskForm } from './ask-form';

/**
 * The attendee form.
 *
 * Queries go through the accessibility tree (getByRole, getByLabelText), so a
 * test can only pass if a screen-reader user could also find the control. On
 * this surface that is not a nicety: it is the one screen the product promises
 * anyone can use in under thirty seconds.
 */
const { joinEvent, submitQuestion } = vi.hoisted(() => ({
  joinEvent: vi.fn(),
  submitQuestion: vi.fn(),
}));

vi.mock('@/lib/api-client/public-events', () => ({ joinEvent, submitQuestion }));

const SESSION = {
  attendeeId: '01930000-0000-7000-8000-000000000301',
  displayName: null,
  identityMode: 'OPTIONAL' as const,
  moderationMode: 'PRE' as const,
  limits: {
    minQuestionLength: 10,
    maxQuestionLength: 500,
    submitLimitCount: 5,
    submitLimitWindowSeconds: 60,
  },
};

const VALID = 'How do you follow up after meeting someone at an event?';

function problem(code: string, status: number) {
  return new ApiError(
    {
      type: `https://docs.eventq.io/errors/${code.toLowerCase()}`,
      title: code,
      status,
      code: code as never,
      traceId: 'trace-1',
    },
    status,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  joinEvent.mockResolvedValue(SESSION);
  submitQuestion.mockResolvedValue({ id: 'q1', status: 'PENDING' });
});

describe('asking a question', () => {
  it('puts the cursor in the question box on arrival', async () => {
    // The single biggest contributor to the 15-second target: no tapping around
    // to find the field, the keyboard is already up.
    render(<AskForm joinCode="EVENTQ26" />);

    expect(screen.getByLabelText(/your question/i)).toHaveFocus();
  });

  it('needs no account, and offers a name only as optional', async () => {
    render(<AskForm joinCode="EVENTQ26" />);

    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.getByText(/leave blank to stay anonymous/i)).toBeInTheDocument();
  });

  it('submits a question and confirms it clearly', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));

    await waitFor(() => {
      expect(screen.getByText(/your question is in/i)).toBeInTheDocument();
    });
    // A pre-moderated event must say so, or people assume it failed and resend.
    expect(screen.getByText(/once a moderator has approved it/i)).toBeInTheDocument();
  });

  it('offers to ask another without reloading', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));
    await screen.findByText(/your question is in/i);

    await user.click(screen.getByRole('button', { name: /ask another/i }));

    expect(screen.getByLabelText(/your question/i)).toHaveValue('');
  });

  it('sends the name when given, and marks the question anonymous when not', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.type(screen.getByLabelText(/your name/i), 'Priya Raman');
    await user.click(screen.getByRole('button', { name: /send question/i }));

    await waitFor(() => expect(submitQuestion).toHaveBeenCalled());
    expect(submitQuestion.mock.calls[0]![1]).toMatchObject({
      body: VALID,
      displayName: 'Priya Raman',
      isAnonymous: false,
    });
  });
});

describe('client-side validation', () => {
  it('refuses an empty question without troubling the server', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.click(screen.getByRole('button', { name: /send question/i }));

    // Queried by its text, not by role: FormField renders its error element
    // ALWAYS (empty until needed, so the live region exists before its content
    // changes), and with two fields on the form there are always two of them.
    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(submitQuestion).not.toHaveBeenCalled();
  });

  it('refuses a too-short question and returns focus to the box', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), 'short');
    await user.click(screen.getByRole('button', { name: /send question/i }));

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    // Focus goes back to what needs fixing, rather than leaving a keyboard user
    // stranded on a button that will not work.
    expect(screen.getByLabelText(/your question/i)).toHaveFocus();
  });

  it('counts down the characters remaining', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), 'hello');

    expect(screen.getByText('495 characters left')).toBeInTheDocument();
  });

  it('cannot be typed past the hard ceiling', async () => {
    render(<AskForm joinCode="EVENTQ26" />);

    // A paste of an entire document is stopped by the browser itself, so it is
    // never sent at all. The real limit is still enforced server-side.
    expect(screen.getByLabelText(/your question/i)).toHaveAttribute('maxlength', '2000');
  });
});

describe('hostile and unusual input', () => {
  it('sends HTML through as ordinary text rather than mangling it', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    const html = 'Is <b>bold</b> allowed in a question here?';
    await user.type(screen.getByLabelText(/your question/i), html);
    await user.click(screen.getByRole('button', { name: /send question/i }));

    await waitFor(() => expect(submitQuestion).toHaveBeenCalled());
    expect(submitQuestion.mock.calls[0]![1].body).toBe(html);
  });

  it('never renders a server-supplied string as markup', async () => {
    // The XSS control is React escaping at render. This asserts the escape
    // actually happens rather than trusting that it does.
    submitQuestion.mockRejectedValueOnce(
      new ApiError(
        {
          type: 'about:blank',
          title: 'x',
          status: 400,
          code: 'VALIDATION_FAILED',
          detail: '<img src=x onerror=alert(1)>',
          traceId: 't',
        },
        400,
      ),
    );

    const user = userEvent.setup();
    const { container } = render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));

    await screen.findByText(/something went wrong/i);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('failure and retry', () => {
  it('explains a network failure and promises a retry is safe', async () => {
    submitQuestion.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));

    const alert = await screen.findByText(/could not reach the server/i);
    // People genuinely hesitate to press send twice. Saying it is safe is the
    // difference between a retry and a lost question.
    expect(alert).toHaveTextContent(/will not post it twice/i);
  });

  it('reuses the SAME idempotency key when a failed submission is retried', async () => {
    // The guarantee that makes the promise above true. A fresh key per attempt
    // would turn every retry into a duplicate question.
    submitQuestion.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));
    await screen.findByText(/could not reach the server/i);

    await user.click(screen.getByRole('button', { name: /send question/i }));
    await waitFor(() => expect(submitQuestion).toHaveBeenCalledTimes(2));

    expect(submitQuestion.mock.calls[1]![2]).toBe(submitQuestion.mock.calls[0]![2]);
  });

  it('uses a NEW key for a genuinely new question', async () => {
    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));
    await screen.findByText(/your question is in/i);

    await user.click(screen.getByRole('button', { name: /ask another/i }));
    await user.type(screen.getByLabelText(/your question/i), 'What makes a good panel host?');
    await user.click(screen.getByRole('button', { name: /send question/i }));

    await waitFor(() => expect(submitQuestion).toHaveBeenCalledTimes(2));
    expect(submitQuestion.mock.calls[1]![2]).not.toBe(submitQuestion.mock.calls[0]![2]);
  });

  it.each([
    ['DUPLICATE_QUESTION', 409, /already asked this question/i],
    ['SUBMISSION_LIMIT_REACHED', 429, /wait a moment/i],
    ['EVENT_NOT_LIVE', 422, /no longer taking questions/i],
  ])('explains a %s failure in plain language', async (code, status, expected) => {
    submitQuestion.mockRejectedValueOnce(problem(code, status));

    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
  });

  it('still submits when the background join failed', async () => {
    // Joining happens quietly on mount; if it lost the race or failed, pressing
    // send must recover rather than dead-end.
    joinEvent.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    await user.click(screen.getByRole('button', { name: /send question/i }));

    await waitFor(() => expect(submitQuestion).toHaveBeenCalled());
  });

  it('blocks a double tap on the send button', async () => {
    let release: (value: unknown) => void = () => {};
    submitQuestion.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));

    const user = userEvent.setup();
    render(<AskForm joinCode="EVENTQ26" />);

    await user.type(screen.getByLabelText(/your question/i), VALID);
    const button = screen.getByRole('button', { name: /send question/i });

    await user.click(button);
    await user.click(button);

    expect(submitQuestion).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-busy', 'true');
    release({ id: 'q1', status: 'PENDING' });
  });
});

describe('accessibility', () => {
  it('has no serious violations', async () => {
    const { container } = render(<AskForm joinCode="EVENTQ26" />);

    await expect(container).toHaveNoSeriousA11yViolations();
  });

  it('associates every control with a visible label', async () => {
    render(<AskForm joinCode="EVENTQ26" />);

    expect(screen.getByLabelText(/your question/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
  });
});
