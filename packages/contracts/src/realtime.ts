import { z } from 'zod';
import { EntityId } from './primitives.js';
import { QuestionStatus } from './enums.js';

/**
 * The realtime protocol, carried over Server-Sent Events.
 *
 * SSE rather than WebSockets because every realtime need in EventQ is
 * server -> client; attendee and organizer actions travel over ordinary REST.
 * That buys plain HTTP through the ALB, no sticky sessions, and browser-native
 * reconnection with Last-Event-ID replay.
 *
 * Every event carries a monotonic `seq` per event stream so a client that
 * reconnects can tell whether it missed anything and refetch if so. Without
 * this, a dropped connection during a keynote silently desynchronises the
 * projector from the dashboard.
 */

export const RealtimeEventType = z.enum([
  'question.submitted',
  'question.approved',
  'question.rejected',
  'question.merged',
  'question.answered',
  'question.deleted',
  'question.pinned',
  'vote.changed',
  'event.status_changed',
  'event.now_answering',
  'heartbeat',
]);
export type RealtimeEventType = z.infer<typeof RealtimeEventType>;

/** Payload shapes, one per event type. Kept minimal — clients refetch detail. */
const QuestionRef = z.object({
  questionId: EntityId,
  status: QuestionStatus,
});

const VoteChanged = z.object({
  questionId: EntityId,
  upvoteCount: z.number().int().nonnegative(),
});

const QuestionMerged = z.object({
  questionId: EntityId,
  mergedIntoQuestionId: EntityId,
});

/**
 * SSE envelope.
 *
 * `seq` is per-event-stream and strictly increasing. `Last-Event-ID` on
 * reconnect carries the last `seq` the client saw.
 */
export const RealtimeEnvelope = z.object({
  seq: z.number().int().nonnegative(),
  type: RealtimeEventType,
  eventId: EntityId,
  at: z.iso.datetime(),
  data: z.unknown(),
});
export type RealtimeEnvelope = z.infer<typeof RealtimeEnvelope>;

/**
 * Payload schema per event type, so a consumer can validate `data` after
 * narrowing on `type` rather than casting it.
 */
export const REALTIME_PAYLOAD_SCHEMAS = {
  'question.submitted': QuestionRef,
  'question.approved': QuestionRef,
  'question.rejected': QuestionRef,
  'question.merged': QuestionMerged,
  'question.answered': QuestionRef,
  'question.deleted': QuestionRef,
  'question.pinned': QuestionRef,
  'vote.changed': VoteChanged,
  'event.status_changed': z.object({ status: z.string() }),
  'event.now_answering': z.object({ questionId: EntityId.nullable() }),
  heartbeat: z.object({}),
} as const satisfies Record<RealtimeEventType, z.ZodType>;

/**
 * Heartbeat cadence. Proxies and load balancers close idle connections; a
 * periodic comment frame keeps the stream alive and lets the client detect a
 * dead connection quickly rather than sitting on a silent socket.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

/** Redis pub/sub channel for an event's realtime fan-out across API instances. */
export function realtimeChannel(eventId: string): string {
  return `eventq:realtime:${eventId}`;
}
