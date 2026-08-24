import { z } from 'zod';

/**
 * Shared domain vocabulary.
 *
 * These are the SOURCE OF TRUTH for every enum in the system. The Prisma schema
 * mirrors them, and a drift test in apps/api asserts the two stay identical —
 * so a value added here but forgotten in the database fails CI rather than
 * surfacing as a runtime error during a live event.
 */

/**
 * Event vertical. The first use case is NETWORKING; the rest exist because the
 * architecture must absorb them without a schema change.
 */
export const EventType = z.enum([
  'NETWORKING',
  'CONFERENCE',
  'SEMINAR',
  'WORKSHOP',
  'UNIVERSITY',
  'WEBINAR',
  'CORPORATE',
  'PANEL',
]);
export type EventType = z.infer<typeof EventType>;

/**
 * Event lifecycle. Questions may only be submitted while LIVE — enforced as a
 * domain invariant, not a controller check.
 */
export const EventStatus = z.enum(['DRAFT', 'SCHEDULED', 'LIVE', 'PAUSED', 'ENDED', 'ARCHIVED']);
export type EventStatus = z.infer<typeof EventStatus>;

/**
 * Question lifecycle:
 *   PENDING  -> APPROVED | REJECTED | SPAM
 *   APPROVED -> ANSWERED | ARCHIVED
 */
export const QuestionStatus = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'SPAM',
  'ANSWERED',
  'ARCHIVED',
]);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

/** PRE = approve before the room sees it. POST = live immediately, hide later. */
export const ModerationMode = z.enum(['PRE', 'POST']);
export type ModerationMode = z.infer<typeof ModerationMode>;

/**
 * Per-event attendee identity policy. This single column is what lets one
 * codebase serve anonymous university Q&A and identity-required corporate town
 * halls without branching the domain model.
 */
export const AttendeeIdentityMode = z.enum(['ANONYMOUS', 'OPTIONAL', 'REQUIRED']);
export type AttendeeIdentityMode = z.infer<typeof AttendeeIdentityMode>;

/** Organization membership roles. Attendees are NOT a role — they are event-scoped. */
export const OrgRole = z.enum(['OWNER', 'ADMIN', 'MODERATOR', 'SPEAKER']);
export type OrgRole = z.infer<typeof OrgRole>;

/** Who performed an auditable action. AI actions are attributed, never hidden. */
export const ActorType = z.enum(['USER', 'ATTENDEE', 'SYSTEM', 'AI']);
export type ActorType = z.infer<typeof ActorType>;

/** Lifecycle of an AI enrichment record. FAILED never affects its question. */
export const EnrichmentStatus = z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED']);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatus>;

/** AI features, individually flaggable per event and individually killable. */
export const AiFeature = z.enum([
  'CLASSIFICATION',
  'DEDUPLICATION',
  'CLUSTERING',
  'ANSWER_SUGGESTION',
  'SUMMARIZATION',
]);
export type AiFeature = z.infer<typeof AiFeature>;
