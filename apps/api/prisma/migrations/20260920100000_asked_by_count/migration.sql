-- Every existing question was asked by its author; merged copies were never
-- counted before this column existed, so 1 is the honest backfill.
ALTER TABLE "questions" ADD COLUMN "askedByCount" INTEGER NOT NULL DEFAULT 1;
