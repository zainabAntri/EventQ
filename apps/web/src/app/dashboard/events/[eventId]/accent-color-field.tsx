'use client';

import { useId } from 'react';
import { AccentColor, DEFAULT_ACCENT_COLOR, brandPalette } from '@eventq/contracts';

/**
 * The event's brand colour.
 *
 * Two controls for one value, deliberately. The native `<input type="color">`
 * is the one most people will use and gets the operating system's own picker,
 * including its accessibility affordances. The text input beside it exists
 * because a brand colour usually arrives as a hex code in a brand guide or a
 * Slack message, and making someone match `#7c3aed` by eye in a colour wheel
 * would be absurd.
 *
 * ## Why the preview is part of the control
 *
 * `brandPalette` may correct the chosen colour before using it as text or as a
 * filled surface — a pale yellow cannot carry white text, and a mid-tone pink
 * cannot carry either. That correction is invisible unless it is shown, and an
 * organizer who sees their colour "change" with no explanation will assume the
 * product is broken.
 *
 * So the preview renders the actual derived values, and says plainly when a
 * colour had to be adjusted and why. The colour is never rejected — branding
 * that fails contrast is corrected, not refused, because refusing it would only
 * teach people to work around the picker.
 */
export function AccentColorField({
  value,
  onChange,
  enabled,
  onEnabledChange,
}: {
  value: string;
  onChange: (next: string) => void;
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
}) {
  const swatchId = useId();
  const hexId = useId();
  const toggleId = useId();
  const previewId = useId();

  const isValid = AccentColor.safeParse(value).success;
  const palette = brandPalette(isValid ? value : DEFAULT_ACCENT_COLOR);
  const wasCorrected = isValid && palette.accentFill.toLowerCase() !== value.toLowerCase();

  return (
    <fieldset className="rounded-lg border border-[var(--border)] p-4">
      <legend className="px-1 text-sm font-medium">Branding</legend>

      <div className="flex items-start gap-3">
        <input
          id={toggleId}
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          className="mt-1 size-4 accent-brand-600"
        />
        <label htmlFor={toggleId} className="text-sm">
          Use a brand colour
          <span className="mt-0.5 block text-xs text-[var(--muted)]">
            Applies to the attendee page, the printed QR poster and the closed-event screen.
          </span>
        </label>
      </div>

      {enabled ? (
        <div className="mt-4 grid gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={swatchId} className="text-sm font-medium">
                Colour
              </label>
              <input
                id={swatchId}
                type="color"
                value={isValid ? value : DEFAULT_ACCENT_COLOR}
                onChange={(event) => onChange(event.target.value.toLowerCase())}
                // A bare colour input is a tiny square in most browsers, which
                // is under the 24x24 minimum target size in WCAG 2.2.
                className="h-11 w-16 cursor-pointer rounded-md border border-[var(--border)] bg-transparent p-1"
              />
            </div>

            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <label htmlFor={hexId} className="text-sm font-medium">
                Hex code
              </label>
              <input
                id={hexId}
                type="text"
                inputMode="text"
                spellCheck={false}
                value={value}
                onChange={(event) => onChange(event.target.value.trim().toLowerCase())}
                aria-invalid={!isValid || undefined}
                aria-describedby={previewId}
                placeholder={DEFAULT_ACCENT_COLOR}
                className="h-11 w-full rounded-md border border-[var(--border)] bg-transparent px-3 font-mono text-sm aria-[invalid=true]:border-red-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500"
              />
            </div>
          </div>

          {!isValid ? (
            <p role="alert" className="text-xs font-medium text-red-600">
              Use a six-digit hex colour such as {DEFAULT_ACCENT_COLOR}.
            </p>
          ) : null}

          <div id={previewId}>
            <p className="text-xs font-medium text-[var(--muted)]">Preview</p>

            <div className="mt-2 flex flex-wrap items-center gap-3">
              <span
                className="inline-flex h-11 items-center rounded-md px-4 text-sm font-medium"
                style={{ backgroundColor: palette.accentFill, color: palette.onAccent }}
              >
                Ask a question
              </span>

              <span className="text-sm font-semibold" style={{ color: palette.accentText }}>
                Heading text
              </span>
            </div>

            {wasCorrected ? (
              // Stated rather than silently applied. An organizer watching their
              // colour shift with no explanation concludes the picker is broken.
              <p className="mt-3 text-xs text-[var(--muted)]">
                Filled buttons use <span className="font-mono">{palette.accentFill}</span> — a
                slightly adjusted shade, because text on {value} would be too faint to read. Your
                exact colour is still used for the QR code and printed poster.
              </p>
            ) : (
              <p className="mt-3 text-xs text-[var(--muted)]">
                Text colours are chosen automatically so every surface stays readable.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
