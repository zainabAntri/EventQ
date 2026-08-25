import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH } from '@eventq/contracts';

/**
 * Join code generation.
 *
 * The alphabet excludes I, L, O and U — codes get read aloud across a noisy
 * room, and 1/I/L and 0/O are the confusions that actually happen. U is out to
 * avoid accidental profanity.
 *
 * Randomness is supplied by the caller rather than imported, so this stays a
 * pure function and its distribution is testable with a deterministic source.
 */
export type RandomBytes = (size: number) => Uint8Array;

const ALPHABET_SIZE = JOIN_CODE_ALPHABET.length;

/**
 * 32 symbols over 8 positions is 2^40 possibilities. Guessing a live code is
 * impractical, and codes are additionally only useful while an event is
 * published.
 */
export function generateJoinCode(randomBytes: RandomBytes): string {
  // Rejection sampling. A plain `byte % 32` would be uniform here only because
  // 256 happens to divide evenly by 32; doing it properly means the alphabet
  // can change later without silently biasing the distribution.
  const limit = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;
  let code = '';

  while (code.length < JOIN_CODE_LENGTH) {
    const bytes = randomBytes(JOIN_CODE_LENGTH);
    for (const byte of bytes) {
      if (code.length === JOIN_CODE_LENGTH) break;
      if (byte >= limit) continue;
      code += JOIN_CODE_ALPHABET[byte % ALPHABET_SIZE];
    }
  }

  return code;
}

/**
 * The address a QR code points at.
 *
 * Derived on the server from one configured origin rather than assembled by
 * each client, so the printed poster, the organizer dashboard and the projector
 * cannot disagree about where attendees should go. Getting that wrong is not a
 * cosmetic bug — it is a room full of people who cannot ask anything.
 */
export function joinUrlFor(webOrigin: string, joinCode: string): string {
  return `${webOrigin.replace(/\/+$/, '')}/e/${joinCode}`;
}

/**
 * URL slug from a title.
 *
 * Unique only within an organization, so two organizations may both run an
 * event called "Annual Summit" without either having to rename theirs.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

  return slug === '' ? 'event' : slug;
}
