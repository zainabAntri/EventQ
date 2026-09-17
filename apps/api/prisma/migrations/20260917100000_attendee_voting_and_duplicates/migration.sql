-- Attendee voting and duplicate grouping.
--
-- Voting needs no schema change: question_votes, its unique index and the
-- denormalised upvoteCount have existed since the initial migration, waiting
-- for an endpoint. What this migration adds is the OTHER half of the phase —
-- turning the duplicate SUGGESTION into something a moderator can act on.
--
-- Until now "this looks like question X" lived only in the JSON metadata of an
-- auto_flag audit row. That was enough to display a flag, but an audit row is
-- append-only by design, so there was no way for a moderator to say "no, these
-- are different" and have the suggestion go away. A suggestion that can be
-- raised but never withdrawn is not a suggestion; it is a verdict.
--
-- So the suggestion becomes two nullable columns on the question itself:
--
--   possibleDuplicateOfQuestionId  the question this one may repeat
--   duplicateSimilarity            0–1, so a moderator can weigh 0.95 and 0.62
--                                  differently instead of seeing one flat flag
--
-- Nullable columns with no default are a metadata-only change in Postgres: no
-- table rewrite, no lock held while rows are touched, safe on a live event.

-- AlterTable
ALTER TABLE "questions"
  ADD COLUMN "possibleDuplicateOfQuestionId" UUID,
  ADD COLUMN "duplicateSimilarity" DOUBLE PRECISION;

-- Backfill from the audit trail, so a suggestion raised before this migration
-- is not silently lost. The similarity is left NULL for these: the earlier
-- code never recorded a score, and inventing one would be a lie.
--
-- Guarded twice: the metadata value must look like a UUID before the cast, or
-- a single malformed row would abort the whole migration; and the referenced
-- question must still exist, or the foreign key added below would refuse.
UPDATE "questions" AS q
   SET "possibleDuplicateOfQuestionId" = (m.metadata ->> 'possibleDuplicateOfQuestionId')::uuid
  FROM "moderation_actions" AS m
 WHERE m."questionId" = q.id
   AND m."actorType" = 'SYSTEM'
   AND m.action = 'auto_flag'
   AND m.metadata ->> 'possibleDuplicateOfQuestionId'
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS (
         SELECT 1 FROM "questions" AS original
          WHERE original.id = (m.metadata ->> 'possibleDuplicateOfQuestionId')::uuid
       )
   AND q."possibleDuplicateOfQuestionId" IS NULL;

-- CreateIndex
--
-- "Which questions were flagged as repeating THIS one?" — the reverse lookup a
-- moderator's card needs when the original, not the copy, is in front of them.
CREATE INDEX "questions_possibleDuplicateOfQuestionId_idx" ON "questions"("possibleDuplicateOfQuestionId");

-- AddForeignKey
--
-- SET NULL rather than CASCADE: if the original is hard-deleted, the suggestion
-- evaporates and the newer question stays. A cascade would delete an
-- attendee's question because an unrelated moderator removed a different one.
ALTER TABLE "questions"
  ADD CONSTRAINT "questions_possibleDuplicateOfQuestionId_fkey"
  FOREIGN KEY ("possibleDuplicateOfQuestionId") REFERENCES "questions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
