# EventQ

Event Q&A and audience-engagement platform.

An organizer creates an event; the system mints a join code, QR code and public URL. Attendees scan and submit questions **without creating an account**. Questions are validated, moderated, ranked and organised, and the organizer works them in a real-time dashboard.

The first use case is business networking events. The architecture deliberately absorbs conferences, seminars, workshops, university events, webinars, corporate meetings and panel discussions without a schema change.

> **Status: phases 1–8 complete; Phase 9 (security audit and hardening) in progress.** Organizer auth, the event lifecycle, anonymous attendee submission, the moderation console, upvoting with duplicate-merging, the optional AI layer, the organizer event experience (QR, poster, branding) and Event Insights are all built, tested and merged.
>
> A $0 deployment runs on the public internet — web on Vercel, API and Redis on Render, Postgres on Supabase. See [`docs/deploy-free-tier.md`](docs/deploy-free-tier.md).
>
> Not yet built: projector view, logo upload, exports and team invites.
>
> Full status, open issues and the decisions behind them: [`docs/progress.md`](docs/progress.md).

---

## Architecture at a glance

```
apps/
  web/          Next.js 16 App Router  ->  Vercel
  api/          NestJS 11 modular monolith  ->  Render today; ECS Fargate is the production target
packages/
  contracts/    zod schemas shared by both apps - the single source of truth
  config/       shared ESLint presets, including the architecture boundary rules
```

**Why a modular monolith.** Feature modules have enforced internal boundaries (`domain` → `application` → `infrastructure` → `presentation`). If a context ever needs its own deployment, extracting it is a packaging change rather than a rewrite. Premature microservices would buy operational cost we cannot yet justify.

**Why `packages/contracts`.** Every wire format, enum and permission is declared exactly once. The API validates against it, the web app is typed by it, and the OpenAPI document is generated from it. The two apps cannot drift, because a breaking change fails both typechecks in the same commit.

**The layer rule is enforced by CI, not by convention.** Importing Prisma or NestJS inside a `domain/` folder fails `pnpm lint`. Architecture that is not enforced decays within a month.

Full design: [`docs/architecture.md`](docs/architecture.md). Working on the code: [`docs/development.md`](docs/development.md), which explains the layer rule and how to add a feature module without fighting it.

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

### After pulling a schema change

Run `pnpm db:deploy` whenever a pull or a branch switch brings a new migration.

This is worth a habit, because the failure is misleading. Prisma will happily query a column your local database does not have yet; Postgres rejects it, and the API returns a generic 500 with a `traceId`. The dashboard then looks half-broken — the moderation tab counts render fine, because counting rows never selects the new column, while the question list underneath them fails. It reads like an application bug and is not one.

`db:deploy` (`prisma migrate deploy`) only applies pending migrations. Prefer it over `db:migrate` (`prisma migrate dev`), which can decide your database has drifted and offer to reset it — taking your seeded demo event with it. Details in [`docs/migrations.md`](docs/migrations.md).

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

The AI layer is **built and merged, and off by default**. The product is designed to be fully functional with AI switched off permanently, and the default configuration spends nothing.

Two independent switches must both be on before a single call is made:

| Switch                    | Default | Scope                |
| ------------------------- | ------- | -------------------- |
| `AI_ENABLED`              | `false` | the whole deployment |
| `EventSettings.aiEnabled` | `false` | one event            |

Everything runs in background workers outside the request path, tiered so the high-volume mechanical work uses the cheap model: `claude-haiku-4-5` for classification and de-duplication, `claude-sonnet-5` for summaries. A hard per-event budget is enforced _before_ each call against a usage ledger (`AI_EVENT_BUDGET_MICROS`, default $2), with a monthly ceiling on top of it. Estimated real cost: ~$1.15 per 500-question event.

Enabling it needs `ANTHROPIC_API_KEY`. Without one the app runs exactly as it does now.

The database reserves tables for it (`question_enrichments`, `topics`, `ai_usage`) because adding columns to `questions` — the hottest table — later could mean a migration during a live event. Empty tables cost nothing.

---

## Notes

- **TypeScript is pinned to 6.0.3, not 7.x.** TS 7 compiles correctly, but `typescript-eslint` hard-throws on it (support tracked for ≥ 7.1). Losing lint means losing the architecture boundaries, which is the worse trade.
- **A benign boot warning.** NestJS logs `Unsupported route path: "/api/v1/*"` when a global prefix has exclusions. It auto-converts correctly and is internal to the framework; there is no userland setting to silence it.
