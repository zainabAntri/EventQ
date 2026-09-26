# Backup and restore

How the production database is backed up, how to get it back, and what to do
when something goes wrong. This covers the current free-tier stack (Supabase
Postgres, see [deploy-free-tier.md](deploy-free-tier.md)). The AWS design in
[architecture.md](architecture.md) §19 is a target, not what runs today.

## Why this exists

The Supabase free plan has no project backups and no point-in-time recovery.
Without this job, a bad migration, an accidental delete or a lost project
would be permanent.

## What runs

[`.github/workflows/db-backup.yml`](../.github/workflows/db-backup.yml), every
night at 02:00 UTC, and on demand (Actions → Database backup → Run workflow).

1. `pg_dump` of the `public` schema (all of EventQ) through the session pooler,
   in custom format.
2. The dump is encrypted with AES-256 (`gpg --symmetric`) and the plaintext is
   deleted. The repo is public and public-repo artifacts can be downloaded by
   any signed-in GitHub user, so an unencrypted dump would publish every
   organizer's email and password hash.
3. **Restore test.** The encrypted file is decrypted and restored into an empty
   Postgres 17 with pgvector. The job fails unless the number of tables and
   applied migrations match the source. Row counts for the main tables are
   shown in the run summary.
4. The encrypted file is kept as a workflow artifact for **30 days**.

A failed run emails the repository owner (GitHub's default notification).

### Setup, once

In GitHub → Settings → Secrets and variables → Actions, add:

| Secret              | Value                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_DB_URL`   | The session pooler URL (port 5432) with the password. Not the direct host: it is IPv6-only and runners have no IPv6.                |
| `BACKUP_PASSPHRASE` | A long random passphrase (`openssl rand -base64 32`). **Also store it in a password manager.** Without it, no backup can be opened. |

Then run the workflow once by hand and check the summary shows matching counts.

## Targets

| Measure       | Value            | Why                                                                                                    |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| **RPO**       | 24 hours         | One backup a night. At most a day of questions is lost.                                                |
| **RTO**       | about 30 minutes | Download, decrypt, restore and switch `DATABASE_URL`. Replace with the time from the first real drill. |
| **Retention** | 30 days          | Artifact retention. Long enough to notice silent damage, short enough to limit exposure.               |
| **Verified**  | every night      | The restore test runs in the same job, so a backup that cannot be restored fails loudly.               |

## Restore

You need: Docker, the GitHub CLI or browser access to the Actions page, the
passphrase, and a target database. The target is either a new Supabase project
(when the old one is gone) or a local database (to inspect or copy data back).

### 1. Download the backup

Actions → Database backup → pick the run → Artifacts →
`eventq-<date>.dump.gpg`. The download is a zip holding the `.gpg` file.

```bash
gh run list --workflow db-backup.yml --limit 5
gh run download <run-id> --dir restore/
```

### 2. Decrypt

```bash
gpg --decrypt --output eventq.dump restore/eventq-<date>.dump.gpg/eventq-<date>.dump.gpg
# prompts for BACKUP_PASSPHRASE
```

Without gpg installed, use a container:

```bash
docker run --rm -it -v "$PWD:/work" -w /work ubuntu:24.04 \
  bash -c 'apt-get update -qq && apt-get install -y -qq gnupg && gpg --decrypt --output eventq.dump <file>.gpg'
```

### 3. Prepare the target database

It must be empty, with the two extensions EventQ uses. A schema-only dump does
not carry `CREATE EXTENSION`.

```bash
TARGET='postgresql://user:password@host:5432/postgres'   # new Supabase: its session pooler URL
docker run --rm postgres:17 psql "$TARGET" -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS vector;'
```

### 4. Restore

The dump contains `CREATE SCHEMA public`, which every database already has, so
leave that one entry out:

```bash
docker run --rm -v "$PWD:/work" postgres:17 sh -c '
  pg_restore --list /work/eventq.dump | grep -v " SCHEMA - public " > /work/restore.list &&
  pg_restore --dbname="$0" --no-owner --no-acl --exit-on-error --use-list=/work/restore.list /work/eventq.dump' "$TARGET"
```

### 5. Re-apply privileges (Supabase targets only)

RLS comes back with each table. Grants do not (`--no-acl`), and a new Supabase
project's default privileges hand the `anon` and `authenticated` roles access
to every restored table. **Do this before the API points at the database:**
run the SQL from
`apps/api/prisma/migrations/20260924100000_lock_public_schema/migration.sql`
in the Supabase SQL editor (it is safe to run again), then confirm Advisors →
Security shows no `rls_disabled_in_public`.

The migration history (`_prisma_migrations`) is restored too, so
`pnpm db:deploy` afterwards applies only migrations newer than the backup.

### 6. Point the API at it

Set `DATABASE_URL` on Render to the new session pooler URL and redeploy.
Check `/health/ready` reports `"database":"up"`, sign in, and open an event.

### 7. Clean up

Delete `eventq.dump` and the downloaded files. They are unencrypted personal
data.

## Failure scenarios

| What happened                             | Do this                                                                                                                                      | Data lost                                     |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Rows deleted or corrupted by mistake      | Restore the last good backup into a **local** database, then copy the affected rows back by hand.                                            | Changes since the backup, for those rows only |
| A migration broke the schema              | Fix forward with a new migration if possible. Otherwise restore the pre-migration backup (run the workflow by hand before risky migrations). | Since the backup                              |
| Supabase project paused                   | Restore it from the Supabase dashboard. No backup needed.                                                                                    | None                                          |
| Supabase project deleted or unrecoverable | New project, then steps 1–6 above.                                                                                                           | Up to 24 h                                    |
| Password leaked or rotated                | Reset it in Supabase, update `DATABASE_URL` on Render **and** the `SUPABASE_DB_URL` secret.                                                  | None                                          |
| Backup job failing                        | Read the failed step. Wrong secret → fix it; restore-test mismatch → investigate before trusting any backup.                                 | Risk grows each night it fails                |
| Passphrase lost                           | Existing backups cannot be opened. Set a new `BACKUP_PASSPHRASE` and run the workflow now.                                                   | All existing backups                          |
| Redis lost (Render Key Value restart)     | Nothing to restore. Redis holds only rate-limit counters.                                                                                    | None                                          |

## Limits of this setup

- **GitHub disables scheduled workflows** in a public repo after 60 days with
  no commits. If the repo goes quiet, re-enable the workflow on the Actions
  tab, or backups silently stop.
- **One copy, one provider.** The backup lives on GitHub. For more safety,
  download a monthly backup to separate storage.
- **Restore drill.** The nightly test proves the file restores. It does not
  measure how long a human takes. Do a full drill (steps 1–6 into a scratch
  Supabase project) once, record the time as the real RTO above, and repeat
  quarterly.
