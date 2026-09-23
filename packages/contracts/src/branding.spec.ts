import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AccentColor,
  CONTRAST_AA_LARGE,
  CONTRAST_AA_TEXT,
  DEFAULT_ACCENT_COLOR,
  accentAsText,
  accentFill,
  brandPalette,
  normalizeAccentColor,
  contrastRatio,
  readableTextOn,
  relativeLuminance,
} from './branding.js';

describe('AccentColor', () => {
  it('accepts a six-digit hex colour in either case', () => {
    expect(AccentColor.parse('#7C3AED')).toBe('#7C3AED');
    expect(AccentColor.parse('#7c3aed')).toBe('#7c3aed');
  });

  it('trims surrounding whitespace, which is what a paste from a brand guide carries', () => {
    expect(AccentColor.parse('  #7c3aed  ')).toBe('#7c3aed');
  });

  it('stays a pure validator, so the OpenAPI document can be generated from it', () => {
    // Every request shape in this package becomes a JSON Schema. A transform
    // has no JSON Schema representation, and one here previously made the whole
    // API document unbuildable. Case-folding therefore lives in
    // normalizeAccentColor, not in the schema.
    expect(z.toJSONSchema(AccentColor)).toMatchObject({ type: 'string' });
  });

  it.each(['7c3aed', '#7c3ae', '#7c3aedff', '#zzzzzz', 'rebeccapurple', ''])(
    'rejects %o',
    (value) => {
      expect(AccentColor.safeParse(value).success).toBe(false);
    },
  );

  it('rejects three-digit shorthand rather than expanding it, so one brand is one string', () => {
    expect(AccentColor.safeParse('#f00').success).toBe(false);
  });
});

describe('normalizeAccentColor', () => {
  it('folds case so one brand cannot be stored as two strings', () => {
    expect(normalizeAccentColor('#7C3AED')).toBe('#7c3aed');
  });

  it('trims what a paste from a brand guide carries', () => {
    expect(normalizeAccentColor('  #7C3AED  ')).toBe('#7c3aed');
  });

  it('is idempotent', () => {
    expect(normalizeAccentColor(normalizeAccentColor('#7C3AED'))).toBe('#7c3aed');
  });
});

