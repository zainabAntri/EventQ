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

### Voting: who is "one person" without an account?

A vote is attached to the attendee token — a signed, event-scoped identity in an httpOnly cookie — and never to an IP address, because a venue shares one NAT address between hundreds of legitimate people. Four layers, each covering another's blind spot: the **signature** (a vote cannot be cast for an identity we never issued), the **unique index** on `(questionId, attendeeId)` (one vote per identity, decided by Postgres), a **per-attendee** rate limit (30 changes/min — the precise layer), and a deliberately **loose per-IP** limit (1200/min — bounds a script minting fresh identities without throttling a room told to "vote now"). Vote and unvote are `PUT`/`DELETE` and idempotent: a double-tap, a retry on dropped wifi and a page refresh all yield the same state as one honest vote. A `FOR UPDATE` row lock serialises concurrent votes on one question so the denormalised count can never drift from the rows; an integration test asserts this under ten genuinely concurrent requests.

**The accepted limit, stated plainly:** a device that clears its cookie is a new attendee and may vote again. Closing that without accounts would require browser fingerprinting, which is the cross-device tracking this product promises not to do. It is contained instead: joining is rate limited per IP, and votes enter the ranking as `log10(votes + 1)`, so a hundred manufactured votes buy about four points — two hours of recency. Manipulation is possible, expensive and nearly worthless. A test named `KNOWN LIMIT` documents it.

### Duplicate questions: suggest, never decide

Detection is deterministic and free. Postgres recalls the ten nearest live questions by character trigram (a low bar, 0.2, so a reworded question makes the list at all); the domain then scores each on the max of trigram similarity and content-word overlap — stopwords removed, plurals folded, Dice coefficient — and suggests the best above 0.6. That is what catches "How can businesses use AI?" against "How can I use AI in my company?", which trigrams alone score around 0.3. The suggestion lives on the question row (`possibleDuplicateOfQuestionId`, `duplicateSimilarity`), holds the newer question for a moderator, and does nothing else: a **merge** archives the copy into the survivor and moves its votes exactly once; a **dismiss** clears the suggestion and leaves the question where it was. Both append to the audit trail. Merging into a question that has itself been merged is refused, which is what makes a cycle impossible.

The known false positive — one changed noun, as in "…use Excel in my company?" — is kept visible by a test rather than tuned away. Word overlap cannot see meaning; that boundary is exactly where a semantic model would earn its cost, and it stays off until an organizer switches AI on for their event.

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

The microphone is allowed for this site only (`Permissions-Policy: microphone=(self)`), for the attendee's optional "Speak your question" button. Transcription is the browser's own Web Speech API, so no audio reaches EventQ's servers; but Chrome sends it to Google to transcribe (Safari does it on the device), and the form says so beside the button.

Attendee text reaching a model is treated as **untrusted data, never instruction**: delimited, schema-constrained via structured outputs, and never able to trigger a side effect. No AI output is ever auto-published.

## 13. AI

**Optional, off by default at two switches, and never automatic.** `AI_ENABLED=false` on the server and `settings.aiEnabled=false` on every new event; with either off, no model is ever called and the product is complete. When both are on, every AI call is a button an organizer pressed on the dashboard, next to the spend so far and the cap. Attendee paths cannot reach a model at all — there is no code from `/api/v1/public/*` to the AI module — so an AI outage cannot make asking, listing or voting fail. An integration test proves it with the provider throwing on every call.

**One seam.** `modules/ai/domain/ai-provider.port.ts` is the whole of the dependence on any vendor: one method, one structured completion, typed failures with a `kind` and a `retryable` flag. The Anthropic SDK is imported in exactly one file (`infrastructure/anthropic-ai.provider.ts`) with `maxRetries: 0` so retry policy lives in one place. The tests swap the provider for a scripted fake by overriding the DI token; swapping the vendor is the same operation.

**One path.** `application/ai-runner.ts` applies the same policy to every call, in order: switches → per-event, per-feature lock (a double click is a 409, not a second bill) → cache keyed on feature + model + prompt version + input (24h; a repeat is free) → worst-case budget check against the `ai_usage` ledger (`$2` per event, `$50` per month, integer micro-dollars) → ledger row written **before** dispatch at the worst-case cost → hard 45 s timeout → **at most one retry**, only for rate-limit/overload, never for a timeout (it may already be billed) → schema validation of the reply → ledger corrected to the provider's token count → a log line with feature, model, tokens, cost, duration and outcome, never prompt text. The retry loop is bounded by a constant; there is no other loop.

