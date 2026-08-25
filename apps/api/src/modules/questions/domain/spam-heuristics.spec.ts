import { describe, expect, it } from 'vitest';
import { assessForSpam } from './spam-heuristics';
import { normalizeQuestion } from './question-text';

/**
 * Spam heuristics.
 *
 * Assessed through normalizeQuestion rather than on raw strings, because that
 * is the only way they are ever called in production — normalisation runs
 * first, and a heuristic tested against un-normalised text would be tested
 * against input it never actually sees.
 */
function assess(raw: string, profanityFilter = true) {
  const { body, normalizedBody } = normalizeQuestion(raw);
  return assessForSpam(body, normalizedBody, { profanityFilter });
}

describe('ordinary questions', () => {
  it.each([
    'How do I follow up after meeting someone at an event like this?',
    'What metrics actually matter when measuring the return on networking?',
    'Is SaaS ARR a KPI worth reporting to a seed-stage board?',
    'What was the Q3 2026 revenue split, roughly 60/40?',
  ])('lets a genuine question straight through: %s', (question) => {
    const result = assess(question);

    expect(result.verdict).toBe('clean');
    expect(result.signals).toEqual([]);
  });

  it('does not treat an acronym-heavy question as shouting', () => {
    // "Is SaaS ARR a KPI?" is mostly capitals by ratio. Flagging it would train
    // moderators to ignore the signal.
    expect(assess('Does the CTO or the CEO own the API and SDK roadmap here?').verdict).toBe(
      'clean',
    );
  });
});

describe('malicious URLs', () => {
  it.each(['javascript:', 'vbscript:', 'data:', 'blob:', 'file:'])(
    'quarantines a %s URL outright',
    (scheme) => {
      const result = assess(`Great talk! See ${scheme}alert(document.cookie) for more`);

      expect(result.verdict).toBe('spam');
      expect(result.signals).toContain('disallowed_url_scheme');
    },
  );

  it('still catches a disallowed scheme written in fullwidth characters', () => {
    // NFKC runs during normalisation, which is precisely why the check can be a
    // simple ASCII pattern rather than an ever-growing list of lookalikes.
    const result = assess('check ｊａｖａｓｃｒｉｐｔ：alert(1) out');

    expect(result.signals).toContain('disallowed_url_scheme');
  });

  it('catches a scheme hidden by an invisible character', () => {
    const zeroWidth = String.fromCodePoint(0x200b);
    const result = assess(`java${zeroWidth}script:alert(1)`);

    expect(result.signals).toContain('disallowed_url_scheme');
  });

  it('sends a single ordinary link to a moderator rather than rejecting it', () => {
    // A speaker's own link is a legitimate thing to ask about.
    const result = assess('Is the deck at https://example.com/deck the final version?');

    expect(result.verdict).toBe('review');
    expect(result.signals).toContain('contains_link');
  });

  it('holds two links for a moderator without quarantining them', () => {
    // Someone comparing two things is doing something legitimate.
    const result = assess(
      'Is https://example.com/deck newer than https://example.com/deck-v2, or the same?',
    );

    expect(result.verdict).toBe('review');
    expect(result.signals).toContain('excessive_links');
  });

  it('quarantines a message that is mostly links', () => {
    // Three or more is not a question. Tiering this rather than lowering the
    // spam threshold is what keeps a single ordinary link out of quarantine.
    const result = assess(
      'Buy now at https://spam.example.com and www.spam.example.net and cheap.example.shop',
    );

    expect(result.verdict).toBe('spam');
    expect(result.signals).toContain('link_spam');
  });
});

describe('automated and low-effort submissions', () => {
  it('flags sustained shouting', () => {
    expect(assess('BUY CHEAP FOLLOWERS RIGHT NOW FROM OUR STORE').signals).toContain('shouting');
  });

  it('flags a long run of one repeated character', () => {
    expect(assess('is this thing on?????????????').signals).toContain('repeated_characters');
  });

  it('flags text that is mostly not letters', () => {
    expect(assess('!!! $$$ @@@ ### %%% ^^^ &&& *** ((( ))) +++').signals).toContain(
      'low_alphabetic_ratio',
    );
  });

  it('flags keyword stuffing', () => {
    expect(assess('crypto crypto crypto crypto crypto invest today').signals).toContain(
      'repeated_word',
    );
  });

  it('combines weak signals into a quarantine', () => {
    // No single trait here is damning; together they are not a question.
    const result = assess('CHEAP CHEAP CHEAP CHEAP CHEAP DEALS!!!!!!!!! www.example.shop');

    expect(result.verdict).toBe('spam');
    expect(result.signals.length).toBeGreaterThan(1);
  });
});

describe('profanity filter', () => {
  it('routes profanity to a moderator when the event enables the filter', () => {
    const result = assess('what the fuck was that answer', true);

    expect(result.signals).toContain('profanity');
    expect(result.verdict).toBe('review');
  });

  it('ignores profanity entirely when the event disables the filter', () => {
    const result = assess('what the fuck was that answer', false);

    expect(result.signals).not.toContain('profanity');
  });

  it('matches whole words only, so an innocent word is not caught by a substring', () => {
    // The Scunthorpe problem. A filter that fails this is worse than none,
    // because it silently penalises real questions from real places.
    for (const clean of [
      'I am from Scunthorpe, any local meetups?',
      'Which classic album is best?',
    ]) {
      expect(assess(clean, true).signals).not.toContain('profanity');
    }
  });
});

describe('determinism', () => {
  it('gives the same answer when called twice on the same text', () => {
    // The module-level regexes carry the /g flag, which means they hold mutable
    // lastIndex state between calls. Without an explicit reset, the second call
    // silently disagrees with the first — and a security control that depends on
    // call order is not a control at all.
    const text = 'See https://example.com/deck for the slides';

    const first = assess(text);
    const second = assess(text);

    expect(second).toEqual(first);
  });

  it('stays deterministic across many repetitions', () => {
    const text = 'javascript:alert(1) and www.example.shop and https://example.com';
    const results = Array.from({ length: 20 }, () => assess(text).verdict);

    expect(new Set(results).size).toBe(1);
  });
});
