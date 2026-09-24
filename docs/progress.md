# EventQ progress

Where the project actually stands, what is deployed, and what is still open.

This file is the answer to "what is the state of this thing?" — for the author
returning after a break, and for anyone joining the repo. Design lives in
[`architecture.md`](architecture.md); how to work on the code lives in
[`development.md`](development.md). Neither of those records status, so this one
does.

**Last updated: 2026-09-24.** Update it when a PR merges, when the deployment
changes, or when an open question closes.

---

## 0. Resume here

Read this section first. It is the handoff note for the next working session,
so nobody has to reconstruct the state from git history.

**Paused 2026-09-24, at a clean stopping point.**

- **Branch:** `fix/security-hardening` (Phase 9), pushed, not merged. The
  author opens the PR.
- **Done:** the audit (four areas, every finding checked against the code) and
  all three High fixes, each with a test. No Critical findings. Gate green:
  `pnpm verify` passes, and the integration suite ran 300/300.
- **Before merging, deploy steps only the author can do** (§9.3):
  1. Set `API_PROXY_SHARED_SECRET` to the same new value on Render and Vercel.
  2. `pnpm db:deploy` against Supabase (new migration `lock_public_schema`).
  3. Supabase dashboard → Advisors → Security: expect no "RLS disabled" findings.
- **Next when work resumes:** pick Medium findings from §9.2. Suggested order:
  M1 display-name moderation, M2 Redis outage takes attendee routes down, M3
  identity minting, M4 AI spend per organization (before AI is ever enabled).
- **Production readiness:** the code has no open Critical or High. Do not
  call the _deployment_ ready until the §9.3 steps are done and checked.
- **Local testing gotcha:** `sentinelhub-redis` (another project) holds port 6379. Run the integration suite against a throwaway Redis instead:
  `docker run -d --rm --name eventq-redis-test -p 127.0.0.1:6380:6379 redis:7-alpine`,
  then set `REDIS_URL=redis://127.0.0.1:6380` for the run.

---

## 1. Summary

Eight phases are built, tested and merged to `main`. Phase 9, a security
audit and hardening pass, is in progress. The product is usable
end to end: an organizer signs up, creates an event, and gets a join code; an
attendee scans and submits a question without an account; the organizer
moderates, and questions rank by votes, demand and recency.

Phase 7 added the event experience end to end: the organizer UI that was missing
entirely — create, publish, QR code, printable poster, close — and what an
attendee sees when they scan the poster after the event has finished.

Phase 8 added Event Insights: what happened at an event, as counted facts (volume,
the follow-up list of unanswered questions, engagement, timing, duplicates,
moderation wait), with any AI interpretation shown in a separate, labelled section.
It collects nothing new and calls no model.

It runs on the public internet on a $0 stack (Vercel + Render + Supabase), with
AI switched off and nothing spent. Still not built: the projector view, logo
upload, exports and team invites.

---

## 2. Phases

Phase numbers follow the author's scheme — Phase 1 is the foundation, not a
walking skeleton. The original architecture proposal numbered them one lower;
that numbering is dead, and this table is the one that counts.

| Phase | Scope                                                                                      | Status   | PR     | Merged     |
| ----- | ------------------------------------------------------------------------------------------ | -------- | ------ | ---------- |
| 1     | Foundation — monorepo, NestJS + Next.js, Prisma, CI, test infra                            | Complete | —      | 2026-08-24 |
| 2     | Organizer auth; organization + event domain and lifecycle                                  | Complete | #1, #2 | 2026-08-25 |
| 3     | Attendee flow — attendee tokens, no-account submission, spam heuristics                    | Complete | #3     | 2026-08-25 |
| 4     | Organizer dashboard + moderation console                                                   | Complete | #4     | 2026-08-31 |
| 5     | Upvoting, ranking, duplicate merging                                                       | Complete | #5     | 2026-09-17 |
| 6     | AI enrichment layer, entirely behind two off-by-default switches                           | Complete | #6     | 2026-09-17 |
| 7     | Event experience — organizer create/publish/QR/print, accent branding, closed-event screen | Complete | #13    | 2026-09-23 |
| 8     | Event Insights — measured facts, kept apart from AI interpretation                         | Complete | #14    | 2026-09-23 |
| 9     | Security audit and hardening — fix every Critical and High finding                         | Paused   | —      | —          |

