import { createHash } from 'node:crypto';
import { countCharacters } from '@eventq/contracts';

/**
 * Question text normalisation — the first line of defence, before any rule
 * looks at the content.
 *
 * Two separate normalisations, because they answer different questions:
 *
 *   normalizeForStorage     what gets stored and shown to the room. Preserves
 *                           the attendee's words, removes only what is
 *                           invisible or structurally dangerous.
 *   normalizeForComparison  what duplicate detection compares. Aggressively
 *                           lossy on purpose — case, accents and punctuation
 *                           must not be enough to sneak the same question past
 *                           the uniqueness constraint a second time.
 *
 * Pure functions over strings: no clock, no database, no framework. Every rule
 * here is testable in microseconds and cannot be bypassed by a caller that
 * forgets a step, because callers never see the raw text at all.
 *
 * NOTE ON XSS: nothing here escapes or sanitises HTML, deliberately. Text is
 * stored exactly as the attendee wrote it and escaped at RENDER time by React.
 * Sanitising on the way in would mangle a legitimate question about `<script>`
 * tags, and — far worse — it would create a second, weaker escaping
 * implementation that some future output path might come to rely on. Escape at
 * output, once, is the control that actually holds.
 */

/**
 * Zero-width and bidirectional-override characters, written as escapes so the
 * set is readable in a diff rather than being an apparently empty bracket.
 *
 * These are removed because they are invisible: text containing them renders
 * differently from the characters it is made of. That is the Trojan Source
 * class of attack, and in a Q&A product it also defeats every length limit and
 * duplicate check by making two identical questions compare unequal.
 *
 * U+00AD is a soft hyphen — invisible until it happens to land on a line break.
 */
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu;

/**
 * C0 and C1 control characters. Newline and tab are handled separately.
 *
 * `no-control-regex` is suppressed for the line below, and ONLY that line. The
 * rule exists to catch control characters that reached a pattern by accident —
 * a real hazard, since they are invisible in source. Here they are the entire
 * subject: this is the expression whose job is to strip them from attendee
 * text. Suppressing it at one line keeps the rule protecting every other regex
 * in the codebase, which is the opposite of relaxing it in the shared config.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Unicode line and paragraph separators. */
const LINE_SEPARATORS = /[\u2028\u2029]/gu;

/**
 * Storage form.
 *
 * NFKC runs FIRST so that compatibility forms — fullwidth Latin, ligatures,
 * styled mathematical alphanumerics — collapse to their ordinary equivalents
 * before any rule inspects them. Doing it afterwards would let a fullwidth
 * spelling of `javascript:` walk straight past a check looking for the ASCII one.
 */
export function normalizeForStorage(raw: string): string {
  return (
    raw
      .normalize('NFKC')
      // Become ordinary newlines rather than being stripped, which would
      // silently weld two sentences together into one nonsense word.
      .replace(LINE_SEPARATORS, '\n')
      .replace(/\r\n?/gu, '\n')
      .replace(INVISIBLE, '')
      .replace(CONTROL, '')
      // Collapse horizontal whitespace only, so deliberate paragraphs survive.
      .replace(/[^\S\n]+/gu, ' ')
      .replace(/[^\S\n]*\n[^\S\n]*/gu, '\n')
      // Two blank lines is a paragraph break; forty is a way to push the rest
      // of the board off a projector screen.
      .replace(/\n{3,}/gu, '\n\n')
      .trim()
  );
}

/**
 * Comparison form. Feeds both the duplicate hash and the pg_trgm index.
 *
 * NFKD then stripping combining marks folds "Café" and "Cafe" together, so an
 * accent is not a way to re-post the same question.
 */
export function normalizeForComparison(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * SHA-256 of the comparison form, hex encoded.
 *
 * Imported directly rather than injected as a port: hashing is deterministic
 * pure computation, so unlike randomness there is nothing a test would need to
 * control. It must produce exactly the digest the migration's backfill computes
 * with `encode(sha256(convert_to(...,'UTF8')),'hex')`.
 */
export function hashForComparison(comparisonForm: string): string {
  return createHash('sha256').update(comparisonForm, 'utf8').digest('hex');
}

export interface NormalizedQuestion {
  /** What is stored and displayed. */
  body: string;
  /** What duplicate detection compares. */
  normalizedBody: string;
  /** SHA-256 of `normalizedBody`, for the uniqueness constraint. */
  bodyHash: string;
  /** Grapheme count of `body` — what a person would call its length. */
  length: number;
}

/**
 * The single entry point. Callers never handle raw attendee text, so no code
 * path can accidentally skip a step.
 *
 * Length is measured AFTER normalisation, which is what stops a body padded
 * with a thousand zero-width characters from either smuggling itself past a
 * maximum or failing a minimum it genuinely meets.
 */
export function normalizeQuestion(raw: string): NormalizedQuestion {
  const body = normalizeForStorage(raw);
  const normalizedBody = normalizeForComparison(body);

  return {
    body,
    normalizedBody,
    bodyHash: hashForComparison(normalizedBody),
    length: countCharacters(body),
  };
}

/** Attendee display names get the storage normalisation too — same reasoning. */
export function normalizeDisplayName(raw: string): string {
  // A newline in a name is always either a mistake or an attempt to break a
  // layout, so it collapses to a space rather than surviving as structure.
  return normalizeForStorage(raw).replace(/\n+/gu, ' ').trim();
}
