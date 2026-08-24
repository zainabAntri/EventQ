/**
 * @eventq/contracts
 *
 * The shared contract between apps/api and apps/web. Every wire format, enum
 * and permission lives here exactly once, so the two sides cannot drift: a
 * change that breaks the frontend fails the backend's typecheck in the same
 * commit.
 */

export * from './primitives.js';
export * from './enums.js';
export * from './permissions.js';
export * from './errors.js';
export * from './realtime.js';
export * from './auth.js';
