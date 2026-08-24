// @ts-check
import base from './base.js';

/**
 * Architecture boundary enforcement for apps/api.
 *
 * The dependency rule from the architecture proposal is:
 *
 *     presentation  ->  application  ->  domain
 *     infrastructure implements domain ports, wired at module level
 *
 * Architecture that is not enforced by CI decays within a month, so each arrow
 * below is a lint error rather than a code-review convention.
 *
 * Layer contracts:
 *   domain/         ZERO framework. No Nest, no Prisma, no HTTP, no Redis.
 *                   Pure TypeScript so it is testable without any I/O.
 *   application/    Use-cases. May use Nest DI decorators; must NOT reach for
 *                   Prisma or HTTP directly — it talks to domain ports only.
 *   infrastructure/ Adapters. May use anything; implements domain ports.
 *   presentation/   Controllers, guards, DTOs. Calls application, never
 *                   infrastructure or a repository directly.
 */

const FRAMEWORK_FREE_DOMAIN = [
  {
    group: ['@nestjs/*', '@nestjs/**'],
    message:
      'domain/ must stay framework-free. Move Nest wiring to infrastructure/ or presentation/, and express the need as a port interface in domain/.',
  },
  {
    group: ['@prisma/client', 'prisma', '**/prisma/**'],
    message:
      'domain/ must not know about persistence. Define a repository port in domain/ and implement it in infrastructure/.',
  },
  {
    group: ['express', 'ioredis', 'bullmq', '@aws-sdk/*', '@anthropic-ai/*'],
    message:
      'domain/ must not depend on I/O libraries. Express the capability as a port interface and implement it in infrastructure/.',
  },
  {
    group: ['**/infrastructure/**', '**/presentation/**', '**/application/**'],
    message:
      'domain/ is the innermost layer and may not import outward. Dependencies point inward only.',
  },
];

const APPLICATION_BOUNDARIES = [
  {
    group: ['@prisma/client', 'prisma', '**/prisma/**'],
    message:
      'application/ must not touch Prisma directly. Depend on a domain repository port; infrastructure/ provides the implementation.',
  },
  {
    group: ['**/presentation/**'],
    message:
      'application/ must not import presentation/. Controllers call use-cases, never the reverse.',
  },
  {
    group: ['**/infrastructure/**'],
    message:
      'application/ must not import infrastructure/ concretions. Depend on the domain port; the module wires the adapter.',
  },
  {
    group: ['express', '@nestjs/platform-express'],
    message: 'application/ must not know about HTTP. Keep transport concerns in presentation/.',
  },
];

const PRESENTATION_BOUNDARIES = [
  {
    group: ['@prisma/client', 'prisma'],
    message: 'presentation/ must not query the database directly. Call a use-case in application/.',
  },
  {
    group: ['**/infrastructure/**'],
    message:
      'presentation/ must not import infrastructure/ directly. Go through application/ use-cases.',
  },
];

export default [
  ...base,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        // Nest relies on emitDecoratorMetadata for constructor injection.
        // Verified on TypeScript 7.0.2: design:paramtypes is emitted correctly.
        projectService: true,
      },
    },
    rules: {
      // Nest controllers and providers are instantiated by the framework, so
      // "unused" constructor params are the normal DI pattern.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // ---- The dependency rule, enforced ----
  {
    files: ['**/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FRAMEWORK_FREE_DOMAIN }],
    },
  },
  {
    files: ['**/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: APPLICATION_BOUNDARIES }],
    },
  },
  {
    files: ['**/modules/*/presentation/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: PRESENTATION_BOUNDARIES }],
    },
  },

  // Tests describe behaviour; a little pragmatism is fine there.
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
];
