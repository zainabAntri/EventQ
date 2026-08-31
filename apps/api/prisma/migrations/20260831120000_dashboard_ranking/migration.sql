-- Organizer dashboard: ranking backfill and the index its default view reads.
--
-- `questions.rankScore` has existed since the initial migration but nothing has
-- ever written it, so every existing row holds the column default of 0. Ranked
-- ordering over a table of identical scores degenerates to the id tiebreak,
-- which would make the dashboard's default sort look arbitrary rather than
-- wrong — the worst kind of bug to notice.
--
-- The expression below MIRRORS computeRankScore in packages/contracts/src/
-- ranking.ts. That duplication is deliberate and is bounded: this statement
-- runs exactly once, on rows that predate the application ever computing a
-- score. Every score written from here on is produced by the TypeScript
-- function alone, on insert and on every moderation decision, and an
-- integration test recomputes a stored score from its own row to prove it. So
-- there is no ongoing second implementation to drift — only a one-time repair.
--
-- Reading the terms, in the same order as the TypeScript:
--
--   popularity  2 * log10(votes + 1)          diminishing returns on support
--   recency     (epoch_secs - 1767225600)/1800  one point per 30 minutes, counting
--                                               UP from 2026-01-01T00:00:00Z
--   priority    1e6 when pinned                above any organic score, but still
--                                               inside its own status tier
--   moderation  tier * 1e9                     a coarse band nothing escapes
UPDATE "questions"
   SET "rankScore" =
         2 * log(10, ("upvoteCount" + 1)::numeric)
       + (EXTRACT(EPOCH FROM "createdAt") - 1767225600) / 1800
       + CASE WHEN "pinnedAt" IS NOT NULL THEN 1000000 ELSE 0 END
       + CASE "status"
           WHEN 'ANSWERED' THEN -1000000000
           WHEN 'REJECTED' THEN -2000000000
           WHEN 'SPAM'     THEN -2000000000
           WHEN 'ARCHIVED' THEN -3000000000
           ELSE 0
         END;

-- CreateIndex
--
-- The dashboard's default view is "this event, every status, best first", and
-- the existing (eventId, status, rankScore) index cannot serve it: with no
-- status in the predicate, only the eventId prefix is usable and Postgres must
-- sort the whole event to return one page. At ten thousand questions that is
-- the difference between reading twenty-five index entries and sorting ten
-- thousand rows on every poll.
CREATE INDEX "questions_eventId_rankScore_idx" ON "questions" ("eventId", "rankScore" DESC);
