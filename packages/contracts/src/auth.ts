import { z } from 'zod';
import { Email, EntityId } from './primitives.js';
import { OrgRole } from './enums.js';

/**
 * Organizer authentication contracts.
 *
 * Shared by the API (validation + OpenAPI) and the web app (types), so the two
 * cannot disagree about what a registration payload looks like.
 */

/**
 * Password policy.
 *
 * Length is the requirement that actually correlates with resistance to
 * cracking. Deliberately NO composition rules (one upper, one symbol, ...):
 * they push people toward `Password1!` and are explicitly discouraged by
 * NIST SP 800-63B. A 12-character minimum with a generous ceiling is stronger
 * and less hostile.
 *
 * The 200-character cap exists because argon2 hashing cost grows with input,
 * so an unbounded password is a cheap denial-of-service.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export const Password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, {
    error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  })
  .max(MAX_PASSWORD_LENGTH, {
    error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
  });

export const RegisterRequest = z.object({
  email: Email,
  password: Password,
  name: z.string().trim().min(1).max(200),
  /**
   * Optional organization name. Registration always creates one — every event
   * belongs to an organization — but an organizer signing up alone should not
   * have to invent a company name first.
   */
  organizationName: z.string().trim().min(1).max(200).optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** The signed-in organizer and the organization they act within. */
export const AuthenticatedOrganizer = z.object({
  id: EntityId,
  email: Email,
  name: z.string(),
  emailVerified: z.boolean(),
  organization: z.object({
    id: EntityId,
    name: z.string(),
    slug: z.string(),
    role: OrgRole,
  }),
});
export type AuthenticatedOrganizer = z.infer<typeof AuthenticatedOrganizer>;

/**
 * Tokens are NOT in the response body — they are set as httpOnly cookies, so
 * JavaScript (and therefore any XSS payload) cannot read them.
 */
export const AuthSessionResponse = z.object({
  organizer: AuthenticatedOrganizer,
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;

/** Cookie names, shared so the web app never hard-codes a string. */
export const ACCESS_TOKEN_COOKIE = 'eq_at';
export const REFRESH_TOKEN_COOKIE = 'eq_rt';

/**
 * Required on every state-changing request.
 *
 * With SameSite=Lax cookies, a cross-site form POST is already blocked. This
 * header adds a second, independent barrier: a custom header cannot be sent
 * cross-origin without a CORS preflight, which our allowlist refuses.
 */
export const CSRF_HEADER = 'x-eventq-client';
export const CSRF_HEADER_VALUE = 'web';
