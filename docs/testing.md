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

## What Phase 1 does not test

There are no user journeys yet, so the E2E suite is a smoke suite. Phase 2 adds
the three that matter:

1. scan → submit → approve → appears on the live board
2. the keyboard-driven moderation queue
3. projector view updating in real time

Writing fake journeys now would be theatre.
