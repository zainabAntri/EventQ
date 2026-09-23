import { z } from 'zod';

/**
 * Event branding.
 *
 * One colour, and the arithmetic that keeps it readable.
 *
 * An organizer picking a brand colour is not choosing a text colour, and has no
 * way to know that `#FFE100` on white is a 1.3:1 contrast ratio that fails WCAG
 * outright. Left alone, branding is the single easiest way for an accessible
 * product to become inaccessible — one colour picker undoing every other
 * contrast decision in the app.
 *
 * So the accent is stored exactly as chosen, and every *use* of it is derived
 * here rather than at each call site. The colour on the poster is the
 * organizer's; the colour behind the body text is whatever that colour has to
 * become in order to stay legible.
 *
 * Pure functions over plain strings: no DOM, no canvas, no framework, so the
 * API, the web app and the tests all compute identical values.
 */

/**
 * `#rrggbb`, in either case.
 *
 * Six digits only. Three-digit shorthand is rejected rather than expanded
 * because accepting two spellings of one colour means two strings in the
 * database for the same brand, and the `#rrggbbaa` form is rejected because a
 * translucent accent has no defined contrast ratio — it depends on whatever
 * happens to sit behind it.
 *
 * ## Why this validates but does not normalise
 *
 * An earlier version ended in `.transform(v => v.toLowerCase())`, which was
 * tidy and wrong: every request shape in this package is turned into a JSON
 * Schema for the OpenAPI document, and a transform has no JSON Schema
 * representation. One transform on one field made the whole API document
 * unbuildable, which took the entire integration suite down with it.
 *
 * So case-folding is a separate, explicit step — `normalizeAccentColor` — run
 * where a colour is about to be stored. The schema stays a pure validator, as
 * everything in this package has to.
 */
export const AccentColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/u, {
    error: 'Use a six-digit hex colour such as #7c3aed.',
  });

export type AccentColor = z.infer<typeof AccentColor>;

/**
 * One brand, one string.
 *
 * Applied before persisting so `#7C3AED` and `#7c3aed` cannot both exist as
 * "the" colour of different events in the same organization.
 */
export function normalizeAccentColor(value: string): string {
  return value.trim().toLowerCase();
}

/** The accent used when an organizer has not chosen one. */
export const DEFAULT_ACCENT_COLOR = '#4f46e5';

/**
 * WCAG 2.2 AA thresholds.
 *
 * 4.5:1 for body text, 3:1 for large text and for the visual boundary of a
 * control. Both are floors, not targets.
 */
export const CONTRAST_AA_TEXT = 4.5;
export const CONTRAST_AA_LARGE = 3;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }: Rgb): string {
  const pair = (channel: number): string =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, '0');

  return `#${pair(r)}${pair(g)}${pair(b)}`;
}

/**
 * Relative luminance, per the WCAG definition.
 *
 * The gamma expansion below is not decoration: a naive average of the channels
 * would rate yellow and blue as similarly bright, and every derived colour
 * would be wrong for exactly the palettes people pick as brand colours.
 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);

  const channel = (raw: number): number => {
    const srgb = raw / 255;
    return srgb <= 0.040_45 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Black or white, whichever contrasts better *on* the accent.
 *
 * Note what this does not promise. For a mid-tone colour — a strong pink around
 * `#e61980`, say — neither white nor near-black reaches 4.5:1, because the
 * accent sits almost exactly between them. The arithmetic floor is about
 * 4.27:1, so the result always clears AA for *large* text and can fall just
 * short for body text.
 *
 * That is why filled surfaces use `accentFill` below rather than calling this
 * directly: the fix for a mid-tone accent is to move the fill, not to pretend
 * the label is readable on it.
 */
export function readableTextOn(accent: string): string {
  const onWhite = contrastRatio('#ffffff', accent);
  const onBlack = contrastRatio('#111111', accent);

  return onWhite >= onBlack ? '#ffffff' : '#111111';
}

/**
 * A solid accent-coloured surface that its own label can be read on.
 *
 * Used for filled buttons and badges. Where the organizer's colour already
 * carries readable text it is used untouched; where it cannot — the mid-tone
 * case above — the fill moves to the nearer end of the scale until one of
 * white or near-black clears AA on it.
 *
 * Moving the fill rather than the text is deliberate. The alternative is a
 * button whose label is technically present and practically unreadable, which
 * is the failure mode this whole module exists to prevent.
 */
