# Development guide

## The layer rule

Every feature module in `apps/api/src/modules/` has the same four folders. The
dependency direction is enforced by ESLint, so a violation fails `pnpm lint`
rather than surviving review.

```
modules/<feature>/
  domain/          entities, value objects, PORT interfaces
  application/     use-cases - one class, one operation
  infrastructure/  adapters implementing domain ports
  presentation/    controllers, DTOs, guards
```

| Layer             | May import                        | May NOT import                                       |
| ----------------- | --------------------------------- | ---------------------------------------------------- |
| `domain/`         | nothing but other domain code     | NestJS, Prisma, Express, Redis, AWS, any outer layer |
| `application/`    | `domain/`, NestJS DI decorators   | Prisma, HTTP, `infrastructure/`, `presentation/`     |
| `infrastructure/` | anything; implements domain ports | —                                                    |
| `presentation/`   | `application/`, `domain/` types   | Prisma, `infrastructure/`                            |

**Why domain is framework-free.** It makes the interesting logic testable with
no container, no bootstrap and no mocks — which is why the unit suite runs in
milliseconds and is therefore actually run.

`modules/health/` is the reference implementation of the whole pattern, small
enough to read in two minutes.

### Adding a feature module

1. Define the port in `domain/` — an interface plus a `Symbol` DI token.
2. Write the use-case in `application/`, depending only on that port.
3. Implement the adapter in `infrastructure/`.
4. Wire port → adapter in `<feature>.module.ts`. **This is the only place the
   two meet.**
5. Add the controller in `presentation/`, calling the use-case.
6. Register the module in `app.module.ts`.

### When NOT to add an abstraction

The architecture explicitly warns against unnecessary abstraction. Do not create
a port when there is one obvious implementation and no test seam. Add it when a
second implementation appears, or when a test genuinely needs to substitute one.

---

## Contracts

`packages/contracts` is the single source of truth for anything crossing the
API/web boundary. Changing a schema there:

- retypes the web app,
- changes API validation,
- regenerates the OpenAPI document,

all from one edit. If you find yourself declaring the same shape twice, that is
the bug.

Enums are declared in both `contracts/src/enums.ts` and `schema.prisma` because
Postgres needs its own. A parity test
(`apps/api/src/shared/prisma/enum-parity.spec.ts`) fails CI if they diverge, in
either direction.

---

## Validation

Validation is opt-in per parameter:

```ts
const CreateThing = z.object({ title: z.string().min(3) });
class CreateThingDto extends createZodDto(CreateThing) {}

@Post()
create(@Body() body: CreateThingDto) { /* body is parsed and typed */ }
```

The pipe returns the **parsed** value, so defaults are applied, values are
coerced and unknown keys are stripped before your handler runs. A parameter with
no zod schema passes through untouched — nothing is silently coerced.

Document it from the same schema with `@ApiZodBody` / `@ApiZodResponse`.

---

## Errors

Throw a typed error from `shared/errors/domain-error.ts`. Never construct an
HTTP response in a controller.

```ts
throw new InvariantViolationError('EVENT_NOT_LIVE', 'This event is not accepting questions.');
```

One global filter renders it as problem+json with a `traceId`. Add new codes to
`ErrorCode` in `packages/contracts` so clients can branch on them.

`NotFoundError` is deliberately used where a row exists but belongs to another
organization — returning 403 there would confirm the id exists, which is a
cross-tenant enumeration oracle.

---

## Local infrastructure

```bash
pnpm db:up      # start
pnpm db:down    # stop, keep data
pnpm db:reset   # destroy volumes and start clean
```

Postgres uses the same `pgvector/pgvector:pg16` image as production, so
extension behaviour matches.

---

## Common problems

**`@prisma/client has no exported member PrismaClient`**
The generated client was wiped by an install. Run `pnpm --filter @eventq/api prisma:generate`.
A `postinstall` hook normally handles this.

**Integration tests cannot start containers**
Docker Desktop is not running. `docker info` should succeed.

**Web tests fail with "Invalid public environment configuration"**
`src/lib/env.ts` validates `NEXT_PUBLIC_*` at import. Vitest supplies
placeholders via `test.env`; a new variable must be added there too.

**Prettier and ESLint disagree**
They should not — `eslint-config-prettier` disables every stylistic rule.
If it happens, a rule was added outside the shared preset.
