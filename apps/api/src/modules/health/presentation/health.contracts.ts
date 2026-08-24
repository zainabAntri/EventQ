import { z } from 'zod';

/**
 * Health response contracts.
 *
 * These live beside the controller rather than in @eventq/contracts because
 * they are an operational concern the web app never consumes — the shared
 * package is for the contract between the two apps, not for everything that
 * happens to be a schema.
 */

export const LivenessResponse = z.object({
  status: z.literal('ok'),
  /** Whole seconds since the process started. */
  uptime: z.number().int().nonnegative(),
});
export type LivenessResponse = z.infer<typeof LivenessResponse>;

export const ReadinessResponse = z.object({
  status: z.enum(['ready', 'degraded']),
  /** One entry per registered dependency probe. */
  checks: z.record(z.string(), z.enum(['up', 'down'])),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
