import base from '@eventq/config/eslint/base';
import nest from '@eventq/config/eslint/nest';
import next from '@eventq/config/eslint/next';

/**
 * Root flat config.
 *
 * ESLint's flat config resolves from the working directory, not from each
 * file's location, so running `eslint` from the repo root needs a config here.
 * Without it, lint-staged (which runs at the root) cannot lint anything.
 *
 * Each preset is scoped to its own directory so the NestJS architecture rules
 * do not leak into the web app and vice versa. Per-package eslint.config.mjs
 * files remain, so `pnpm --filter <pkg> lint` still works on its own.
 */

/** Prefixes every `files`/`ignores` pattern in a preset with a directory. */
function scopeTo(directory, configs) {
  const prefix = (pattern) =>
    pattern.startsWith('**/') ? `${directory}/${pattern}` : `${directory}/${pattern}`;

  return configs.map((config) => {
    // A config with no `files` applies globally; scoping it to the directory
    // keeps one workspace's rules out of another's.
    const scoped = { ...config };
    scoped.files = config.files
      ? config.files.map(prefix)
      : [`${directory}/**/*.{ts,tsx,js,mjs,cjs}`];
    if (config.ignores) scoped.ignores = config.ignores.map(prefix);
    return scoped;
  });
}

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  ...scopeTo('apps/api', nest),
  ...scopeTo('apps/web', next),
  ...scopeTo('packages/contracts', base),
  // Root-level E2E specs are plain Playwright tests.
  ...scopeTo('e2e', base),
];
