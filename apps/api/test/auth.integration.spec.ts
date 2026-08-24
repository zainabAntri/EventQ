import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_HEADER,
  ProblemDetails,
  REFRESH_TOKEN_COOKIE,
} from '@eventq/contracts';
import { csrf, registerOrganizer, startTestApp, type TestApp } from './app.harness';

/**
 * Authentication behaviour, end to end against a real database and the real
 * guards.
 */
describe('organizer authentication', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await startTestApp();
  }, 180_000);

  afterAll(async () => {
    await testApp?.stop();
  });

  beforeEach(async () => {
    await testApp.db.truncate();
    await testApp.resetRateLimits();
  });

  describe('registration', () => {
    it('registers an organizer, their organization and an OWNER membership', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({
          email: 'ada@eventq.test',
          password: 'correct-horse-battery-staple',
          name: 'Ada Lovelace',
          organizationName: 'Analytical Engines',
        })
        .expect(201);

      expect(response.body.organizer).toMatchObject({
        email: 'ada@eventq.test',
        name: 'Ada Lovelace',
        organization: { name: 'Analytical Engines', role: 'OWNER' },
      });

      // An organizer with no organization could not create an event, so both
      // must exist after registration or the account is useless.
      const membership = await testApp.db.prisma.membership.findFirst({
        where: { userId: response.body.organizer.id },
      });
      expect(membership?.role).toBe('OWNER');
    });

    it('never returns the password hash', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(201);

      expect(JSON.stringify(response.body)).not.toContain('argon2');
      expect(response.body.organizer).not.toHaveProperty('passwordHash');
    });

    it('stores the password only as an argon2id hash', async () => {
      await registerOrganizer(testApp, {
        email: 'ada@eventq.test',
        password: 'correct-horse-battery-staple',
      });

      const user = await testApp.db.prisma.user.findUniqueOrThrow({
        where: { email: 'ada@eventq.test' },
      });

      expect(user.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user.passwordHash).not.toContain('correct-horse-battery-staple');
    });

    it('issues httpOnly session cookies rather than tokens in the body', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(201);

      const cookies = (response.headers['set-cookie'] as unknown as string[]).join('\n');

      // httpOnly is what stops an XSS payload from reading the session.
      expect(cookies).toContain(`${ACCESS_TOKEN_COOKIE}=`);
      expect(cookies).toContain(`${REFRESH_TOKEN_COOKIE}=`);
      expect(cookies).toMatch(/HttpOnly/i);
      expect(cookies).toMatch(/SameSite=Lax/i);
      expect(response.body).not.toHaveProperty('accessToken');
    });

    it('rejects a duplicate registration with 409, not 500', async () => {
      await registerOrganizer(testApp, { email: 'ada@eventq.test' });

      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({
          email: 'ada@eventq.test',
          password: 'a-completely-different-one',
          name: 'Impostor',
        })
        .expect(409);

      expect(ProblemDetails.parse(response.body).code).toBe('EMAIL_ALREADY_REGISTERED');
      expect(await testApp.db.prisma.user.count()).toBe(1);
    });

    it('treats email as case-insensitive so one address cannot register twice', async () => {
      await registerOrganizer(testApp, { email: 'ada@eventq.test' });

      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ADA@EventQ.TEST', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(409);

      expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('rejects a weak password with a field-level error', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'short', name: 'Ada' })
        .expect(400);

      const problem = ProblemDetails.parse(response.body);
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.errors?.map((e) => e.path)).toContain('password');
    });

    it('rejects a malformed email', async () => {
      await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'not-an-email', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(400);
    });

    it('ignores injected privilege fields (mass assignment)', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({
          email: 'ada@eventq.test',
          password: 'correct-horse-battery-staple',
          name: 'Ada',
          // None of these are in the contract. If any reached the database, an
          // attacker could grant themselves whatever they liked at signup.
          role: 'OWNER',
          emailVerifiedAt: new Date().toISOString(),
          mfaEnabled: true,
          id: '00000000-0000-7000-8000-000000000001',
        })
        .expect(201);

      const user = await testApp.db.prisma.user.findUniqueOrThrow({
        where: { email: 'ada@eventq.test' },
      });

      expect(user.id).not.toBe('00000000-0000-7000-8000-000000000001');
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.mfaEnabled).toBe(false);
      expect(response.body.organizer.emailVerified).toBe(false);
    });
  });

  describe('sign in', () => {
    beforeEach(async () => {
      await registerOrganizer(testApp, {
        email: 'ada@eventq.test',
        password: 'correct-horse-battery-staple',
      });
    });

    it('signs in with valid credentials', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple' })
        .expect(200);

      expect(response.body.organizer.email).toBe('ada@eventq.test');
      expect(response.headers['set-cookie']).toBeDefined();
    });

    it('rejects a wrong password with 401', async () => {
      const response = await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'wrong-password-entirely' })
        .expect(401);

      expect(ProblemDetails.parse(response.body).code).toBe('INVALID_CREDENTIALS');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('gives an identical response for an unknown email and a wrong password', async () => {
      // Any difference here turns login into an account-enumeration oracle:
      // an attacker could confirm which addresses are registered.
      const unknownEmail = await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'nobody@eventq.test', password: 'correct-horse-battery-staple' })
        .expect(401);

      const wrongPassword = await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'wrong-password-entirely' })
        .expect(401);

      expect(unknownEmail.body.code).toBe(wrongPassword.body.code);
      expect(unknownEmail.body.detail).toBe(wrongPassword.body.detail);
      expect(unknownEmail.body.title).toBe(wrongPassword.body.title);
    });

    it('locks the account after repeated failures', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await testApp
          .http()
          .post('/api/v1/auth/login')
          .set(csrf)
          .send({ email: 'ada@eventq.test', password: 'wrong-password-entirely' })
          .expect(401);
      }

      const locked = await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'wrong-password-entirely' })
        .expect(429);

      expect(locked.body.code).toBe('ACCOUNT_LOCKED');
      expect(locked.headers['retry-after']).toBeDefined();

      // Even the CORRECT password is refused while locked - otherwise the
      // lockout would not slow an attacker down at all.
      await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple' })
        .expect(429);
    });

    it('clears the failure counter after a successful sign-in', async () => {
      await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'wrong-password-entirely' })
        .expect(401);

      await testApp
        .http()
        .post('/api/v1/auth/login')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple' })
        .expect(200);

      const user = await testApp.db.prisma.user.findUniqueOrThrow({
        where: { email: 'ada@eventq.test' },
      });
      expect(user.failedLoginCount).toBe(0);
      expect(user.lockedUntil).toBeNull();
    });
  });

  describe('session and authorization', () => {
    it('rejects an unauthenticated request to a protected route', async () => {
      const response = await testApp.http().get('/api/v1/auth/me').expect(401);
      expect(ProblemDetails.parse(response.body).code).toBe('UNAUTHENTICATED');
    });

    it('rejects a forged access token', async () => {
      await testApp
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', `${ACCESS_TOKEN_COOKIE}=not.a.real.token`)
        .expect(401);
    });

    it('returns the signed-in organizer', async () => {
      const organizer = await registerOrganizer(testApp, { email: 'ada@eventq.test' });

      const response = await testApp
        .http()
        .get('/api/v1/auth/me')
        .set('Cookie', organizer.cookie)
        .expect(200);

      expect(response.body.organizer.email).toBe('ada@eventq.test');
      expect(response.body.organizer.organization.id).toBe(organizer.orgId);
    });

    it('blocks a state-changing request that omits the CSRF header', async () => {
      const organizer = await registerOrganizer(testApp);

      // A cross-site form POST carries cookies but cannot set a custom header.
      const response = await testApp
        .http()
        .post('/api/v1/auth/logout')
        .set('Cookie', organizer.cookie)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.detail).toContain(CSRF_HEADER);
    });

    it('enforces CSRF on public state-changing routes too', async () => {
      // Login is public but still state-changing: without this, an attacker
      // could force a victim's browser to sign in as the attacker and then
      // silently observe what the victim does in that session.
      await testApp
        .http()
        .post('/api/v1/auth/login')
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple' })
        .expect(403);
    });

    it('does not require the CSRF header on safe methods', async () => {
      // GET must not change state, so demanding the header there would only
      // break ordinary navigation.
      const organizer = await registerOrganizer(testApp);
      await testApp.http().get('/api/v1/auth/me').set('Cookie', organizer.cookie).expect(200);
    });

    it('signs out and invalidates the refresh token', async () => {
      const agent = testApp.http();
      await agent
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(201);

      await agent.post('/api/v1/auth/logout').set(csrf).expect(204);

      // The agent still holds whatever cookies the server left; refresh must
      // now fail regardless.
      await agent.post('/api/v1/auth/refresh').set(csrf).expect(401);
    });

    it('signing out twice is not an error', async () => {
      const agent = testApp.http();
      await agent
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(201);

      await agent.post('/api/v1/auth/logout').set(csrf).expect(204);
      await agent.post('/api/v1/auth/logout').set(csrf).expect(204);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates the session and issues a new refresh token', async () => {
      const agent = testApp.http();
      await agent
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(201);

      const refreshed = await agent.post('/api/v1/auth/refresh').set(csrf).expect(200);
      expect(refreshed.body.organizer.email).toBe('ada@eventq.test');

      const sessions = await testApp.db.prisma.authSession.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(sessions).toHaveLength(2);
      // The old token is marked rotated, not deleted - that record is what
      // makes a later replay detectable.
      expect(sessions[0]?.rotatedAt).not.toBeNull();
      expect(sessions[1]?.rotatedAt).toBeNull();
      // Both belong to one family, so revoking it signs out this device only.
      expect(sessions[0]?.familyId).toBe(sessions[1]?.familyId);
    });

    it('revokes the whole family when a rotated token is replayed', async () => {
      const agent = testApp.http();
      const registered = await agent
        .post('/api/v1/auth/register')
        .set(csrf)
        .send({ email: 'ada@eventq.test', password: 'correct-horse-battery-staple', name: 'Ada' })
        .expect(201);

      const originalCookies = (registered.headers['set-cookie'] as unknown as string[])
        .map((entry) => entry.split(';')[0])
        .join('; ');

      await agent.post('/api/v1/auth/refresh').set(csrf).expect(200);

      // Replaying the ORIGINAL token: either the client repeated itself or the
      // token was stolen. We cannot tell, so we assume theft.
      const replay = await testApp
        .http()
        .post('/api/v1/auth/refresh')
        .set(csrf)
        .set('Cookie', originalCookies)
        .expect(401);

      expect(replay.body.code).toBe('TOKEN_REUSE_DETECTED');

      const active = await testApp.db.prisma.authSession.count({ where: { revokedAt: null } });
      expect(active).toBe(0);

      // The legitimate session is gone too. That is the point: a real theft
      // forces everyone to sign in again, which is visible to the victim.
      await agent.post('/api/v1/auth/refresh').set(csrf).expect(401);
    });

    it('rejects refresh with no session', async () => {
      await testApp.http().post('/api/v1/auth/refresh').set(csrf).expect(401);
    });
  });

  describe('rate limiting', () => {
    /**
     * Counters are cleared between tests so unrelated assertions are not
     * poisoned by a shared bucket. That makes THIS test essential: without it,
     * the reset helper could quietly be disabling the limiter and every other
     * test would still pass.
     */
    it('blocks registration from one IP after the limit is reached', async () => {
      const attempt = (n: number) =>
        testApp
          .http()
          .post('/api/v1/auth/register')
          .set(csrf)
          .send({
            email: `flood-${n}@eventq.test`,
            password: 'correct-horse-battery-staple',
            name: `Flood ${n}`,
          });

      // The rule allows 5 per hour per IP.
      for (let n = 0; n < 5; n += 1) {
        expect((await attempt(n)).status).toBe(201);
      }

      const blocked = await attempt(5);
      expect(blocked.status).toBe(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(blocked.headers['retry-after']).toBeDefined();

      // The sixth account must not exist. A limiter that returns 429 *after*
      // doing the work protects nothing.
      expect(await testApp.db.prisma.user.count()).toBe(5);
    });
  });
});
