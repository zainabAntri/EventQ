import '@testing-library/jest-dom/vitest';
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';

// Unmounting between tests stops one test's DOM leaking into the next, which
// otherwise produces "found multiple elements" failures that look like flake.
afterEach(() => {
  cleanup();
});

/**
 * Accessibility matcher.
 *
 * Gates on `serious` and `critical` only. `minor` and `moderate` findings are
 * frequently contextual (colour contrast on a decorative element, a landmark
 * rule that only applies to a full page) and blocking CI on them trains people
 * to disable the check entirely — at which point it protects nothing.
 */
expect.extend({
  async toHaveNoSeriousA11yViolations(received: HTMLElement) {
    const results = await axe.run(received, {
      // Rules that only make sense against a complete document, not a mounted
      // component fragment.
      rules: {
        // Rules that only make sense against a complete document rather than a
        // mounted component fragment.
        region: { enabled: false },
        'page-has-heading-one': { enabled: false },
        'landmark-one-main': { enabled: false },
        // jsdom has no canvas and does not apply real stylesheets, so this rule
        // cannot actually measure contrast here — it would report noise, or
        // worse, pass and imply a check that never ran. Contrast is verified
        // for real by the axe pass in the Playwright suite, in a real browser.
        'color-contrast': { enabled: false },
      },
    });

    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );

    if (blocking.length === 0) {
      return { pass: true, message: () => 'No serious accessibility violations found.' };
    }

    const report = blocking
      .map(
        (violation) =>
          `  [${violation.impact}] ${violation.id}: ${violation.help}\n` +
          violation.nodes.map((node) => `      ${node.html}`).join('\n'),
      )
      .join('\n');

    return {
      pass: false,
      message: () => `Accessibility violations:\n${report}`,
    };
  },
});

// Augments `Assertion`, mirroring how @testing-library/jest-dom registers its
// own matchers. Augmenting `Matchers` instead fails with TS2428 because vitest
// declares it as `Matchers<T = any>` and every declaration must match exactly.
declare module 'vitest' {
  interface Assertion<T = any> {
    toHaveNoSeriousA11yViolations(): Promise<T>;
  }
}