describe('relativeLuminance', () => {
  it('anchors at the ends of the scale', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('weights green above red above blue, as the human eye does', () => {
    const green = relativeLuminance('#00ff00');
    const red = relativeLuminance('#ff0000');
    const blue = relativeLuminance('#0000ff');

    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('is 1:1 for a colour against itself', () => {
    expect(contrastRatio('#7c3aed', '#7c3aed')).toBeCloseTo(1, 5);
  });

  it('does not depend on the order of the arguments', () => {
    expect(contrastRatio('#7c3aed', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#7c3aed'),
      10,
    );
  });
});

describe('readableTextOn', () => {
  it('puts white on a dark accent and near-black on a light one', () => {
    expect(readableTextOn('#1e1b4b')).toBe('#ffffff');
    expect(readableTextOn('#fde047')).toBe('#111111');
  });

  it('clears AA for large text on every accent, which is all it can promise', () => {
    // A mid-tone accent sits almost equidistant from white and near-black, so
    // neither reaches 4.5:1 on it. The arithmetic floor is ~4.27:1. Body text
    // on such a colour is handled by accentFill, not here.
    for (let hue = 0; hue < 360; hue += 15) {
      for (const lightness of [25, 50, 75]) {
        const accent = hslToHex(hue, 80, lightness);
        const ratio = contrastRatio(readableTextOn(accent), accent);

        expect(ratio, `${accent} at hue ${hue}`).toBeGreaterThanOrEqual(CONTRAST_AA_LARGE);
      }
    }
  });

  it('picks whichever of white and near-black actually contrasts better', () => {
    for (let hue = 0; hue < 360; hue += 30) {
      const accent = hslToHex(hue, 70, 50);
      const chosen = readableTextOn(accent);
      const rejected = chosen === '#ffffff' ? '#111111' : '#ffffff';

      expect(contrastRatio(chosen, accent)).toBeGreaterThanOrEqual(contrastRatio(rejected, accent));
    }
  });
});

describe('accentFill', () => {
  it('leaves a dark accent alone and puts white on it', () => {
    expect(accentFill('#4338ca')).toEqual({ fill: '#4338ca', on: '#ffffff' });
  });

  it('leaves a pale accent alone and puts near-black on it', () => {
    expect(accentFill('#fde047')).toEqual({ fill: '#fde047', on: '#111111' });
  });

  it('moves a mid-tone accent that neither text colour can sit on', () => {
    // The case the hue sweep caught: strong pink, 4.36:1 at best either way.
    const accent = '#e61980';
    expect(contrastRatio(readableTextOn(accent), accent)).toBeLessThan(CONTRAST_AA_TEXT);

    const { fill, on } = accentFill(accent);
    expect(fill).not.toBe(accent);
    expect(contrastRatio(on, fill)).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
  });

  it('produces a readable filled surface for every accent across the hue circle', () => {
    // The guarantee the product actually depends on: no colour in the picker
    // can produce a button whose own label fails AA.
    for (let hue = 0; hue < 360; hue += 5) {
      for (const lightness of [10, 25, 40, 50, 60, 75, 90, 97]) {
        for (const saturation of [15, 55, 95]) {
          const accent = hslToHex(hue, saturation, lightness);
          const { fill, on } = accentFill(accent);

          expect(
            contrastRatio(on, fill),
            `${accent} -> fill ${fill}, text ${on}`,
          ).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
        }
      }
    }
  });

  it('keeps the corrected fill recognisably the same hue', () => {
    const { fill } = accentFill('#e61980');
    const { r, g, b } = channels(fill);

    // Still pink: red dominant, blue above green.
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
  });
});

describe('accentAsText', () => {
  it('leaves an already-legible accent untouched', () => {
    // Dark indigo on white is comfortably past AA, so correcting it would only
    // throw away the organizer's colour.
    expect(accentAsText('#4338ca', '#ffffff')).toBe('#4338ca');
  });

  it('darkens a pale accent until it clears AA on white', () => {
    const corrected = accentAsText('#fde047', '#ffffff');

    expect(contrastRatio('#fde047', '#ffffff')).toBeLessThan(CONTRAST_AA_TEXT);
    expect(contrastRatio(corrected, '#ffffff')).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
  });

  it('lightens a dark accent until it clears AA on a dark surface', () => {
    const corrected = accentAsText('#1e1b4b', '#0a0a0a');

    expect(contrastRatio(corrected, '#0a0a0a')).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
  });

  it('clears AA on both surfaces for every accent across the hue circle', () => {
    for (let hue = 0; hue < 360; hue += 15) {
      for (const lightness of [10, 35, 60, 85, 97]) {
        const accent = hslToHex(hue, 85, lightness);

        expect(
          contrastRatio(accentAsText(accent, '#ffffff'), '#ffffff'),
          `${accent} on white`,
        ).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);

        expect(
          contrastRatio(accentAsText(accent, '#0a0a0a'), '#0a0a0a'),
          `${accent} on near-black`,
        ).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
      }
    }
  });

  it('keeps the hue recognisable rather than collapsing to grey', () => {
    // A corrected yellow must still read as yellow: red and green stay well
    // above blue. Branding that survives contrast correction as a grey smear
    // is branding the organizer will not accept.
    const corrected = accentAsText('#fde047', '#ffffff');
    const { r, g, b } = channels(corrected);

    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
  });

  it('honours a lower threshold for large text', () => {
    const large = accentAsText('#fde047', '#ffffff', 3);
    const body = accentAsText('#fde047', '#ffffff', CONTRAST_AA_TEXT);

    // A looser requirement should preserve more of the original colour.
    expect(relativeLuminance(large)).toBeGreaterThan(relativeLuminance(body));
  });
});

describe('brandPalette', () => {
  it('falls back to the default accent for null, so a missing colour cannot break a page', () => {
    expect(brandPalette(null).accent).toBe(DEFAULT_ACCENT_COLOR);
    expect(brandPalette(undefined).accent).toBe(DEFAULT_ACCENT_COLOR);
  });

  it('falls back rather than throwing on a corrupt stored value', () => {
    // An attendee must reach the question form even if the branding column
    // holds something impossible.
    expect(brandPalette('not-a-colour').accent).toBe(DEFAULT_ACCENT_COLOR);
  });

  it('folds a stored colour that was never normalised', () => {
    // Rows predating normalisation, or written by anything other than the API,
    // may still be uppercase — and every comparison downstream assumes
    // lowercase hex.
    expect(brandPalette('#FDE047').accent).toBe('#fde047');
  });

  it('derives text colours that clear AA on both surfaces', () => {
    const palette = brandPalette('#fde047');

    expect(contrastRatio(palette.onAccent, palette.accentFill)).toBeGreaterThanOrEqual(
      CONTRAST_AA_TEXT,
    );
    expect(contrastRatio(palette.accentText, '#ffffff')).toBeGreaterThanOrEqual(CONTRAST_AA_TEXT);
    expect(contrastRatio(palette.accentTextDark, '#0a0a0a')).toBeGreaterThanOrEqual(
      CONTRAST_AA_TEXT,
    );
  });
});

function channels(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

/** Test-only colour generator, so the sweeps above cover real hues rather than
 *  a handful of hand-picked values. */
function hslToHex(h: number, s: number, l: number): string {
  const saturation = s / 100;
  const lightness = l / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const secondary = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const offset = lightness - chroma / 2;

  const [r, g, b] = ((): readonly [number, number, number] | [number, number, number] => {
    if (h < 60) return [chroma, secondary, 0];
    if (h < 120) return [secondary, chroma, 0];
    if (h < 180) return [0, chroma, secondary];
    if (h < 240) return [0, secondary, chroma];
    if (h < 300) return [secondary, 0, chroma];
    return [chroma, 0, secondary];
  })();

  const pair = (channel: number): string =>
    Math.round((channel + offset) * 255)
      .toString(16)
      .padStart(2, '0');

  return `#${pair(r)}${pair(g)}${pair(b)}`;
}
