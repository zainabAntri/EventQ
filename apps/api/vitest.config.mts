import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * Two projects, deliberately separated.
 *
 *   unit         pure, no I/O, milliseconds. Runs on every save and in every
 *                CI job. Domain entities, state machines, ranking, permissions.
 *   integration  real Postgres and Redis via Testcontainers. Slower, so it is
 *                a separate command rather than something that makes the fast
 *                loop slow enough that people stop running it.
 *
 * Prisma is never mocked in either. A mocked ORM tests the mock, not the query.
 */
export default defineConfig({
  plugins: [
    // esbuild (Vite's default) cannot emit decorator metadata, which NestJS DI
    // depends on. SWC can, so it replaces the transform for tests.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.integration.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.spec.ts', 'test/**/*.integration.spec.ts'],
          // Runs before the test files are imported, which is the only point
          // early enough: AppModule validates the environment at IMPORT time,
          // so a beforeAll hook is already too late. See the file for why this
          // passed locally and failed in CI.
          setupFiles: ['./test/integration.setup.ts'],
          // Containers take time to start and migrations must run first.
          testTimeout: 120_000,
          hookTimeout: 180_000,
          // Integration tests share a database, so they run serially rather
          // than fighting each other over the same rows.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Coverage is gated on the layers where logic lives. Chasing coverage on
      // generated clients and framework wiring produces tests that assert
      // nothing.
      include: ['src/modules/*/domain/**', 'src/modules/*/application/**'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