**A note on the numbering drift.** The plan originally put product depth
(upvoting, projector, branding, exports, invites) in Phase 4 and hardening in
Phase 6. What shipped moved moderation UI into Phase 4 and split product depth
apart: voting shipped as Phase 5 and AI took the Phase 6 slot. Phase 7 picked up
the organizer-facing half of what was left; the projector view, exports and
invites are still outstanding.

### Work merged after the phases

| PR  | What                                                                                        | Merged     |
| --- | ------------------------------------------------------------------------------------------- | ---------- |
| #7  | Free-tier deployment — Vercel config, Next rewrites API proxy                               | 2026-09-19 |
| #8  | Fix: missing `express` dependency blocking API boot on Render                               | 2026-09-19 |
| #9  | Fix: `API_PROXY_TARGET` stripped by turbo strict env, so Vercel served 404s for `/api/v1/*` | 2026-09-19 |
| #10 | Fix: native form controls ignored the colour scheme                                         | 2026-09-19 |
| #11 | Asked-by priority — `askedByCount` plus a demand term in the ranking score                  | 2026-09-22 |
| #12 | Repo prep for a collaborator — README rewrite, shared Claude Code settings                  | 2026-09-22 |
| #16 | Fix: test harness listens once, ending the flaky CI integration job                         | 2026-09-23 |
| #17 | Fix: shared dashboard bar with Your events, New event and Sign out                          | 2026-09-23 |

---

## 3. What is deployed

Chosen 2026-09-19 to test the full flow live without AWS cost. The runbook is
[`deploy-free-tier.md`](deploy-free-tier.md).

| Piece | Where                                                                        | State                          |
| ----- | ---------------------------------------------------------------------------- | ------------------------------ |
| Web   | Vercel `event-q-web` → https://event-q-web.vercel.app                        | Live                           |
| API   | Render `eventq-api` (Singapore, free tier) → https://eventq-api.onrender.com | Live; sleeps after 15 min idle |
| Redis | Render Key Value `eventq-redis` (Valkey, internal URL only)                  | Live                           |
| DB    | Supabase `eventq` (ap-southeast-1), session pooler on 5432                   | Live, migrated and seeded      |

Migrations are applied through Supabase and the demo data is seeded. The
asked-by migration (`20260920100000_asked_by_count`) reached production on
2026-09-22 and the attendee board was verified returning 200.

Health check, any time — the first hit after idle can take ~60 seconds while
Render wakes the service:

```bash
curl https://event-q-web.vercel.app/health/ready
```

Demo organizer is `owner@eventq.local`; the demo join code is `EVENTQ26`.

---

## 4. Open issues

**Cross-origin cookies are still unproven in a real browser.** Auth is built and
tested, but only ever same-origin through supertest. The entire dashboard fetches
client-side with `credentials: 'include'`, so if the cookie does not cross
origins the dashboard is unusable. The deployment currently sidesteps this with a
Next rewrites proxy, which makes the API same-origin from the browser's point of
view — so the risk is deferred, not retired. Verify in Safari (strictest cookie
policy) before relying on a direct cross-origin split.

**Secret rotation needs confirming.** The Supabase database password and both
generated JWT secrets were pasted into a chat transcript on 2026-09-19. Rotation
was requested and the database password was rotated on 2026-09-22. Confirm the
two JWT secrets on Render were regenerated too before treating the deployment as
clean.

**Phase 7 has not been tested on real devices.** The automated suites cover the
logic and the accessibility tree, but nothing has verified an actual QR scan
from another phone, a real slow or intermittent connection, or the printed
poster coming out of a printer at the right size. See §8.

_Closed 2026-09-23: CI "Tests" flakiness (`read ECONNRESET` on the
concurrent-voting tests, Linux only). The harness handed supertest a server that
was not listening, so supertest listened itself and closed the shared server
while other requests were still queued. Fixed in #16 by listening once in
`startTestApp`._

