import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QUESTION_BODY_HARD_MAX } from '@eventq/contracts';
import { AskForm } from './ask-form';
import { AttendeeSessionProvider } from './attendee-session';

/**
 * Speaking a question instead of typing it.
 *
 * jsdom has no speech recognizer, so a fake stands in for the browser's. Tests
 * drive it the way the browser would: results arrive while listening, then
 * `onend` fires.
 */
const { joinEvent, submitQuestion } = vi.hoisted(() => ({
  joinEvent: vi.fn(),
  submitQuestion: vi.fn(),
}));

vi.mock('@/lib/api-client/public-events', () => ({ joinEvent, submitQuestion }));

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  interimResults = false;
  continuous = true;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();

  constructor() {
    FakeRecognition.last = this;
  }

  /** What the browser sends: one result, final or still being heard. */
  hear(transcript: string, isFinal: boolean) {
    const result = Object.assign([{ transcript }], { isFinal });
    act(() => this.onresult?.({ resultIndex: 0, results: [result] }));
  }

  fail(error: string) {
    act(() => {
      this.onerror?.({ error });
      this.onend?.();
    });
  }

  finish() {
    act(() => this.onend?.());
  }
}

function renderForm() {
  return render(
    <AttendeeSessionProvider joinCode="EVENTQ26">
      <AskForm joinCode="EVENTQ26" />
    </AttendeeSessionProvider>,
  );
}

function recognizer(): FakeRecognition {
  if (!FakeRecognition.last) throw new Error('Recognition was never started');
  return FakeRecognition.last;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeRecognition.last = null;
  joinEvent.mockResolvedValue({
    attendeeId: '01930000-0000-7000-8000-000000000301',
    displayName: null,
    identityMode: 'OPTIONAL',
    moderationMode: 'PRE',
    limits: {
      minQuestionLength: 10,
      maxQuestionLength: 500,
      submitLimitCount: 5,
      submitLimitWindowSeconds: 60,
    },
  });
});

afterEach(() => {
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe('speech input', () => {
  it('shows no mic button where the browser cannot transcribe (Firefox)', async () => {
    renderForm();

    await screen.findByLabelText(/your question/i);
    expect(screen.queryByRole('button', { name: /speak/i })).not.toBeInTheDocument();
  });

  describe('where the browser can transcribe', () => {
    beforeEach(() => {
      (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
    });

    it('offers a mic button and says where the audio goes', async () => {
      renderForm();

      expect(await screen.findByRole('button', { name: /speak your question/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      expect(screen.getByText(/audio is sent to google/i)).toBeInTheDocument();
    });

    it("listens in the phone's own language, one phrase per tap", async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(await screen.findByRole('button', { name: /speak your question/i }));

      expect(recognizer().lang).toBe(navigator.language);
      expect(recognizer().continuous).toBe(false);
      expect(recognizer().start).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: /stop listening/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });

    it('shows words while they are heard, then adds them after the typed text', async () => {
      const user = userEvent.setup();
      renderForm();
      const box = screen.getByLabelText(/your question/i);

      await user.type(box, 'Quick one:');
      await user.click(await screen.findByRole('button', { name: /speak your question/i }));

      recognizer().hear('how do you', false);
      expect(screen.getByRole('status')).toHaveTextContent('how do you');

      recognizer().hear('how do you price workshops', true);
      recognizer().finish();

      expect(box).toHaveValue('Quick one: how do you price workshops');
      expect(screen.getByRole('button', { name: /speak your question/i })).toBeInTheDocument();
    });

    it('sends a spoken question exactly like a typed one', async () => {
      const user = userEvent.setup();
      submitQuestion.mockResolvedValue({ id: 'q1', status: 'PENDING' });
      renderForm();

      await user.click(await screen.findByRole('button', { name: /speak your question/i }));
      recognizer().hear('How do you price a workshop for beginners?', true);
      recognizer().finish();
      await user.click(screen.getByRole('button', { name: /send question/i }));

      await screen.findByText(/your question is in/i);
      expect(submitQuestion).toHaveBeenCalledWith(
        'EVENTQ26',
        expect.objectContaining({ body: 'How do you price a workshop for beginners?' }),
        expect.any(String),
      );
    });

    it('explains a blocked microphone, and typing still works', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(await screen.findByRole('button', { name: /speak your question/i }));
      recognizer().fail('not-allowed');

      expect(screen.getByRole('status')).toHaveTextContent(/microphone is blocked/i);
      await user.type(screen.getByLabelText(/your question/i), 'Typed instead');
      expect(screen.getByLabelText(/your question/i)).toHaveValue('Typed instead');
    });

    it('never lets speech push the text past the hard limit', async () => {
      const user = userEvent.setup();
      renderForm();

      await user.click(await screen.findByRole('button', { name: /speak your question/i }));
      recognizer().hear('word '.repeat(QUESTION_BODY_HARD_MAX), true);
      recognizer().finish();

      expect(
        (screen.getByLabelText(/your question/i) as HTMLTextAreaElement).value.length,
      ).toBeLessThanOrEqual(QUESTION_BODY_HARD_MAX);
    });
  });
});
