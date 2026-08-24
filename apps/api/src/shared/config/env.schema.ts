import { z } from 'zod';

/**
 * The single definition of every environment variable this service reads.
 *
 * Parsed once at boot. A missing or malformed value crashes the process on
 * startup rather than surfacing as a confusing failure under load three hours
 * into an event. `process.env` is not read anywhere else in the codebase.
 */

const booleanFromEnv = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

const NodeEnv = z.enum(['development', 'test', 'production']);

export const envSchema = z
  .object({
    // --- Runtime ---
    NODE_ENV: NodeEnv.default('development'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // --- Data ---
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    // --- Origins ---
    WEB_ORIGIN: z.url(),
    API_PUBLIC_URL: z.url(),
    /**
     * Exact origins only. A wildcard is rejected outright: it is incompatible
     * with credentialed CORS requests, so allowing it here would produce an
     * auth failure that is very hard to diagnose from the browser side.
     */
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      )
      .refine((origins) => !origins.includes('*'), {
        error:
          'CORS_ALLOWED_ORIGINS cannot contain "*". Credentialed requests require exact origins.',
      }),

    // --- Cookies ---
    /**
     * Empty on localhost. In deployed environments this is `.eventq.io` so the
     * Vercel web app and the AWS API — deliberately on the same registrable
     * domain — share cookies as a same-site pair.
     */
    COOKIE_DOMAIN: z.string().default(''),
    COOKIE_SECURE: booleanFromEnv.default(false),

    // --- Auth ---
    JWT_ACCESS_SECRET: z.string().min(32, {
      error:
        'JWT_ACCESS_SECRET must be at least 32 characters. Generate with: openssl rand -base64 48',
    }),
    JWT_ACCESS_TTL: z.string().default('15m'),
    ATTENDEE_TOKEN_SECRET: z.string().min(32, {
      error:
        'ATTENDEE_TOKEN_SECRET must be at least 32 characters and different from JWT_ACCESS_SECRET.',
    }),
    ATTENDEE_TOKEN_TTL: z.string().default('12h'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    // --- Object storage ---
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanFromEnv.default(false),

    // --- AI (entirely optional; the product is fully functional without it) ---
    AI_ENABLED: booleanFromEnv.default(false),
    ANTHROPIC_API_KEY: z.string().default(''),
    AI_MODEL_CLASSIFY: z.string().default('claude-haiku-4-5'),
    AI_MODEL_DEDUP: z.string().default('claude-haiku-4-5'),
    AI_MODEL_INSIGHT: z.string().default('claude-sonnet-5'),
    /** Micro-dollars. 1_000_000 = $1.00. Integer maths — no float drift on money. */
    AI_EVENT_BUDGET_MICROS: z.coerce.number().int().nonnegative().default(2_000_000),
    AI_MONTHLY_BUDGET_MICROS: z.coerce.number().int().nonnegative().default(50_000_000),

    // --- Observability ---
    OTEL_ENABLED: booleanFromEnv.default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(''),
    SENTRY_DSN: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    // Reusing one secret for two token types means compromising either one
    // forges both. Cheap to check, expensive to discover in an incident.
    if (env.JWT_ACCESS_SECRET === env.ATTENDEE_TOKEN_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['ATTENDEE_TOKEN_SECRET'],
        message: 'ATTENDEE_TOKEN_SECRET must differ from JWT_ACCESS_SECRET.',
      });
    }

    if (env.NODE_ENV === 'production') {
      // Cookies without Secure are sent over plaintext HTTP. In production that
      // is a session-theft vector, so refuse to boot rather than warn.
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['COOKIE_SECURE'],
          message: 'COOKIE_SECURE must be true in production.',
        });
      }

      if (env.CORS_ALLOWED_ORIGINS.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'CORS_ALLOWED_ORIGINS must list at least one origin in production.',
        });
      }

      // A placeholder secret that survives to production is a known incident
      // pattern. Fail loudly at boot.
      for (const key of ['JWT_ACCESS_SECRET', 'ATTENDEE_TOKEN_SECRET'] as const) {
        if (env[key].startsWith('replace-me')) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} still holds its placeholder value.`,
          });
        }
      }
    }

    // AI on without a key would fail on the first enrichment attempt. Catch the
    // misconfiguration at boot instead.
    if (env.AI_ENABLED && env.ANTHROPIC_API_KEY.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'AI_ENABLED is true but ANTHROPIC_API_KEY is empty.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates the environment.
 *
 * Throws with every problem listed at once — a partially configured deployment
 * should not require five restart cycles to discover five missing variables.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(
      `Invalid environment configuration:\n${problems}\n\n` +
        'See .env.example for the full list of supported variables.',
    );
  }

  return result.data;
}
