-- Attendee question submission: retry safety and structural duplicate defence.
--
-- HAND-CHECKED. Prisma generates the ADD COLUMN for a NOT NULL `bodyHash` with
-- no default, which fails on any table that already holds rows. Existing
-- questions are backfilled from their `normalizedBody` first, then the default
-- is dropped so future inserts must supply the value explicitly.

-- AlterTable
ALTER TABLE "public"."questions"
  ADD COLUMN "bodyHash"       CHAR(64) NOT NULL DEFAULT '',
  ADD COLUMN "idempotencyKey" VARCHAR(200);

-- Backfill. sha256() and convert_to() are both built in on PG11+, so this needs
-- no extension and produces exactly the digest the application computes.
UPDATE "public"."questions"
   SET "bodyHash" = encode(sha256(convert_to("normalizedBody", 'UTF8')), 'hex')
 WHERE "bodyHash" = '';

ALTER TABLE "public"."questions" ALTER COLUMN "bodyHash" DROP DEFAULT;

-- CreateIndex
--
-- The guarantee that makes "same question repeatedly" impossible rather than
-- merely unlikely. Two concurrent identical submissions cannot both commit —
-- one wins, the other raises a unique violation the application maps to 409.
--
-- Scoped to the attendee rather than the event: two different people asking the
-- same thing is normal and is a merge decision for a moderator, not a rejection.
--
-- NOTE: this statement aborts the migration if the table already contains an
-- exact duplicate pair from before the constraint existed. That is deliberate.
-- Quietly deleting an attendee's question inside a migration would destroy real
-- contributions with no audit trail; a loud failure lets someone decide.
CREATE UNIQUE INDEX "questions_attendeeId_bodyHash_key"
  ON "public"."questions"("attendeeId", "bodyHash");

-- Retry safety on unreliable venue wifi. Postgres treats NULLs as distinct in a
-- unique index, so submissions that carry no Idempotency-Key are unconstrained.
CREATE UNIQUE INDEX "questions_attendeeId_idempotencyKey_key"
  ON "public"."questions"("attendeeId", "idempotencyKey");

-- Trigram index for near-duplicate detection. pg_trgm is created in the init
-- migration. This runs on our own Postgres at zero API cost, which is why
-- duplicate detection works with AI switched off — the default, and the only
-- mode the product currently ships in.
CREATE INDEX "questions_normalizedBody_idx"
  ON "public"."questions" USING GIN ("normalizedBody" gin_trgm_ops);