_Closed 2026-09-23: the dashboard had no copy-link or QR button. Phase 7 added
the QR card, both downloads and the printable poster._

---

## 5. Decisions worth knowing before you change something

**AI is off at two independent switches and stays that way.** `AI_ENABLED` for
the deployment and `EventSettings.aiEnabled` per event must both be on before a
single call is made, and the default configuration spends nothing. The product is
designed to be completely functional with AI off permanently. Do not make any
feature depend on it.

**The dashboard polls a stats endpoint on purpose.** This is a deliberate choice,
not an unfinished piece of realtime work. SSE is reserved for the projector view,
where a persistent connection actually pays for itself. Polling is not a gap to
close.

**Duplicate merging is human-confirmed, never automatic.** Merging moves vote
rows to the survivor and accumulates `askedByCount`, which feeds the demand term
in the ranking score. Nothing merges questions without a person confirming.

**A closed public event is no longer hidden — everything else still is.** Until
Phase 7, unknown / draft / closed / archived / private all produced one
indistinguishable 404 so that join codes could not be probed. A public event
that was published and has since closed is now disclosed, because its code was
displayed to a whole room and printed on posters: it was never a secret. Draft,
archived and private are unchanged. The rule lives in one function,
`publicVisibility` in `event-lifecycle.ts`, and the reasoning is written there.
Probing is answered by the rate limiter, which is where that defence belongs.

**Branding can never break contrast.** The organizer picks one accent colour; it
is stored exactly as chosen and used raw only for the QR code and print. Every
contrast-sensitive use is derived by `brandPalette` in
`packages/contracts/src/branding.ts`, which corrects the colour until text on it
clears WCAG AA. A hue sweep over ~1,700 colours holds that line in the test
suite. Do not use a raw accent as a fill or as text.

**Insights facts and AI interpretation never share a response.** `/insights` has
no field a model could fill, and the insights module does not import the AI
module. AI views of an event stay under `/ai/*` and render in their own labelled
section with model, date and coverage. Do not "simplify" this by folding topics or
the summary into the insights response. See [`architecture.md`](architecture.md) §13a.

**Nothing in `packages/contracts` may use a zod `.transform()`.** Every request
shape becomes a JSON Schema for the OpenAPI document, and a transform has no
JSON Schema representation — one on `AccentColor` made the document unbuildable
and took the whole integration suite down with it. Normalisation is a separate,
explicit function applied where a value is stored.

**Prefer `pnpm db:deploy` over `pnpm db:migrate`.** `migrate dev` can decide the
database has drifted and offer to reset it, taking the seeded demo event with it.
`migrate deploy` is non-interactive and only applies what is pending. See
[`migrations.md`](migrations.md).

---

## 6. Not built yet

From the original plan, still outstanding:

- **Projector view** — the big-screen live board, and the reason SSE exists in
  the design.
- **Logo upload** — the `logoKey` column exists but there is no file storage on
  the $0 stack. Accent-colour branding shipped in Phase 7; a logo needs a
  Supabase Storage bucket and an upload path, and is its own piece of work.
- **Exports** — questions out as CSV/PDF after an event.
- **Team invites** — more than one organizer per organization.
- **Hardening pass** — load test, accessibility audit, SLOs. The security
  review is Phase 9 (§9).
  The non-functional targets in [`architecture.md`](architecture.md) §2 are
  design targets; none has been measured under load.

Agreed but not started:

- **Speech input for attendees** — browser Web Speech API, so it costs nothing
  and does not touch the AI layer. Its own branch when it starts.

---

## 8. Device testing Phase 7 still needs

Automated tests cover the logic, the contrast arithmetic and the accessibility
tree. These cannot be automated here and have not been done:

