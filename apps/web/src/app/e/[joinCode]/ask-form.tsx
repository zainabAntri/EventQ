'use client';

import { useCallback, useRef, useState } from 'react';
import {
  ATTENDEE_NAME_MAX,
  countCharacters,
  QUESTION_BODY_HARD_MAX,
  type AttendeeSessionResponse,
} from '@eventq/contracts';
import { Alert, Button, FormField, Input, Label, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { submitQuestion } from '@/lib/api-client/public-events';
import { useAttendeeSession } from './attendee-session';
import { useSpeechInput } from './use-speech-input';

/**
 * The whole attendee experience: one textarea, one optional name, one button.
 *
 * The target is scan-to-submitted in 15–30 seconds, which rules out almost
 * everything. No account, no email, no confirmation step, no second screen —
 * and the textarea is focusable the instant the page paints rather than after a
 * round trip, because the identity is minted in the background while the
 * attendee is still reading the question in their head.
 *
 * Everything validated here is validated AGAIN on the server. This exists to
 * make the common mistakes instant rather than a round trip; it is not a
 * security control and nothing depends on it being one.
 */

/** Used until the session arrives, so the counter is never blank or wrong. */
const FALLBACK_LIMITS: AttendeeSessionResponse['limits'] = {
  minQuestionLength: 10,
  maxQuestionLength: 500,
  submitLimitCount: 5,
  submitLimitWindowSeconds: 60,
};

type Phase = 'writing' | 'submitting' | 'submitted';

export function AskForm({ joinCode }: { joinCode: string }) {
  // The identity is owned by the page, not the form: the board beneath needs
  // the same one, and two components each joining on mount would race and
  // mint two attendees. See attendee-session.tsx.
  const { session, ensureSession, notifyQuestionSubmitted } = useAttendeeSession();
  const [body, setBody] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phase, setPhase] = useState<Phase>('writing');
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  /**
   * Held in a ref, and regenerated only after a SUCCESSFUL submission.
   *
   * That is what makes a retry safe: if the response is lost on flaky venue
   * wifi, pressing the button again resends the same key and the server returns
   * the question it already created instead of adding a second one. Generating
   * a fresh key per attempt would turn every retry into a duplicate post.
   */
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Spoken words are added after whatever is already typed, so an attendee
  // can mix the two. Clipped to the same hard ceiling as the textarea.
  const appendSpoken = useCallback((spoken: string) => {
    setBody((current) => {
      const joined = current.trim() ? `${current.trimEnd()} ${spoken}` : spoken;
      return joined.slice(0, QUESTION_BODY_HARD_MAX);
    });
  }, []);
  const speech = useSpeechInput({ onFinalText: appendSpoken });
  const stopSpeech = speech.stop;

  const limits = session?.limits ?? FALLBACK_LIMITS;
  const identityMode = session?.identityMode ?? 'OPTIONAL';
  const length = countCharacters(body);
  const remaining = limits.maxQuestionLength - length;

  const handleSubmit = useCallback(
    async (submitEvent: React.FormEvent) => {
      submitEvent.preventDefault();
      stopSpeech();
      setError(null);
      setFieldError(null);

      if (length < limits.minQuestionLength) {
        setFieldError(`Please write at least ${limits.minQuestionLength} characters.`);
        textareaRef.current?.focus();
        return;
      }
      if (length > limits.maxQuestionLength) {
        setFieldError(`Please shorten this to ${limits.maxQuestionLength} characters or fewer.`);
        textareaRef.current?.focus();
        return;
      }

      setPhase('submitting');

      try {
        // The background join may not have finished, or may have failed.
        if (!session) await ensureSession();

        await submitQuestion(
          joinCode,
          {
            body,
            isAnonymous: displayName.trim() === '',
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          },
          idempotencyKey.current,
        );

        setPhase('submitted');
        setBody('');
        // Only now is the key spent: a new question is a genuinely new request.
        idempotencyKey.current = crypto.randomUUID();
        // The board below reloads so the attendee sees their question waiting
        // straight away, rather than on its next poll.
        notifyQuestionSubmitted();
      } catch (caught) {
        setPhase('writing');
        setError(messageFor(caught));
      }
    },
    [
      body,
      displayName,
      ensureSession,
      joinCode,
      length,
      limits,
      notifyQuestionSubmitted,
      session,
      stopSpeech,
    ],
  );

  if (phase === 'submitted') {
    return (
      <SubmittedState
        moderated={session?.moderationMode !== 'POST'}
        onAskAnother={() => {
          setPhase('writing');
          setError(null);
        }}
      />
    );
  }

  const nameRequired = identityMode === 'REQUIRED';
  const showName = identityMode !== 'ANONYMOUS';

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-5">
      <FormField
        error={fieldError ?? undefined}
        hint={`${remaining < 0 ? 0 : remaining} characters left`}
      >
        <Label requiredMarker>Your question</Label>
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(changeEvent) => setBody(changeEvent.target.value)}
          // A hard stop at the schema ceiling, so a paste of a whole document
          // cannot be sent at all. The real limit is enforced server-side.
          maxLength={QUESTION_BODY_HARD_MAX}
          rows={5}
          className="min-h-36 text-base"
          placeholder="What would you like to ask?"
          // The single most important line for the 15-second target: the
          // keyboard is up and the cursor is in the box on arrival.
          autoFocus
          required
        />
      </FormField>

      {speech.supported ? (
        <SpeechControl
          listening={speech.listening}
          interim={speech.interim}
          error={speech.error}
          onStart={speech.start}
          onStop={speech.stop}
        />
      ) : null}

      {showName ? (
        <FormField hint={nameRequired ? undefined : 'Optional — leave blank to stay anonymous.'}>
          <Label requiredMarker={nameRequired}>Your name</Label>
          <Input
            value={displayName}
            onChange={(changeEvent) => setDisplayName(changeEvent.target.value)}
            maxLength={ATTENDEE_NAME_MAX}
            className="h-12 text-base"
            placeholder={nameRequired ? 'Your name' : 'Anonymous'}
            autoComplete="name"
            required={nameRequired}
          />
        </FormField>
      ) : null}

      {/* Alert already carries role="alert" and aria-live="assertive" when its
          severity is error, so it IS the live region. Wrapping it in a second
          one announced every failure twice — the same duplicate-announcement
          mistake Spinner's documentation warns about. */}
      {error ? (
        <Alert severity="error" title="That did not send">
          {error}
        </Alert>
      ) : null}

      <Button
        type="submit"
        size="lg"
        fullWidth
        isLoading={phase === 'submitting'}
        loadingLabel="Sending your question"
        // 48px tall and full width: this is pressed one-handed, standing up, in
        // a dim room, by someone who is also listening to a speaker.
        //
        // The branded fill and its text colour come from the same corrected
        // palette, so the primary action of the whole product cannot end up
        // with an unreadable label whatever colour the organizer chose.
        className="h-14 bg-[var(--event-accent-fill,var(--color-brand-600))] text-base text-[var(--event-on-accent,#fff)] hover:opacity-90"
      >
        Send question
      </Button>
    </form>
  );
}

