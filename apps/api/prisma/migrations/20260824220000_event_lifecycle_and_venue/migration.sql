-- Event lifecycle simplification, venue, creator and access mode.
--
-- HAND-EDITED. The SQL Prisma generates for the enum change casts straight
-- across with `USING ("status"::text::"EventStatus_new")`, which fails on any
-- row holding SCHEDULED, LIVE, PAUSED or ENDED — none of those exist in the new
-- type. Existing rows are remapped to their new equivalents first.

-- CreateEnum
CREATE TYPE "EventAccessMode" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterEnum: DRAFT | SCHEDULED | LIVE | PAUSED | ENDED | ARCHIVED
--         -> DRAFT | PUBLISHED | CLOSED | ARCHIVED
BEGIN;

CREATE TYPE "EventStatus_new" AS ENUM ('DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED');

ALTER TABLE "public"."events" ALTER COLUMN "status" DROP DEFAULT;

-- Widen to text so the retired values can be rewritten before the new type is
-- applied. Without this step the cast below rejects them.
ALTER TABLE "public"."events" ALTER COLUMN "status" TYPE TEXT USING ("status"::text);

--   SCHEDULED / LIVE / PAUSED -> PUBLISHED  (all meant "visible to attendees")
--   ENDED                     -> CLOSED     (renamed only)
UPDATE "public"."events" SET "status" = 'PUBLISHED'
  WHERE "status" IN ('SCHEDULED', 'LIVE', 'PAUSED');
UPDATE "public"."events" SET "status" = 'CLOSED'
  WHERE "status" = 'ENDED';

ALTER TABLE "public"."events"
  ALTER COLUMN "status" TYPE "EventStatus_new" USING ("status"::"EventStatus_new");

ALTER TYPE "public"."EventStatus" RENAME TO "EventStatus_old";
ALTER TYPE "public"."EventStatus_new" RENAME TO "EventStatus";
DROP TYPE "public"."EventStatus_old";

ALTER TABLE "public"."events" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

COMMIT;

-- AlterTable: per-event access configuration
ALTER TABLE "public"."event_settings"
  ADD COLUMN "accessMode" "EventAccessMode" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable: all nullable, so this takes only a brief lock and is safe to run
-- while events are in flight.
ALTER TABLE "public"."events"
  ADD COLUMN "closedAt"    TIMESTAMP(3),
  ADD COLUMN "createdById" UUID,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "venue"       VARCHAR(500);

-- Backfill lifecycle timestamps for rows that predate these columns, so
-- "when was this published" is not silently null for existing events.
UPDATE "public"."events" SET "publishedAt" = "updatedAt"
  WHERE "status" IN ('PUBLISHED', 'CLOSED') AND "publishedAt" IS NULL;
UPDATE "public"."events" SET "closedAt" = "updatedAt"
  WHERE "status" = 'CLOSED' AND "closedAt" IS NULL;

-- SET NULL rather than CASCADE: an event must outlive the departure of whoever
-- created it.
ALTER TABLE "public"."events" ADD CONSTRAINT "events_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "public"."users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Organizer dashboard: an organization's events, newest first. Replaces the
-- narrower (orgId, status) index, which could not serve the ordering.
DROP INDEX IF EXISTS "public"."events_orgId_status_idx";
CREATE INDEX "events_orgId_status_createdAt_idx"
  ON "public"."events" ("orgId", "status", "createdAt" DESC);