| Check                    | What to look for                                                                  |
| ------------------------ | --------------------------------------------------------------------------------- |
| Scan from another phone  | The code resolves, and from ~3–4 m, not just held up close                        |
| Small phone (≤375 px)    | No horizontal scroll; the send button reachable one-handed                        |
| Tablet and desktop       | The attendee page does not stretch into an unreadable line length                 |
| Slow connection          | The event title paints before the questions; nothing jumps as they arrive         |
| Intermittent connection  | A dropped submit can be retried without posting twice                             |
| Back / forward / refresh | The closed screen and the live board both survive; no state lost on refresh       |
| Printed poster           | A4 at 100% scale, code large enough to scan from the back of a room               |
| Keyboard only            | Every control reachable; the close confirmation takes focus; nothing traps it     |
| Screen reader            | The QR has a useful label; the copy confirmation is announced; errors are read    |
| Branding                 | Pick a pale yellow and a mid pink — both must stay readable, and the QR scannable |

---

## 7. Local development gotchas

These cost real time when rediscovered from scratch.

- **Docker Desktop does not auto-start on the author's machine.** Launch it, then
  `docker compose up -d` for Postgres _and_ Redis. Integration tests use
  Testcontainers for Postgres but expect Redis from compose — without it, two
  rate-limit tests fail (the limiter fails open outside production) and it looks
  like a code bug.
- **`pnpm` fails inside the Bash tool** with an fnm "can't find the environment
  variables to replace the Node version" error. In PowerShell, run
  `fnm env --use-on-cd | Out-String | Invoke-Expression` first.
- **Sign-in is `POST /api/v1/auth/login`**, not `/auth/sign-in`, and every
  state-changing request needs the `x-eventq-client: web` CSRF header or it is a 403.
- **Supabase reports a wrong password as `P1001`** — a connection error, not an
  auth error — so a bad password reads as "cannot reach the database". Check the
  password before debugging the network.

---

## 9. Phase 9 — security audit (2026-09-24)

Four areas were reviewed read-only, and every finding was checked against the
code: authentication and HTTP; authorization; public attendee endpoints and
data; AI, infrastructure and dependencies. **No Critical findings.** There is
no IDOR, SQL injection or XSS, and no mass assignment or secret in git history.
Every organizer query is scoped to the organization inside the SQL itself.

### 9.1 High — fixed on `fix/security-hardening`

| #   | Vulnerability                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                        | Test proving it                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Behind the Vercel proxy every visitor shared one IP, so per-IP limits were global: 11 bad logins from anyone locked out all logins; ~100 attendees polling the board locked out every event. A success also reset the login bucket, allowing unlimited password spraying. | `apps/web/src/proxy.ts` forwards the real client IP with `API_PROXY_SHARED_SECRET`; `shared/http/client-ip.ts` believes it only when the secret matches. IPv6 grouped by /64. Board poll limited per attendee (`boardRead`). Login bucket no longer reset. | `client-ip.spec.ts`, `proxy.spec.ts`; `auth.integration.spec.ts` "behind the web proxy" (separate buckets, spoofed header ignored, no reset on success); `voting.integration.spec.ts` board poll per attendee |
| H2  | Next.js 16.3.2: two critical RCE advisories (GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36) plus `sharp`.                                                                                                                                                                      | Next 16.3.6. `pnpm.overrides` for multer ^2.3.0, qs ^6.16.0 and mysql2 ^3.23.1 (same major versions, not reachable anyway).                                                                                                                                | `pnpm audit --prod`: only deepmerge-ts remains (see 9.2).                                                                                                                                                     |
| H3  | No RLS on any `public` table. Supabase's REST API serves them to anyone with the anon key (public by design), including `users` with password hashes. Not confirmed live: the project is not visible from the dev session.                                                | Migration `20260924100000_lock_public_schema`: RLS on every table with no policies, and all privileges revoked from `anon`/`authenticated`. Prisma owns the tables, so it is unaffected. Rule documented in `migrations.md`.                               | `schema.integration.spec.ts` "closed to the Supabase Data API": every table has RLS; a granted `anon` role sees 0 rows; the real migration file revokes Supabase's default grants.                            |

### 9.2 Medium and Low — open, recorded for later