export function accentFill(
  accent: string,
  minimumRatio: number = CONTRAST_AA_TEXT,
): { fill: string; on: string } {
  const onWhite = contrastRatio('#ffffff', accent);
  const onBlack = contrastRatio('#111111', accent);

  if (onWhite >= minimumRatio) return { fill: accent, on: '#ffffff' };
  if (onBlack >= minimumRatio) return { fill: accent, on: '#111111' };

  // Neither works on the colour as chosen. Darken a darker-leaning accent and
  // put white on it; lighten a lighter-leaning one and put near-black on it.
  // Whichever end is already closer keeps the result nearest the brand.
  return onWhite >= onBlack
    ? { fill: accentAsText(accent, '#ffffff', minimumRatio), on: '#ffffff' }
    : { fill: accentAsText(accent, '#111111', minimumRatio), on: '#111111' };
}

/**
 * The accent, darkened or lightened until it is legible *as* text on a given
 * surface.
 *
 * Used wherever the brand colour becomes a heading, a link or an icon rather
 * than a background. The hue is preserved and only the lightness moves, so the
 * result still reads as the organizer's colour rather than a generic grey.
 *
 * Steps through the channel space rather than solving directly, because the
 * luminance curve is not linear and a closed-form answer would need a colour
 * space this package has no reason to carry. Twenty-four steps is far more
 * precision than a 24-bit colour can express.
 */
export function accentAsText(
  accent: string,
  surface: string,
  minimumRatio: number = CONTRAST_AA_TEXT,
): string {
  if (contrastRatio(accent, surface) >= minimumRatio) return accent;

  // Move away from the surface: darken the accent on a light background,
  // lighten it on a dark one.
  const towardsBlack = relativeLuminance(surface) > 0.5;
  const rgb = parseHex(accent);

  let low = 0;
  let high = 1;
  let best = toHex(towardsBlack ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 });

  for (let step = 0; step < 24; step += 1) {
    const amount = (low + high) / 2;
    const candidate = toHex({
      r: towardsBlack ? rgb.r * (1 - amount) : rgb.r + (255 - rgb.r) * amount,
      g: towardsBlack ? rgb.g * (1 - amount) : rgb.g + (255 - rgb.g) * amount,
      b: towardsBlack ? rgb.b * (1 - amount) : rgb.b + (255 - rgb.b) * amount,
    });

    if (contrastRatio(candidate, surface) >= minimumRatio) {
      // Legible. Remember it and try to keep more of the original colour.
      best = candidate;
      high = amount;
    } else {
      low = amount;
    }
  }

  return best;
}

/**
 * Everything a surface needs to render one event's branding.
 *
 * Computed once and handed down as CSS custom properties, so no component makes
 * its own contrast decision and none of them can disagree.
 */
export interface BrandPalette {
  /** Exactly what the organizer chose. The QR code, print, decorative rules. */
  accent: string;
  /** The accent as a filled surface, corrected only if its own label could not
   *  otherwise be read on it. */
  accentFill: string;
  /** Legible text on `accentFill`. */
  onAccent: string;
  /** The accent, corrected until it is legible as text on a light background. */
  accentText: string;
  /** The same, for a dark background. */
  accentTextDark: string;
}

export function brandPalette(accent: string | null | undefined): BrandPalette {
  const parsed = AccentColor.safeParse(accent ?? DEFAULT_ACCENT_COLOR);
  // An unparseable stored value falls back rather than throwing: a bad colour
  // must never be the reason an attendee cannot reach a question form.
  //
  // Folded here as well as on write, because a row predating normalisation —
  // or written by anything other than the API — may still be uppercase, and
  // every comparison below assumes lowercase hex.
  const value = normalizeAccentColor(parsed.success ? parsed.data : DEFAULT_ACCENT_COLOR);

  const fill = accentFill(value);

  return {
    accent: value,
    accentFill: fill.fill,
    onAccent: fill.on,
    accentText: accentAsText(value, '#ffffff'),
    accentTextDark: accentAsText(value, '#0a0a0a'),
  };
}