/**
 * The mic button, what it is hearing, and where the audio goes.
 *
 * Rendered only where the browser can transcribe (see use-speech-input.ts).
 * The status line is always in the DOM while this is shown, so the first
 * update is announced; it carries the words being heard, or what went wrong.
 */
function SpeechControl({
  listening,
  interim,
  error,
  onStart,
  onStop,
}: {
  listening: boolean;
  interim: string;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
}) {
  const status = error ?? (listening ? interim || 'Listening…' : '');

  return (
    <div className="-mt-2 flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        size="lg"
        fullWidth
        aria-pressed={listening}
        onClick={listening ? onStop : onStart}
      >
        <MicIcon />
        {listening ? 'Stop listening' : 'Speak your question'}
      </Button>

      <p
        role="status"
        className={
          error
            ? 'text-sm font-medium text-red-600 empty:hidden'
            : 'text-sm italic text-[var(--color-muted,#666)] empty:hidden'
        }
      >
        {status}
      </p>

      <p className="text-xs text-[var(--color-muted,#666)]">
        Your browser turns speech into text. In Chrome, the audio is sent to Google to do this.
      </p>
    </div>
  );
}

function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="mr-2 size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SubmittedState({
  moderated,
  onAskAnother,
}: {
  moderated: boolean;
  onAskAnother: () => void;
}) {
  return (
    <div className="mt-8 flex flex-col gap-5">
      <Alert severity="success" title="Your question is in">
        {moderated
          ? 'It will appear once a moderator has approved it.'
          : 'It is now on the board for everyone to see.'}
      </Alert>

      <Button variant="secondary" size="lg" fullWidth onClick={onAskAnother} className="h-14">
        Ask another question
      </Button>
    </div>
  );
}

/**
 * Turns a failure into something worth reading.
 *
 * Branches on `code`, never on the message: `detail` is human-facing and may be
 * reworded or localised at any time, which is exactly what the contract says.
 */
function messageFor(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    // Almost always the network on venue wifi. Say what to do, and note the
    // part people worry about — pressing the button again is safe here, because
    // the retry carries the same idempotency key.
    return 'We could not reach the server. Check your connection and try again — pressing send twice will not post it twice.';
  }

  switch (caught.code) {
    case 'DUPLICATE_QUESTION':
      return 'You have already asked this question.';
    case 'SUBMISSION_LIMIT_REACHED':
    case 'RATE_LIMITED':
      return 'You have asked a few questions already. Please wait a moment before asking another.';
    case 'EVENT_NOT_LIVE':
      return 'This event is no longer taking questions.';
    case 'QUESTION_TOO_SHORT':
      return 'That question is a little too short. Please add some detail.';
    case 'QUESTION_TOO_LONG':
      return 'That question is too long. Please shorten it.';
    case 'IDENTITY_REQUIRED':
      return 'This event asks everyone to give their name.';
    case 'ATTENDEE_BLOCKED':
      return 'You are no longer able to post questions at this event.';
    case 'UNAUTHENTICATED':
      return 'Your session expired. Please reload the page and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
