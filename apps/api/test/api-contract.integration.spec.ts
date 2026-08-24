import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { z } from 'zod';
import { ProblemDetails, TRACE_ID_HEADER } from '@eventq/contracts';
import { GlobalExceptionFilter } from '../src/shared/errors/global-exception.filter';
import { ZodValidationPipe } from '../src/shared/validation/zod-validation.pipe';
import { createZodDto } from '../src/shared/validation/zod-dto';
import { InvariantViolationError, NotFoundError } from '../src/shared/errors/domain-error';

/**
 * Contract tests for the HTTP edge.
 *
 * These exist because the most valuable guarantees in the error and validation
 * design are only observable over the wire: the content type, the status code,
 * the presence of a trace id, and the exact shape of `errors[]`. A unit test on
 * the filter would assert the object it constructs, not what a client receives.
 *
 * A throwaway controller is used deliberately — this verifies the SHARED
 * infrastructure, so it must not depend on any business endpoint existing.
 */

const CreateThing = z.object({
  title: z.string().min(3).max(20),
  count: z.number().int().positive().default(1),
  tags: z.array(z.string()).max(2).optional(),
});

class CreateThingDto extends createZodDto(CreateThing) {}

@Controller('things')
class ThingsController {
  @Post()
  create(@Body() body: CreateThingDto): { received: unknown } {
    return { received: body };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundError('No such thing.');
  }

  @Get('invalid-state')
  invalidState(): never {
    throw new InvariantViolationError('EVENT_NOT_LIVE', 'This event is not accepting questions.');
  }

  @Get('boom')
  boom(): never {
    throw new Error('Internal detail that must never reach a client');
  }
}

@Module({
  controllers: [ThingsController],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
class TestModule {}

describe('HTTP contract', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('validation', () => {
    it('accepts a valid body and applies schema defaults', async () => {
      const response = await request(app.getHttpServer())
        .post('/things')
        .send({ title: 'Valid title' })
        .expect(201);

      // `count` was omitted; the pipe returns the PARSED value, so the default
      // is already applied by the time the handler runs.
      expect(response.body.received).toEqual({ title: 'Valid title', count: 1 });
    });

    it('rejects an invalid body as problem+json with per-field errors', async () => {
      const response = await request(app.getHttpServer())
        .post('/things')
        .send({ title: 'no', count: -5, tags: ['a', 'b', 'c'] })
        .expect(400)
        .expect('Content-Type', /application\/problem\+json/);

      const problem = ProblemDetails.parse(response.body);
      expect(problem.code).toBe('VALIDATION_FAILED');
      expect(problem.status).toBe(400);

      // Every bad field is reported at once. Returning them one at a time turns
      // a single form submission into three round trips.
      const paths = problem.errors?.map((e) => e.path).sort();
      expect(paths).toEqual(['count', 'tags', 'title']);
    });

    it('reports array indices with bracket notation so clients can map them to fields', async () => {
      const response = await request(app.getHttpServer())
        .post('/things')
        .send({ title: 'Valid title', tags: [1] })
        .expect(400);

      expect(response.body.errors?.[0]?.path).toBe('tags[0]');
    });

    it('strips unknown keys so they can never reach the domain', async () => {
      const response = await request(app.getHttpServer())
        .post('/things')
        .send({ title: 'Valid title', isAdmin: true, role: 'OWNER' })
        .expect(201);

      // This is the mass-assignment guarantee. zod's default object behaviour
      // is to STRIP unknown keys rather than reject them, and stripping is the
      // security-relevant outcome: an attacker can post `isAdmin` or `role` all
      // day and neither value ever reaches a handler or a database write.
      //
      // (`.strict()` would 400 instead. Stripping is chosen deliberately: it is
      // equally safe and tolerant of clients sending a field a newer API
      // version added.)
      expect(response.body.received).toEqual({ title: 'Valid title', count: 1 });
      expect(response.body.received).not.toHaveProperty('isAdmin');
      expect(response.body.received).not.toHaveProperty('role');
    });
  });

  describe('error mapping', () => {
    it('maps a domain NotFoundError to 404 problem+json', async () => {
      const response = await request(app.getHttpServer()).get('/things/missing').expect(404);

      const problem = ProblemDetails.parse(response.body);
      expect(problem.code).toBe('NOT_FOUND');
      expect(problem.instance).toBe('/things/missing');
    });

    it('maps an invariant violation to 422 with its specific code', async () => {
      const response = await request(app.getHttpServer()).get('/things/invalid-state').expect(422);

      expect(ProblemDetails.parse(response.body).code).toBe('EVENT_NOT_LIVE');
    });

    it('never leaks internal detail from an unexpected error', async () => {
      const response = await request(app.getHttpServer()).get('/things/boom').expect(500);

      const problem = ProblemDetails.parse(response.body);
      expect(problem.code).toBe('INTERNAL_ERROR');
      // The message and stack belong in the log, not on the wire.
      expect(JSON.stringify(response.body)).not.toContain('Internal detail');
      expect(problem.traceId).toBeTruthy();
    });

    it('returns a trace id in both the header and the body, and they match', async () => {
      const response = await request(app.getHttpServer()).get('/things/missing').expect(404);

      // This is what makes a user-reported failure traceable without asking
      // them to reproduce it.
      expect(response.headers[TRACE_ID_HEADER]).toBeTruthy();
      expect(response.body.traceId).toBe(response.headers[TRACE_ID_HEADER]);
    });

    it('emits every error in one shape, so clients parse one thing', async () => {
      for (const path of ['/things/missing', '/things/invalid-state', '/things/boom']) {
        const response = await request(app.getHttpServer()).get(path);
        expect(() => ProblemDetails.parse(response.body)).not.toThrow();
      }
    });
  });
});
