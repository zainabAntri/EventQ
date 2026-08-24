import { Test } from '@nestjs/testing';
import { type INestApplication, RequestMethod } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@eventq/contracts';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { RedisService } from '../src/shared/redis/redis.service';
import { startTestDatabase, type TestDatabase } from './database.harness';

/**
 * Boots the REAL application against a REAL database.
 *
 * Deliberately not a partial module with stubs: the guards, the global pipe,
 * the exception filter and the cookie handling are the things most worth
 * testing, and a hand-assembled test module would quietly omit exactly those.
 * If AuthGuard is misconfigured, these tests fail.
 */
export interface TestApp {
  app: INestApplication;
  db: TestDatabase;
  http: () => request.Agent;
  /**
   * Clears rate-limit counters between tests.
   *
   * Every test hits the API from 127.0.0.1, so they all share one bucket and
   * Redis keeps counting across test boundaries — test six would 429 for
   * reasons that have nothing to do with what it is asserting.
   *
   * Deliberately NOT solved by raising the limits: the limiter stays fully
   * active, and a dedicated test asserts that it actually blocks.
   */
  resetRateLimits: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const db = await startTestDatabase();

  // The config module validates these at boot, so they must be present and
  // valid. All placeholders - no real secret is involved.
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = db.connectionString;
  process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  process.env['JWT_ACCESS_SECRET'] = 'test-access-secret-that-is-long-enough-1234567890';
  process.env['ATTENDEE_TOKEN_SECRET'] = 'test-attendee-secret-that-is-different-0987654321';
  process.env['WEB_ORIGIN'] = 'http://localhost:3000';
  process.env['API_PUBLIC_URL'] = 'http://localhost:4000';
  process.env['CORS_ALLOWED_ORIGINS'] = 'http://localhost:3000';
  process.env['S3_BUCKET'] = 'test-bucket';
  process.env['S3_ACCESS_KEY_ID'] = 'test-key';
  process.env['S3_SECRET_ACCESS_KEY'] = 'test-secret';

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // The app must talk to the throwaway container, not whatever DATABASE_URL
    // happened to be set when the process started.
    .overrideProvider(PrismaService)
    .useValue(db.prisma)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  await app.init();

  const redis = app.get(RedisService);

  return {
    app,
    db,
    http: () => request.agent(app.getHttpServer()),

    async resetRateLimits() {
      try {
        const keys = await redis.client.keys('eventq:ratelimit:*');
        if (keys.length > 0) await redis.client.del(...keys);
      } catch {
        // Redis absent locally: the limiter fails open outside production, so
        // there is nothing to clear and nothing to fail over.
      }
    },

    async stop() {
      await app.close();
      await db.stop();
    },
  };
}

/**
 * Every state-changing request needs the CSRF header. Tests send it explicitly
 * so that a regression removing the requirement would be visible here rather
 * than silently passing.
 */
export const csrf = { [CSRF_HEADER]: CSRF_HEADER_VALUE } as const;

export interface RegisteredOrganizer {
  email: string;
  password: string;
  userId: string;
  orgId: string;
  /** Cookie header value carrying this organizer's session. */
  cookie: string;
}

/** Registers an organizer and returns their session cookies. */
export async function registerOrganizer(
  testApp: TestApp,
  overrides: Partial<{
    email: string;
    password: string;
    name: string;
    organizationName: string;
  }> = {},
): Promise<RegisteredOrganizer> {
  const email = overrides.email ?? `organizer-${randomSuffix()}@eventq.test`;
  const password = overrides.password ?? 'correct-horse-battery-staple';

  const response = await testApp
    .http()
    .post('/api/v1/auth/register')
    .set(csrf)
    .send({
      email,
      password,
      name: overrides.name ?? 'Test Organizer',
      ...(overrides.organizationName ? { organizationName: overrides.organizationName } : {}),
    })
    .expect(201);

  const cookies = response.headers['set-cookie'] as unknown as string[] | undefined;
  if (!cookies) throw new Error('Registration returned no session cookies');

  return {
    email,
    password,
    userId: response.body.organizer.id,
    orgId: response.body.organizer.organization.id,
    cookie: cookies.map((entry) => entry.split(';')[0]).join('; '),
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
