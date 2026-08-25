import { describe, expect, it } from 'vitest';
import {
  normalizeDisplayName,
  normalizeForComparison,
  normalizeForStorage,
  normalizeQuestion,
} from './question-text';

/**
 * Text normalisation is the first security control an attendee's words meet, so
 * these tests are written as the guarantees it makes rather than as coverage of
 * its branches.
 *
 * Inputs are built with String.fromCodePoint rather than pasted as literal
 * characters. That is deliberate and not merely stylistic: every character
 * under test here is INVISIBLE, so a literal would make the test unreadable and
 * unreviewable — and an editor or formatter could silently alter it without the
 * diff showing anything at all. Naming the code point states the intent.
 */
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const WORD_JOINER = String.fromCodePoint(0x2060);
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);
const LINE_SEPARATOR = String.fromCodePoint(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCodePoint(0x2029);
const NUL = String.fromCodePoint(0x0000);
const BELL = String.fromCodePoint(0x0007);

describe('normalizeForStorage', () => {
  it('removes invisible characters that would make text render differently from what it contains', () => {
    // The Trojan Source problem: these are not decoration, they change how a
    // reader sees text without changing the characters a check would inspect.
    const smuggled = `How${ZERO_WIDTH_SPACE} do I${RIGHT_TO_LEFT_OVERRIDE} network${WORD_JOINER}?${BYTE_ORDER_MARK}`;

    expect(normalizeForStorage(smuggled)).toBe('How do I network?');
  });

  it('removes a soft hyphen, which is invisible until it lands on a line break', () => {
    expect(normalizeForStorage(`net${SOFT_HYPHEN}working`)).toBe('networking');
  });

  it('turns Unicode line separators into newlines instead of deleting them', () => {
    // Deleting these would weld two sentences into one nonsense word, which is
    // both a data-quality bug and a way to defeat a word-based check.
    expect(normalizeForStorage(`First${LINE_SEPARATOR}Second`)).toBe('First\nSecond');
    expect(normalizeForStorage(`First${PARAGRAPH_SEPARATOR}Second`)).toBe('First\nSecond');
  });

  it('strips control characters, including a NUL byte', () => {
    expect(normalizeForStorage(`hel${NUL}lo${BELL} there`)).toBe('hello there');
  });

  it('applies NFKC so a compatibility spelling cannot evade a later check', () => {
    // Fullwidth Latin. Without NFKC first, a rule looking for "javascript:"
    // would never see this one.
    const fullwidth = 'ｊａｖａｓｃｒｉｐｔ：';

    expect(normalizeForStorage(fullwidth)).toBe('javascript:');
  });

  it('collapses runs of spaces but keeps a deliberate paragraph break', () => {
    expect(normalizeForStorage('a     b')).toBe('a b');
    expect(normalizeForStorage('one\n\ntwo')).toBe('one\n\ntwo');
  });

  it('caps blank lines, so a question cannot push the board off a projector', () => {
    expect(normalizeForStorage('one\n\n\n\n\n\n\ntwo')).toBe('one\n\ntwo');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeForStorage('   spaced   ')).toBe('spaced');
  });

  it('leaves HTML and script text exactly as written', () => {
    // Storage is NOT where XSS is prevented — React escapes at render. Mangling
    // it here would corrupt a legitimate question about HTML and create a second,
    // weaker escaping implementation for something else to come to rely on.
    const hostile = '<script>alert("xss")</script> is that safe?';

    expect(normalizeForStorage(hostile)).toBe(hostile);
  });
});

describe('normalizeForComparison', () => {
  it('folds case, accents and punctuation so near-identical text compares equal', () => {
    expect(normalizeForComparison('Café — really?!')).toBe('cafe really');
  });

  it('makes two spellings of the same question produce one value', () => {
    const a = normalizeForComparison('How do I follow up?');
    const b = normalizeForComparison('how do i FOLLOW UP');

    expect(a).toBe(b);
  });
});

describe('normalizeQuestion', () => {
  it('measures length after normalisation, so invisible padding cannot inflate it', () => {
    const padded = 'hello' + ZERO_WIDTH_SPACE.repeat(500);

    // 5, not 505. A maximum applied to the raw string would reject this, and a
    // minimum applied to it would accept an empty question padded to look long.
    expect(normalizeQuestion(padded).length).toBe(5);
  });

  it('counts an emoji as one character rather than two code units', () => {
    // String.length would say 2 here, so a limit built on it rejects text that
    // is well within what a person would call the limit.
    expect(normalizeQuestion('hi 👋').length).toBe(4);
  });

  it('gives equivalent questions the same hash and different ones a different hash', () => {
    const first = normalizeQuestion('How do I follow up after an event?');
    const second = normalizeQuestion('  how do I FOLLOW UP after an event?!  ');
    const other = normalizeQuestion('What metrics actually matter?');

    // This is what the unique index in the database compares, so equality here
    // is exactly what makes a duplicate submission impossible rather than merely
    // unlikely.
    expect(second.bodyHash).toBe(first.bodyHash);
    expect(other.bodyHash).not.toBe(first.bodyHash);
  });

  it('produces a 64-character hex digest, matching the CHAR(64) column', () => {
    expect(normalizeQuestion('a real question about networking')).toMatchObject({
      bodyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('reduces a whitespace-only question to nothing, so it can be refused as too short', () => {
    const empty = normalizeQuestion(`  ${ZERO_WIDTH_SPACE}\n\n ${BYTE_ORDER_MARK} `);

    expect(empty.body).toBe('');
    expect(empty.length).toBe(0);
  });
});

describe('normalizeDisplayName', () => {
  it('collapses newlines so a name cannot break a layout or impersonate two lines', () => {
    expect(normalizeDisplayName('Priya\nRaman')).toBe('Priya Raman');
  });

  it('strips invisible characters from a name too', () => {
    expect(normalizeDisplayName(`Priya${ZERO_WIDTH_SPACE} Raman`)).toBe('Priya Raman');
  });
});