| #   | Sev    | Finding                                                                                                                                                       | Suggested fix                                                                             |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| M1  | Medium | An attendee's display name skips moderation and renames their already-approved questions (live join).                                                         | Snapshot the name onto the question at submit; run spam/profanity checks on names.        |
| M2  | Medium | Redis down in production fails every attendee route (the limiter fails closed for all rules, not just auth).                                                  | Per-rule fail mode: closed for `auth:*`, in-process fallback for attendee rules.          |
| M3  | Medium | Unlimited throwaway identities: one IP can mint 300/min, inflating votes and flooding POST-moderated boards.                                                  | Tight per-IP-per-event cap on NEW identities; optional challenge when join rate spikes.   |
| M4  | Medium | AI spend cap is platform-wide: one self-registered org can exhaust it for everyone, and `/ai/status` shows other tenants' spend. AI is off today.             | Per-org monthly cap; return only the org's own spend; atomic budget reservation (A3).     |
| M5  | Medium | Per-account lockout can be bypassed with parallel requests (read-then-write counter).                                                                         | Atomic `increment`, or a Redis per-email limiter before argon2.                           |
| M6  | Medium | Postgres TLS is not enforced by the app; depends on `sslmode` in `DATABASE_URL`. Unverified on Render.                                                        | Check the Render URL; enable "Enforce SSL" in Supabase; boot guard once the CA is sorted. |
| M7  | Medium | Prompt injection: question text can steer free-text AI output (drafts, summaries). No AI output changes state.                                                | Delimit questions as untrusted data; strip URLs/emails from model free text.              |
| L1  | Low    | Account enumeration via the lockout response (only existing emails lock) and the register 409.                                                                | Count unknown emails too; consider email-verification sign-up.                            |
| L2  | Low    | Refresh rotation not atomic; access JWTs outlive logout and demotion for up to 15 min.                                                                        | Claim the row with a conditional `updateMany`; add a session id plus revocation check.    |
| L3  | Low    | Moderation and merge still work on CLOSED events, altering the public archive.                                                                                | Refuse unless the event is DRAFT/PUBLISHED, in the transactional predicate.               |
| L4  | Low    | Public event lookup by join code has no rate limit, despite the comment claiming one.                                                                         | Add a `publicLookup` rule (now meaningful, since H1 gives real client IPs).               |
| L5  | Low    | Non-UUID cursor ids and NFKC-expanded display names give 500s with stack logs; oversized bodies give 500 not 413.                                             | Validate the cursor id; re-check length after normalising; map 4xx body-parser errors.    |
| L6  | Low    | No Content-Security-Policy on the web app.                                                                                                                    | Nonce-based CSP in `proxy.ts`.                                                            |
| L7  | Low    | `NODE_ENV` defaults to development, silently disabling every production guard if unset.                                                                       | Make it required.                                                                         |
| L8  | Low    | CI has no `permissions:` block and actions are not SHA-pinned; docker-compose binds 0.0.0.0; app DB role is `postgres`.                                       | `contents: read`; pin SHAs; bind 127.0.0.1; a least-privilege runtime role.               |
| L9  | Low    | Near-duplicate search cannot use the trigram index; cost grows with event size.                                                                               | Use the `%` operator with a similarity threshold.                                         |
| —   | Info   | `deepmerge-ts` (high advisory) via Prisma's config loader: the fix is a major bump inside Prisma, and the only input is our own `prisma.config.ts`. Accepted. | Revisit on the next Prisma upgrade.                                                       |

### 9.3 Deploy steps for the author

1. Generate one secret (`openssl rand -base64 48`) and set it as
   `API_PROXY_SHARED_SECRET` on **both** Render and Vercel, then redeploy both.
   Check: `curl -i https://event-q-web.vercel.app/health/ready` still returns 200. Then sign in from a laptop after 11 bad logins from a phone on mobile
   data; the laptop must not get a 429.
2. `DATABASE_URL='<session pooler url>' pnpm db:deploy` to apply
   `lock_public_schema` to Supabase.
3. Supabase → Advisors → Security: no `rls_disabled_in_public`. Optionally
   turn the Data API off entirely (Settings → API), since EventQ never uses it.
