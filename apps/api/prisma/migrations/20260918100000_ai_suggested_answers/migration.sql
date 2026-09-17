-- AI enrichment: the answer draft.
--
-- Everything else this phase writes already has a home reserved since the
-- initial migration: `category` on question_enrichments, `topics` and
-- `questions.topicId` for clustering, `event_summaries` for the summary, and
-- `ai_usage` for the ledger the budget cap is enforced against. What was not
-- anticipated was a place to hold a SUGGESTED answer.
--
-- It is deliberately NOT a row in `answers`. That table is what the room sees,
-- and a draft nobody has read must never be one click — or one bug — away
-- from being published. The draft lives on the enrichment row, next to the
-- other things a model produced, and only a person can turn it into an answer.
--
-- Nullable columns with no default: a metadata-only change, no table rewrite.

-- AlterTable
ALTER TABLE "question_enrichments"
  ADD COLUMN "suggestedAnswer" TEXT,
  ADD COLUMN "suggestedAnswerCaveats" JSONB,
  ADD COLUMN "suggestedAnswerModelId" VARCHAR(100),
  ADD COLUMN "suggestedAnswerAt" TIMESTAMP(3);
