# EventQ architecture

The approved design, recorded here so it lives with the code.

---

## 1. What we are building

An organizer creates an event; the system mints a join code, QR code and public URL. Attendees scan and submit questions **without an account**. Questions are validated, moderated, ranked and organised; organizers and speakers work them in a real-time dashboard.

Three forces shape every decision:

1. **Traffic is event-shaped.** A venue is idle, then 800 people scan the same QR code inside 90 seconds and hold live connections for an hour. The **read** path is the scaling problem, not the write path.
2. **The first use case is the narrowest one.** Conferences need multi-track sessions, universities need true anonymity, corporate town halls need enforced identity. The model must absorb all of them without a rewrite.
3. **AI must be strictly optional.** If the provider is unreachable or a budget cap trips, EventQ stays a fully working Q&A product.

## 2. Non-functional targets

| Category      | Target                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| Latency       | submit p95 < 300 ms; list p95 < 200 ms; realtime fan-out p95 < 1 s            |
| Scale         | 2,000 concurrent attendees/event; 50 submits/sec/event; 200 concurrent events |
| Availability  | 99.9% API; degraded-but-usable without Redis or AI                            |
| Durability    | RPO ≤ 5 min, RTO ≤ 1 h                                                        |
| Accessibility | WCAG 2.2 AA on every attendee and dashboard surface                           |
| Web vitals    | LCP < 2.0 s, CLS < 0.1, INP < 200 ms on 4G mobile                             |

**Degradation ladder.** AI down → questions still flow, enrichment marked `FAILED`. Redis down → realtime and caching stop, submissions still work. Postgres down → hard outage (accepted; Multi-AZ mitigates).

## 3. Roles

`OWNER` · `ADMIN` · `MODERATOR` · `SPEAKER` are organization-scoped. **Attendee is not a role** — it is a pseudonymous, device-scoped and _event-scoped_ identity.

Permissions are a declarative matrix in `packages/contracts/src/permissions.ts`, shared so the UI can only offer actions the API will allow. The UI using it is convenience; the API enforces it regardless.

## 4. Core journeys

Organizer runs an event · attendee scans and asks · moderator clears a queue by keyboard · speaker works the board on stage · projector shows the room · organizer reviews insights afterwards.

## 5–6. Domain and data

Bounded contexts inside a **modular monolith**: Identity & Access, Events, Q&A, Intelligence, Platform.

Aggregate invariants live in domain entities, not controllers:

- Questions may only be submitted while an event is `LIVE`.
- A question cannot merge into itself or form a cycle; a merged question transfers its votes exactly once.
- An organization always has exactly one owner.
- **Attendee identity is scoped to one event.** The same person at two events is two rows — this removes cross-event tracking entirely and makes per-event PII purging a clean delete.

Indexes that matter: `(eventId, status, rankScore DESC)` for the live board, `(eventId, status, createdAt DESC)` for the moderation queue, a unique `(questionId, attendeeId)` that makes double-voting _structurally_ impossible, a GIN trigram index for free duplicate detection, and HNSW on the reserved vector columns.

`upvoteCount` and `rankScore` are denormalised and maintained in-transaction; ranking is computed in SQL, never by loading rows into the application.

## 7. API boundaries

Three surfaces with different auth and different threat models — a security boundary, not organisational tidiness:

- `/api/v1/public/*` — attendee token, aggressive rate limits, never returns another attendee's PII or an unapproved question
- `/api/v1/*` — organizer session, org-scoped, permission-checked
- `/health/*` — unversioned, so probe URLs survive a version bump

Cursor pagination throughout: offset pagination is wrong for a list that mutates while it is being read.

## 8. Frontend

Next.js App Router on Vercel. Server Components by default; `"use client"` pushed to leaves. **No business logic in components** — ranking, permissions and state transitions belong to the API. All data flows through the typed contract client; bare `fetch` is a lint error.

## 9. Backend

NestJS modular monolith with Clean Architecture inside each feature module, enforced by ESLint (see [development.md](development.md)).

**Realtime is SSE, not WebSockets** — _where realtime is used at all_. Every realtime need is server→client; client actions travel over REST. SSE gives plain HTTP through the ALB, no sticky sessions, and native reconnect with `Last-Event-ID`. Socket.IO would add a dependency, sticky sessions and a second protocol for no functional gain. An `EventPublisher` port keeps a WebSocket adapter possible if bidirectional needs ever appear.

**The organizer dashboard does not use it, and that is deliberate.** The protocol is specified in `@eventq/contracts/realtime.ts` and is intended for the projector and the attendee board, where a room full of people watch one screen. A moderation queue is a different problem: a handful of viewers, and a question arriving five seconds late is invisible to the person working through the list. Standing an SSE endpoint up for it would mean Redis fan-out across API instances, per-connection authentication, per-event subscription authorization, heartbeats and a stale-connection reaper — a permanent operational commitment bought with no user-visible gain.