**Five features, five suggestions.** Categorisation (a fixed eight-value set; a reply outside it is discarded and counted), similar-question detection (the model picks from twenty trigram candidates and its pick is written as the _same_ `possibleDuplicate` suggestion the deterministic detector produces, so it flows into the existing merge/dismiss confirmation and never overwrites one a moderator dismissed), clustering (`topics` + `questions.topicId`, replaced wholesale per run), a drafted answer (stored on `question_enrichments.suggestedAnswer` with the model's own caveats — never an `answers` row, never on the attendee board, shown under an "AI-generated draft" label with no publish button), and an event summary (`event_summaries`, LIVE while published, FINAL once closed). None changes a question's status.

**Minimised input, contained output.** Prompts are built from `{id, body, status}` per question and `{title, description}` per event; questions are referenced by a per-call 1-based index, so no UUID, name, email, vote count, attendee or organizer field ever reaches a model — a unit test builds a prompt from a record carrying all of them and asserts none survive. Every reference a model makes back is resolved through that index and dropped if it does not exist; every category is checked against the set; a similarity match needs a confidence of 0.6. A model can be wrong only inside the shape it was given.

**Models and cost.** Tiered by configuration (`AI_MODEL_CLASSIFY`/`DEDUP` default Haiku 4.5, `AI_MODEL_INSIGHT` default Sonnet 5): roughly `$0.005` to categorise fifty questions, `$0.01` for a draft answer, `$0.04` to cluster or summarise two hundred. An unknown model id is priced as the most expensive known one, so a typo over-counts toward the cap rather than under it. Inputs are bounded at 600 characters per question, 50/20/200 questions per call by feature, and 80k characters overall.

**What is deliberately not built:** automatic enrichment on submission (that is a queue project, and it would tie cost to the size of the room rather than to the organizer's choices), embeddings, and the Batch API.

## 13a. Event Insights

**Facts and interpretation are separated by the code, not only by labels.** `GET /events/:id/insights` returns measured facts only: its contract (`packages/contracts/src/insights.ts`) has no field a model could fill, and `InsightsModule` does not import the AI module. Anything a model produced (categories, topics, the summary) is served by `/ai/*` and rendered in a separate, dashed, "AI-generated" section. Each AI block there shows its model, when it ran, and how many of the current questions it covered, so a summary of 40 questions cannot pass for a picture of all 87. The insights page calls no model; it only reads what earlier runs stored.

**Nothing was collected for insights.** Every figure is derived from questions, votes and the moderation audit trail, which the product keeps in order to work. There are no page views, devices, locations or per-attendee profiles, and engagement is reported as head-counts only. Each metric answers a decision an organizer makes:

| Metric                         | Question it answers                                             |
| ------------------------------ | --------------------------------------------------------------- |
| Submitted, by status           | How big was this, and what happened to it?                      |
| Unanswered + follow-up list    | What do we still owe the room after the event?                  |
| Answer rate                    | Did the session cover what was asked?                           |
| Askers / voters / participants | Was this two loud people, or the whole room?                    |
| Most upvoted / most asked      | What did the room most want, and was it answered?               |
| Submissions over time          | When did the room engage? (Where to put the next Q&A slot.)     |
| Duplicate groups               | Where was demand concentrated? (Confirmed merges only.)         |
| Median moderation wait         | Is pre-moderation a bottleneck for attendees?                   |
| Frequent words                 | What came up, with AI off, at zero cost? (Counts, not meaning.) |

Left out on purpose: anything that would need new collection (scan or view counts, device or location data) and anything per attendee. Neither leads to a decision that the list above does not already support.

Everything is computed on request (the page is opened, not polled) from indexes that already existed. No migration was needed. The only step that loads rows instead of counting them is the word count, which is capped at the newest 5,000 live questions and says so when it truncates.

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

**Every route except the landing page is `noindex` by default, enforced twice:** an `X-Robots-Tag` header on every path but `/` (`next.config.ts`) and a `noindex` default in the root layout's metadata, which the landing page alone overrides. A new route is therefore private until someone decides otherwise. An indexed event page would expose attendee questions publicly — a privacy incident, not an SEO mistake.

robots.txt deliberately does **not** disallow these pages. A crawler barred from a URL never fetches it, so it never sees the `noindex`, and it can still list the bare URL when a join link is shared publicly. Only `/api/` and `/health/` are disallowed.

No event page is indexable today. The organizer opt-in (`Event.isPubliclyListed`) has no UI, so no event is in the sitemap either. The share card is one generic EventQ image on every route, so a forwarded join link never previews a private event's title.

## 18. Observability

pino JSON logs with a correlation id propagated into background jobs; PII redacted by allowlist. OpenTelemetry spans from HTTP through use-case to database. The metric that actually reflects attendee experience is **moderation latency (submit → approve) p50/p95**. Alerting is on SLO burn rate, not raw spikes — spiky traffic is normal here and threshold alerts would page constantly.

## 19. Backup and recovery

RDS PITR (30 days in production) with cross-region snapshot copies, plus an independent nightly logical dump. **A monthly restore drill with measured RTO/RPO** — an untested backup is not a backup. Redis is expendable; in-flight work is recoverable from the outbox table.

## 20. Scalability

Designed for now: stateless API scaling horizontally, SSE fan-out via Redis pub/sub, denormalised counters, SQL-side ranking, a short-TTL per-event cache so a 5,000-person room becomes one cache read, and workers scaling on queue depth.

Deliberately **not** built yet — each an open option, not a hidden assumption: microservices, event sourcing, CQRS with separate stores, table partitioning, GraphQL, Kubernetes.

Growth path in the order it will actually be needed: read replica for analytics → cache warming before scheduled starts → multi-region reads → offline-first PWA submission queue (venue wifi is the most common real-world failure) → per-session ranking for multi-track conferences → white-label domains.
