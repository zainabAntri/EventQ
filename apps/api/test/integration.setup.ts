/**
 * Environment for the integration suite.
 *
 * This MUST run before any test file imports AppModule, and that ordering is
 * the whole point of the file.
 *
 * config.module.ts calls `ConfigModule.forRoot({ validate: validateEnv })` as a
 * module DECORATOR argument, so the environment is validated the instant
 * app.module.ts is first imported — long before any `beforeAll` hook could
 * populate it. Setting these variables inside `startTestApp()` was therefore
 * always too late; every integration file threw at import time.
 *
 * It appeared to work locally for two reasons that both stop being true in CI:
 *
 *   1. `envFilePath: ['.env']` loads apps/api/.env, which exists on a developer
 *      machine and is gitignored, so CI has no such file.
 *   2. Turbo 2 defaults to `envMode: "strict"` and turbo.json declared only
 *      NODE_ENV, so `turbo run test:integration` stripped DATABASE_URL and
 *      REDIS_URL out of the environment before vitest started — even though the
 *      CI job sets both. That is why `pnpm db:deploy`, which calls pnpm
 *      directly rather than through turbo, connected perfectly one step earlier.
 *
 * Assigning only when absent (`??=`) keeps a genuinely-supplied value winning,
 * so pointing the suite at a real Redis still works.
 *
 * Every value below is a PLACEHOLDER. No real secret is involved, and the
 * database these tests actually use is the throwaway Testcontainers instance
 * from database.harness.ts, not the URL here.
 */
const PLACEHOLDER_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',

  // Structurally valid so env.schema.ts accepts them. Never connected to:
  // PrismaService is replaced with the Testcontainers client in app.harness.ts.
  DATABASE_URL: 'postgresql://eventq_test:eventq_test@127.0.0.1:5432/eventq_test',
  REDIS_URL: 'redis://127.0.0.1:6379',

  WEB_ORIGIN: 'http://localhost:3000',
  API_PUBLIC_URL: 'http://localhost:4000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:3000',

  // Long enough to satisfy the 32-character minimum, and deliberately different
  // from each other — env.schema.ts refuses to boot when the two token secrets
  // match, and that check is worth exercising rather than tiptoeing around.
  JWT_ACCESS_SECRET: 'test-access-secret-that-is-long-enough-1234567890',
  ATTENDEE_TOKEN_SECRET: 'test-attendee-secret-that-is-different-0987654321',

  S3_BUCKET: 'test-bucket',
  S3_ACCESS_KEY_ID: 'test-key',
  S3_SECRET_ACCESS_KEY: 'test-secret',
};

for (const [key, value] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[key] ??= value;
}

// NODE_ENV is special-cased: turbo DOES forward it, and a stray `development`
// would put the rate limiter into fail-open mode and skip production-only
// config assertions, quietly weakening what the suite proves.
process.env['NODE_ENV'] = 'test';
