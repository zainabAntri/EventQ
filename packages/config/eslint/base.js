// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Shared baseline for every package in the monorepo.
 *
 * Deliberately narrow: rules that catch real defects, not style opinions.
 * Formatting is Prettier's job, so `eslint-config-prettier` disables every
 * stylistic rule that would otherwise fight it.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/*.config.js',
      '**/*.config.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused code is dead code. Allow a leading underscore as the explicit
      // "intentionally unused" signal.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `any` erases the guarantees the rest of the config buys us.
      '@typescript-eslint/no-explicit-any': 'error',

      // Prefer explicit `import type` — required by verbatimModuleSyntax and
      // keeps type-only imports out of the emitted JS.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Silent failure is the enemy of an event-day incident.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'no-var': 'error',

      // Magic numbers are called out explicitly in the architecture proposal.
      // Config values and named constants only.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration[const=true]',
          message:
            'const enums do not survive isolatedModules. Use a plain enum or a union of string literals.',
        },
      ],
    },
  },
  prettier,
);
