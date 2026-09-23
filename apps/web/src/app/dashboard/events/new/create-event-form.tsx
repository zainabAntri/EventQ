'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CreateEventRequest, DEFAULT_ACCENT_COLOR, type EventType } from '@eventq/contracts';
import { Alert, Button, FormField, Input, Label, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { createEvent } from '@/lib/api-client/organizer';
import { AccentColorField } from '../[eventId]/accent-color-field';

/**
 * Creating an event.
 *
 * The first screen of the organizer flow, and the one that has to stay out of
 * the way: the only thing genuinely required is a title. Everything else has a
 * working default, because the common case is someone setting this up minutes
 * before a room fills.
 *
 * ## Validation runs against the shared contract
 *
 * The form parses its own state with `CreateEventRequest` — the same schema the
 * API validates against — rather than reimplementing the rules in the
 * component. A limit changed in the contract therefore changes this form in the
 * same commit, and the two cannot disagree about what is acceptable.
 *
 * Errors are reported per field through FormField, which wires
 * `aria-describedby`, `aria-invalid` and a polite live region. Submitting an
 * invalid form moves focus to the first field at fault, because an error
 * message a keyboard user has to hunt for is one they will not find.
 */

const EVENT_TYPES: ReadonlyArray<{ value: EventType; label: string }> = [
  { value: 'NETWORKING', label: 'Networking' },
  { value: 'CONFERENCE', label: 'Conference' },
  { value: 'SEMINAR', label: 'Seminar' },
  { value: 'WORKSHOP', label: 'Workshop' },
  { value: 'UNIVERSITY', label: 'University' },
  { value: 'WEBINAR', label: 'Webinar' },
  { value: 'CORPORATE', label: 'Corporate meeting' },
  { value: 'PANEL', label: 'Panel discussion' },
];

/** Field name -> message, as produced by the contract's own issues. */
type FieldErrors = Partial<Record<string, string>>;

export function CreateEventForm() {
  const router = useRouter();
  const headingId = useId();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [venue, setVenue] = useState('');
  const [type, setType] = useState<EventType>('NETWORKING');
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT_COLOR);
  const [brandingEnabled, setBrandingEnabled] = useState(false);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const venueRef = useRef<HTMLInputElement>(null);
  const typeId = useId();

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    // Empty optional fields are omitted rather than sent as "". The contract
    // treats an empty string as a value that fails `min`, so sending one would
    // turn "I left the venue blank" into a validation error about the venue.
    const candidate = {
      title: title.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(venue.trim() ? { venue: venue.trim() } : {}),
      type,
      ...(brandingEnabled ? { accentColor } : {}),
    };

    const parsed = CreateEventRequest.safeParse(candidate);

    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        // First message per field wins: a field with three problems needs one
        // sentence to act on, not three stacked under the input.
        if (typeof field === 'string' && !errors[field]) errors[field] = issue.message;
      }
      setFieldErrors(errors);

      // Focus the first field at fault, in the order they appear on screen.
      if (errors.title) titleRef.current?.focus();
      else if (errors.venue) venueRef.current?.focus();

      return;
    }

    setFieldErrors({});
    setSubmitting(true);

    try {
      const created = await createEvent(parsed.data);
      // Straight to the event, which is where publishing and the QR code are.
      // `replace` rather than `push`: going Back to a form that has already
      // been submitted invites a second event nobody wanted.
      router.replace(`/dashboard/events/${created.id}`);
    } catch (caught: unknown) {
      setSubmitting(false);

      if (caught instanceof ApiError && caught.httpStatus === 401) {
        router.replace('/sign-in?next=/dashboard/events/new');
        return;
      }

      setFormError(
        caught instanceof ApiError && caught.httpStatus === 400
          ? 'Some of those details were not accepted. Check the fields above and try again.'
          : 'We could not create the event. Please try again.',
      );
    }
  }

  return (
    <main id="main" className="mx-auto max-w-xl px-5 py-8 sm:py-12">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/dashboard" className="text-[var(--muted)] underline underline-offset-4">
          Your events
        </Link>
      </nav>

      <h1 id={headingId} className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">
        New event
      </h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Only a name is required. The event is created as a draft — nothing is public until you
        publish it.
      </p>

      {formError ? (
        <div className="mt-6">
          <Alert severity="error" title="That did not work">
            {formError}
          </Alert>
        </div>
      ) : null}

      <form
        onSubmit={handleSubmit}
        aria-labelledby={headingId}
        noValidate
        className="mt-6 grid gap-5"
      >
        <FormField error={fieldErrors.title} hint="Shown to attendees when they scan.">
          <Label requiredMarker>Event name</Label>
          <Input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            // `required` carries the semantics; noValidate above stops the
            // browser's own bubble from competing with our field errors, which
            // are the ones wired to the live region.
            required
            maxLength={300}
            autoComplete="off"
            enterKeyHint="next"
          />
        </FormField>

        <FormField hint="Optional. Attendees see this above the question box.">
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={5_000}
            rows={3}
          />
        </FormField>

        <FormField error={fieldErrors.venue} hint="A room, an address or a video-call link.">
          <Label>Where</Label>
          <Input
            ref={venueRef}
            value={venue}
            onChange={(event) => setVenue(event.target.value)}
            maxLength={500}
            autoComplete="off"
          />
        </FormField>

        {/* A native <select>: it gets the platform's own keyboard handling and,
            on a phone, the system picker — which is far better than anything a
            custom listbox would give an attendee-facing organizer in a hurry. */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={typeId} className="text-sm font-medium">
            Kind of event
          </label>
          <select
            id={typeId}
            value={type}
            onChange={(event) => setType(event.target.value as EventType)}
            className="h-11 w-full rounded-md border border-[var(--border)] bg-transparent px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
          >
            {EVENT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-[var(--muted)]">
            Only affects wording. Every kind works the same way.
          </p>
        </div>

        <AccentColorField
          value={accentColor}
          onChange={setAccentColor}
          enabled={brandingEnabled}
          onEnabledChange={setBrandingEnabled}
        />

        <div className="mt-2 flex flex-wrap gap-3">
          <Button type="submit" isLoading={isSubmitting} loadingLabel="Creating the event">
            Create event
          </Button>
          <Button variant="ghost" onClick={() => router.push('/dashboard')}>
            Cancel
          </Button>
        </div>
      </form>
    </main>
  );
}
