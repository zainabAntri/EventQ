# Testing strategy

## What each layer is for

| Layer         | Location                                         | Runtime | Answers                                          |
| ------------- | ------------------------------------------------ | ------- | ------------------------------------------------ |
| Unit          | `apps/api/src/**/*.spec.ts`                      | ms      | Is the logic right?                              |
| Integration   | `apps/api/test/*.integration.spec.ts`            | ~15s    | Does it work against a real database?            |
| HTTP contract | `apps/api/test/api-contract.integration.spec.ts` | ~2s     | Does the wire format match the contract?         |
| Frontend      | `apps/web/src/**/*.spec.tsx`                     | ~3s     | Does the component behave, and is it accessible? |
| E2E           | `e2e/*.spec.ts`                                  | ~30s    | Does the whole thing stand up?                   |

Speed is a feature. The unit suite is fast because the domain layer has no I/O,
which is the practical payoff of the layer rule — and a suite that is fast is a
suite people actually run.

---

## Rules

**Prisma is never mocked.** A mocked ORM verifies the mock. The unique index
that makes double-voting structurally impossible, the cascade that prevents
orphaned questions, the trigram similarity that finds duplicates for free —
none of these can be proven by a test double. Integration tests use
Testcontainers with the same `pgvector` image as production.

**Frontend queries go through the accessibility tree.** `getByRole`,
`getByLabelText`. A test can only pass if a screen-reader user could also find
the element, which turns accessibility into a build failure rather than an audit
finding.

**No snapshot tests on UI.** They fail on every visual tweak and pass on every
accessibility regression — exactly backwards. Assert behaviour.

**Tests state the guarantee.** `'makes double-voting structurally impossible'`
tells you what breaks and why it matters. `'test vote unique'` does not.

---

## Running them

```bash
pnpm test                 # unit, everywhere
pnpm test:integration     # needs Docker
pnpm --filter @eventq/web test
pnpm test:e2e             # starts both servers itself
pnpm test:e2e:install     # one-time browser download
```

---

## Integration test harness

`apps/api/test/database.harness.ts` starts a real Postgres, applies the real
migrations with `migrate deploy`, and returns a real client.

```ts
let db: TestDatabase;
beforeAll(async () => {
  db = await startTestDatabase();
});
afterAll(async () => {
  await db.stop();
});
beforeEach(async () => {
  await db.truncate();
});
```

`truncate()` discovers tables dynamically, so a table added in a later phase is
cleaned automatically rather than silently leaking rows between tests.

Integration tests run with `fileParallelism: false` — they share a database, and
serial execution is cheaper than debugging cross-test interference.

---

## Accessibility

Two passes, because they catch different things:

- **jsdom (`toHaveNoSeriousA11yViolations`)** — structure, labelling, ARIA.
  Colour contrast is explicitly **disabled** here: jsdom applies no stylesheets,
  so the rule cannot actually measure anything and would either report noise or,
  worse, pass and imply a check that never ran.
- **Playwright + axe** — the real browser with the real stylesheet, which is
  where contrast is genuinely verified.

Both gate on `serious` and `critical` only. Blocking on `minor` findings trains
people to disable the check, at which point it protects nothing.

---

## Coverage

Gated at 85% on `domain/` and `application/` only. Infrastructure and generated
code are excluded deliberately: chasing coverage there produces tests that
assert nothing and take real time to maintain.

---

## User journeys

**Journey 1 — scan → submit — is now real** (`e2e/attendee-submit.spec.ts`). It
runs on both `chromium` and `mobile-safari`, and the WebKit project is the one
that matters: attendees arrive by pointing a phone camera at a poster.

That project earns its keep. It caught a hydration race the Chromium run could
not: the page is server-rendered, so the textarea paints and accepts focus
before React has taken over, and a controlled input is re-rendered from React's
own state the moment it does — discarding anything typed in that window.
Chromium hydrates fast enough to hide it. The suite now waits for the join
request (fired from a `useEffect`, which runs only after hydration) rather than
guessing with a timeout.

It also exposed a test that was passing for the wrong reason: filling a
too-short question was being silently discarded, and the resulting EMPTY field
produced the same validation error the test asserted. It would have passed with
validation entirely broken.

Still to come:

2. the keyboard-driven moderation queue
3. projector view updating in real time

Writing those before the screens exist would be theatre.

---

## Tenant isolation and performance

Two suites added with the organizer dashboard test properties rather than
features, and both are worth knowing about before changing the question queries.

`apps/api/test/dashboard.integration.spec.ts` asserts that **organizer A never
receives organizer B's questions**, once per read path — the list, every status
filter, search, every sort order, a cursor minted inside the other tenant, the
counts endpoint, and the moderation write. Every one expects an EMPTY PAGE (or a
404 on the write) rather than a 403, because a 403 confirms the id is real and
turns the endpoint into an enumeration oracle. If you add a query shape to the
question repository, add it here too: a new shape is a new chance to forget the
`event: { orgId }` predicate.

`apps/api/test/dashboard-performance.integration.spec.ts` runs every dashboard
query against events of 100, 1,000 and 10,000 questions. It is a regression
guard, not a benchmark — the thresholds sit two orders of magnitude above a
healthy result, because it runs in a container on whatever machine CI gave us.
What it exists to catch is a change in SHAPE: a query that stops using an index
and starts sorting the whole event, a page that grows with the dataset because a
limit was dropped, keyset pagination quietly replaced by an offset, or an N+1
introduced by fetching something per question. Each of those turns a 20 ms query
into a multi-second one at ten thousand rows — the scale where nobody notices in
development and everybody notices during a keynote.

Measured on a local container at 10,000 questions: ranked page 17 ms, search
19 ms, counts 20 ms, and the fortieth page costs the same as the first, which is
the keyset property stated as a number.
