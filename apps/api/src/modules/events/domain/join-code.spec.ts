import { describe, expect, it } from 'vitest';
import { JOIN_CODE_ALPHABET, JOIN_CODE_LENGTH, JoinCode } from '@eventq/contracts';
import { generateJoinCode, slugifyTitle } from './join-code';

/** Deterministic byte source, so the generator's behaviour is reproducible. */
function bytesFrom(values: number[]): (size: number) => Uint8Array {
  let cursor = 0;
  return (size: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) {
      out[i] = values[cursor % values.length] ?? 0;
      cursor += 1;
    }
    return out;
  };
}

describe('generateJoinCode', () => {
  it('produces a code that satisfies the shared JoinCode contract', () => {
    // The generator and the validator must agree, or events would be created
    // with codes their own API rejects.
    for (let seed = 0; seed < 40; seed += 1) {
      const code = generateJoinCode(bytesFrom([seed, seed + 7, seed + 13, seed + 29]));
      expect(JoinCode.safeParse(code).success, `rejected: ${code}`).toBe(true);
    }
  });

  it('never emits an excluded character', () => {
    // I, L, O and U are excluded because codes get read aloud in a noisy room.
    for (let seed = 0; seed < 256; seed += 1) {
      const code = generateJoinCode(bytesFrom([seed]));
      for (const character of code) {
        expect(JOIN_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it('always produces exactly the contract length', () => {
    expect(generateJoinCode(bytesFrom([1, 2, 3]))).toHaveLength(JOIN_CODE_LENGTH);
  });

  it('maps the whole byte range uniformly at the current alphabet size', () => {
    // 32 divides 256 exactly, so the rejection threshold sits at 256 and no
    // byte is ever discarded — every value contributes. The rejection sampling
    // in the implementation is therefore inert TODAY; it exists so that
    // changing the alphabet to a size that does not divide 256 cannot silently
    // bias code generation.
    expect(JOIN_CODE_ALPHABET).toHaveLength(32);

    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const character = generateJoinCode(bytesFrom([byte]))[0] as string;
      counts.set(character, (counts.get(character) ?? 0) + 1);
    }

    // Every symbol reachable, each by exactly 8 of the 256 byte values.
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((count) => count === 8)).toBe(true);
  });

  it('varies with the random source', () => {
    const a = generateJoinCode(bytesFrom([1, 2, 3, 4]));
    const b = generateJoinCode(bytesFrom([9, 8, 7, 6]));
    expect(a).not.toBe(b);
  });
});

describe('slugifyTitle', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyTitle('Founders & Funders Night')).toBe('founders-funders-night');
  });

  it('strips accents rather than dropping the letters', () => {
    // "Café" must become "cafe", not "caf".
    expect(slugifyTitle('Café Networking')).toBe('cafe-networking');
  });

  it('trims leading and trailing separators', () => {
    expect(slugifyTitle('  !!! Summit !!!  ')).toBe('summit');
  });

  it('falls back for a title with no slug-able characters', () => {
    // An all-emoji title is legal input and must still produce a usable URL.
    expect(slugifyTitle('***')).toBe('event');
    expect(slugifyTitle('🎉🎉')).toBe('event');
  });

  it('bounds the length so it cannot overflow the column', () => {
    expect(slugifyTitle('a'.repeat(500)).length).toBeLessThanOrEqual(100);
  });
});