Instead the dashboard polls `GET /events/:id/questions/stats` every five seconds. That endpoint is a single grouped count over an indexed column; it returns the tab badges the dashboard needs anyway, plus a `version` token that moves on any insert, status change or archive. The expensive list query re-runs only when the token moves, and polling stops entirely while the browser tab is hidden. Anyone reading `realtime.ts` and expecting a live stream on the dashboard should read this paragraph first.

**Background work uses a transactional outbox.** The domain change and its `OutboxEvent` commit together, then a relay publishes to the queue. This is what prevents "row committed, job lost", and it keeps Postgres — not Redis — the durable source of truth.

## 10–11. Authentication and authorization

Organizer: argon2id passwords, short-lived access JWT, and an opaque refresh token with **family-based rotation and reuse detection** — replaying a rotated token revokes the whole family, turning a stolen token into a single-use event.

Attendee: an httpOnly JWT bound to one event, minted on first scan. Not a login — a device-scoped identity that enables rate limiting, one-vote-per-person and self-service deletion, with zero PII required.

> **The cross-origin cookie problem is the highest risk in the whole design.** The web app (Vercel) and API (AWS) must sit on sibling subdomains of one registrable domain — `app.eventq.io` and `api.eventq.io` — so they are _same-site_ and `SameSite=Lax` cookies flow on XHR. On different apex domains the browser drops them and auth simply does not work. Vercel preview deploys on `*.vercel.app` are a different site and need custom preview domains. This gets prototyped and verified in Safari before any Phase 2 feature work.

Authorization is enforced in **three** layers, because one missed decorator should not be a data leak: a guard resolving org membership, an org predicate on every tenant query (with a Prisma extension asserting its presence), and domain invariants that hold regardless of caller.

## 12. Security

zod validation at every boundary with NFKC normalisation; user text rendered as text only; nonce-based CSP and HSTS; Redis sliding-window rate limits; secrets in Secrets Manager and Vercel env, validated at boot; per-event retention with automatic PII purge.

Attendee text reaching a model is treated as **untrusted data, never instruction**: delimited, schema-constrained via structured outputs, and never able to trigger a side effect. No AI output is ever auto-published.

## 13. AI

**Not built. No SDK installed. `AI_ENABLED=false`.**

When enabled it runs entirely outside the request path — a question is persisted and acknowledged before any model is consulted. The pipeline is tiered cheapest-first: normalisation and `pg_trgm` similarity (free), local embeddings (free), then a small model for the high-volume classification, and a stronger one only for low-volume judgement work. Prompt caching, micro-batching and the Batch API cut it further.

Every call writes to an `AiUsage` ledger and a **hard per-event budget is checked before dispatch**. On breach, AI stops and the product keeps working. That makes an unexpected bill structurally impossible rather than something to notice afterwards.

## 14. Errors

Typed domain errors with stable codes → one global filter → RFC 9457 `application/problem+json`, always carrying a `traceId`. Internal detail is logged, never wired. `Idempotency-Key` on submission, because venue wifi genuinely drops requests.

## 15. Testing

See [testing.md](testing.md). The core rule: Prisma is never mocked, and frontend queries go through the accessibility tree.

## 16. Deployment

Web → Vercel. API → AWS ECS Fargate behind an ALB, with RDS Postgres 16 (Multi-AZ), ElastiCache, S3 and Secrets Manager. IaC in AWS CDK (TypeScript, same language as everything else).

Migrations run as a **one-off ECS task gated before the service update**, never in a container entrypoint. See [migrations.md](migrations.md).

No Vercel-proprietary API is used in application code, so the frontend stays portable.

## 17. SEO

Marketing routes are SSG/ISR with JSON-LD and dynamic OG images; `/solutions/[vertical]` pages serve the multi-vertical go-to-market.

**Application routes are `noindex` by default and enforced twice** (header + robots.txt). An indexed event page would expose attendee questions publicly — a privacy incident, not an SEO mistake. A public event page is indexable only when the organizer explicitly opts in.

## 18. Observability

pino JSON logs with a correlation id propagated into background jobs; PII redacted by allowlist. OpenTelemetry spans from HTTP through use-case to database. The metric that actually reflects attendee experience is **moderation latency (submit → approve) p50/p95**. Alerting is on SLO burn rate, not raw spikes — spiky traffic is normal here and threshold alerts would page constantly.

## 19. Backup and recovery

RDS PITR (30 days in production) with cross-region snapshot copies, plus an independent nightly logical dump. **A monthly restore drill with measured RTO/RPO** — an untested backup is not a backup. Redis is expendable; in-flight work is recoverable from the outbox table.

## 20. Scalability

Designed for now: stateless API scaling horizontally, SSE fan-out via Redis pub/sub, denormalised counters, SQL-side ranking, a short-TTL per-event cache so a 5,000-person room becomes one cache read, and workers scaling on queue depth.

Deliberately **not** built yet — each an open option, not a hidden assumption: microservices, event sourcing, CQRS with separate stores, table partitioning, GraphQL, Kubernetes.

Growth path in the order it will actually be needed: read replica for analytics → cache warming before scheduled starts → multi-region reads → offline-first PWA submission queue (venue wifi is the most common real-world failure) → per-session ranking for multi-track conferences → white-label domains.
