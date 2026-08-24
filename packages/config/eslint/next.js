// @ts-check
import base from './base.js';

/**
 * Lint config for apps/web.
 *
 * Enforces two rules from the architecture proposal that are otherwise easy to
 * erode one component at a time:
 *
 *   1. No business logic in components. Ranking, permission checks and state
 *      transitions live in the API; the frontend renders and dispatches.
 *   2. No bare `fetch` with a hand-written type. All calls go through the
 *      typed client generated from @eventq/contracts, so the frontend and the
 *      backend cannot drift.
 */
export default [
  ...base,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client', '@eventq/api/*'],
              message:
                'The web app must not import server internals. Use @eventq/contracts for shared types and the typed API client for data.',
            },
          ],
        },
      ],

      // Every network call goes through lib/api-client so requests are typed,
      // credentialed and error-parsed consistently.
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Use the typed client from lib/api-client instead of bare fetch — it handles credentials, contract validation and problem+json parsing.',
        },
      ],
    },
  },
  {
    // The API client is the one place allowed to call fetch.
    files: ['**/lib/api-client/**/*.ts', '**/lib/sse/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['**/*.spec.{ts,tsx}', '**/*.test.{ts,tsx}', '**/e2e/**/*.ts', '**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-globals': 'off',
      'no-console': 'off',
    },
  },
];
