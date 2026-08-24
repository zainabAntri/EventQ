# EventQ

Event Q&A and audience-engagement platform.

An organizer creates an event; the system mints a join code, QR code and public URL. Attendees scan and submit questions **without creating an account**. Questions are validated, moderated, ranked and organised, and the organizer works them in a real-time dashboard.

The first use case is business networking events. The architecture deliberately absorbs conferences, seminars, workshops, university events, webinars, corporate meetings and panel discussions without a schema change.

> **Status: Phase 1 (foundation) complete.** The infrastructure below is built, tested and verified running. Business features — auth, events, questions, moderation — arrive in Phase 2.

---

## Architecture at a glance

```
apps/
  web/          Next.js 16 App Router  ->  Vercel
  api/          NestJS 11 modular monolith  ->  AWS ECS Fargate
packages/
  contracts/    zod schemas shared by both apps - the single source of truth
  config/       shared ESLint presets, including the architecture boundary rules
```

**Why a modular monolith.** Feature modules have enforced internal boundaries (`domain` → `application` → `infrastructure` → `presentation`). If a context ever needs its own deployment, extracting it is a packaging change rather than a rewrite. Premature microservices would buy operational cost we cannot yet justify.

**Why `packages/contracts`.** Every wire format, enum and permission is declared exactly once. The API validates against it, the web app is typed by it, and the OpenAPI document is generated from it. The two apps cannot drift, because a breaking change fails both typechecks in the same commit.

**The layer rule is enforced by CI, not by convention.** Importing Prisma or NestJS inside a `domain/` folder fails `pnpm lint`. Architecture that is not enforced decays within a month.

Full design: [`docs/architecture.md`](docs/architecture.md).

---

## Prerequisites

| Tool    | Version | Notes                                   |
| ------- | ------- | --------------------------------------- |
| Node.js | ≥ 22    | 24.x is what this was developed against |
| pnpm    | ≥ 10    | `corepack enable` is the easiest route  |
| Docker  | ≥ 24    | Runs Postgres, Redis and MinIO locally  |

No local PostgreSQL install is needed — Docker provides it, with the same `pgvector` image used in production.

---

## Setup

```bash
git clone https://github.com/zainabAntri/EventQ.git
cd EventQ
pnpm install

# Configure. Never commit the result.
cp .env.example .env
cp .env.example apps/api/.env
cp .env.example apps/web/.env.local

# Generate real secrets for the two token values in .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

pnpm db:up        # Postgres + Redis + MinIO
pnpm db:migrate   # apply migrations
pnpm db:seed      # demo org, 4 users, a live event (prints the password)
pnpm dev          # web :3000, api :4000
```

Then:

| URL                                | What                                       |
| ---------------------------------- | ------------------------------------------ |
| http://localhost:3000              | Web app                                    |
| http://localhost:4000/health/ready | API readiness, with real dependency status |
| http://localhost:4000/api/docs     | OpenAPI UI (non-production only)           |
| http://localhost:9001              | MinIO console                              |

The seed prints a generated password and the demo join code (`EVENTQ26`). Passwords are **never** hard-coded — set `SEED_PASSWORD` to choose your own.

> Join codes use a Crockford-style alphabet that excludes `I`, `L`, `O` and `U`, because codes get read aloud across a noisy room. `DEMO2026` is _not_ a valid code — the `O` is excluded.

---

## Scripts

| Command                                     | Does                                      |
| ------------------------------------------- | ----------------------------------------- |
| `pnpm dev`                                  | Runs web and api in watch mode            |
| `pnpm build`                                | Builds every package                      |
| `pnpm lint`                                 | ESLint, including architecture boundaries |
| `pnpm typecheck`                            | `tsc --noEmit` everywhere                 |
| `pnpm test`                                 | Unit tests (fast, no I/O)                 |
| `pnpm test:integration`                     | Integration tests against real containers |
| `pnpm test:e2e`                             | Playwright; starts both servers itself    |
| `pnpm verify`                               | format + lint + typecheck + unit + build  |
| `pnpm verify:full`                          | `verify` plus integration tests           |
| `pnpm db:up` / `db:down` / `db:reset`       | Local infrastructure                      |
| `pnpm db:migrate` / `db:deploy` / `db:seed` | Database lifecycle                        |
| `pnpm format`                               | Prettier write                            |

---

## Testing

| Layer         | Tool                     | What it proves                                                                                                                                                          |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit          | Vitest                   | Domain logic, in milliseconds, with no I/O                                                                                                                              |
| Integration   | Vitest + Testcontainers  | Real Postgres, real migrations, real constraints. **Prisma is never mocked** — a mocked ORM verifies the mock, not the unique index that makes double-voting impossible |
| HTTP contract | Supertest                | problem+json shape, status codes, trace-id propagation                                                                                                                  |
| Frontend      | Vitest + Testing Library | Queried through the accessibility tree, so a test can only pass if a screen-reader user could also succeed                                                              |
| Accessibility | axe-core                 | jsdom for structure; Playwright for real-browser colour contrast                                                                                                        |
| E2E           | Playwright               | Chromium + mobile Safari (attendees arrive on phones)                                                                                                                   |

More: [`docs/testing.md`](docs/testing.md).

---

## Security

- **No secret is ever committed.** `.env*` is gitignored except the example; CI runs `gitleaks` over full history.
- **Every environment variable is validated at boot** by a zod schema. A missing or malformed value stops the process immediately, and production additionally refuses to start with insecure cookies, a wildcard CORS origin, or a placeholder secret.
- **One error shape.** Every failure is RFC 9457 `application/problem+json` with a `traceId`. Internal detail never reaches a client.
- **Unknown request fields are stripped**, so mass-assignment cannot reach the domain.
- **Strict TypeScript everywhere**, never relaxed to make something compile.

---

## AI

EventQ has **no AI services and no AI SDK installed**. `AI_ENABLED=false` is the default and the product is designed to be fully functional with AI switched off permanently.

When it is eventually enabled (Phase 4), it runs entirely in background workers outside the request path, tiered so the high-volume mechanical work uses a small model, with a hard per-event budget enforced _before_ each call against a usage ledger. Estimated ceiling: ~$1.15 per 500-question event, capped at $2.

The database reserves tables for it (`question_enrichments`, `topics`, `ai_usage`) because adding columns to `questions` — the hottest table — later could mean a migration during a live event. Empty tables cost nothing.

---

## Notes

- **TypeScript is pinned to 6.0.3, not 7.x.** TS 7 compiles correctly, but `typescript-eslint` hard-throws on it (support tracked for ≥ 7.1). Losing lint means losing the architecture boundaries, which is the worse trade.
- **A benign boot warning.** NestJS logs `Unsupported route path: "/api/v1/*"` when a global prefix has exclusions. It auto-converts correctly and is internal to the framework; there is no userland setting to silence it.
