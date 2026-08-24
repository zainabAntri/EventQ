import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed accessor for validated configuration.
 *
 * Everything is grouped by concern rather than exposed as a flat bag of
 * strings, so call sites read as `config.cookies.domain` instead of
 * `config.get('COOKIE_DOMAIN')` with no type safety and no discoverability.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  private get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isTest(): boolean {
    return this.get('NODE_ENV') === 'test';
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get port(): number {
    return this.get('API_PORT');
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.get('LOG_LEVEL');
  }

  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get redisUrl(): string {
    return this.get('REDIS_URL');
  }

  get http() {
    return {
      webOrigin: this.get('WEB_ORIGIN'),
      publicUrl: this.get('API_PUBLIC_URL'),
      corsAllowedOrigins: this.get('CORS_ALLOWED_ORIGINS'),
    } as const;
  }

  get cookies() {
    const domain = this.get('COOKIE_DOMAIN');
    return {
      /** Empty string means "host-only cookie", which is what localhost needs. */
      domain: domain === '' ? undefined : domain,
      secure: this.get('COOKIE_SECURE'),
      /**
       * Lax, not None. The web app and the API live on sibling subdomains of one
       * registrable domain, so they are same-site and Lax cookies flow on XHR
       * without relying on third-party cookies.
       */
      sameSite: 'lax',
    } as const;
  }

  get auth() {
    return {
      accessSecret: this.get('JWT_ACCESS_SECRET'),
      accessTtl: this.get('JWT_ACCESS_TTL'),
      attendeeSecret: this.get('ATTENDEE_TOKEN_SECRET'),
      attendeeTtl: this.get('ATTENDEE_TOKEN_TTL'),
      refreshTtlDays: this.get('REFRESH_TOKEN_TTL_DAYS'),
    } as const;
  }

  get storage() {
    return {
      endpoint: this.get('S3_ENDPOINT'),
      region: this.get('S3_REGION'),
      bucket: this.get('S3_BUCKET'),
      accessKeyId: this.get('S3_ACCESS_KEY_ID'),
      secretAccessKey: this.get('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: this.get('S3_FORCE_PATH_STYLE'),
    } as const;
  }

  /**
   * AI configuration.
   *
   * `enabled` is false by default and no AI code exists in the codebase yet.
   * The budget values are hard ceilings enforced against the AiUsage ledger
   * before any call is dispatched — the guarantee is structural, not a promise
   * to watch a dashboard.
   */
  get ai() {
    return {
      enabled: this.get('AI_ENABLED'),
      apiKey: this.get('ANTHROPIC_API_KEY'),
      models: {
        classify: this.get('AI_MODEL_CLASSIFY'),
        dedup: this.get('AI_MODEL_DEDUP'),
        insight: this.get('AI_MODEL_INSIGHT'),
      },
      eventBudgetMicros: this.get('AI_EVENT_BUDGET_MICROS'),
      monthlyBudgetMicros: this.get('AI_MONTHLY_BUDGET_MICROS'),
    } as const;
  }

  get observability() {
    return {
      otelEnabled: this.get('OTEL_ENABLED'),
      otelEndpoint: this.get('OTEL_EXPORTER_OTLP_ENDPOINT'),
      sentryDsn: this.get('SENTRY_DSN'),
    } as const;
  }
}
