# Migration strategy

## Principles

**Forward-only.** There are no down migrations. A rollback in production is a
new forward migration, because a down migration is written when you are calm and
run when you are not, and it is almost never tested against real data.

**Expand / contract.** Never change a column in one step:

1. **Expand** — add the new nullable column. Deploy. Old and new code both work.
2. **Backfill** — populate it in batches. Deploy nothing.
3. **Switch** — start writing and reading the new column. Deploy.
4. **Contract** — drop the old column. Deploy.

Four deploys instead of one, and at no point is a running instance looking at a
schema it does not understand.

**Locks are the real risk.** `questions` is written continuously during a live
event. A migration that takes an `ACCESS EXCLUSIVE` lock on it stalls every
submission in the room.

| Operation                                      | Lock             | Safe during an event? |
| ---------------------------------------------- | ---------------- | --------------------- |
| `ADD COLUMN` (nullable, no default)            | brief            | Yes                   |
| `ADD COLUMN ... DEFAULT`                       | brief (PG 11+)   | Yes                   |
| `CREATE INDEX`                                 | blocks writes    | **No**                |
| `CREATE INDEX CONCURRENTLY`                    | none             | Yes                   |
| `ALTER COLUMN TYPE`                            | full rewrite     | **No**                |
| `ADD CONSTRAINT ... NOT VALID` then `VALIDATE` | brief, then none | Yes                   |
| `DROP COLUMN`                                  | brief            | Yes                   |

Always index with `CONCURRENTLY`. Prisma does not emit it, so edit the generated
SQL by hand and remove the surrounding transaction — `CONCURRENTLY` cannot run
inside one.

**Deploy freeze while an event is `LIVE`.** A table lock during a keynote is an
outage in front of an audience. Check before deploying:

```sql
SELECT count(*) FROM events WHERE status = 'LIVE';
```

---

## Workflow

```bash
# 1. Edit apps/api/prisma/schema.prisma
# 2. Generate and apply locally
pnpm db:migrate            # prompts for a name

# 3. READ THE GENERATED SQL. Every time.
#    apps/api/prisma/migrations/<timestamp>_<name>/migration.sql

# 4. Verify against a clean database
pnpm db:reset && pnpm db:deploy && pnpm db:seed
```

Reviewing the generated SQL is not optional. Prisma will happily emit a
destructive rewrite for a change that looked cosmetic in the schema file.

---

## Production

Migrations run as a **one-off ECS task, gated before the service update** —
never in a container entrypoint, where N starting tasks would race the same
migration.

```
build image -> push to ECR -> run migrate task -> wait for success -> update service
```

`prisma migrate deploy` only applies pending migrations and never generates or
resets. `migrate dev` and `migrate reset` must never run against production;
`DATABASE_URL` there points at RDS via Secrets Manager and is not present in any
developer environment.

## Extensions

`pgcrypto`, `pg_trgm` and `vector` are declared in the datasource block and
created by migration, so local, CI and RDS all acquire them through the same
code path. They are asserted by an integration test — a future migration that
drops one fails CI.

## Seeds

`pnpm db:seed` is idempotent: every write is an upsert on a fixed UUID, so
repeated runs converge rather than accumulate. CI proves this by seeding twice
and comparing row counts. The seed refuses to run when `NODE_ENV=production`.
