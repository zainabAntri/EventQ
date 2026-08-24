import { z } from 'zod';
import type { OrgRole } from './enums.js';

/**
 * Authorization as data, not as scattered `if (role === 'ADMIN')` checks.
 *
 * This matrix is shared deliberately: the API enforces it in a guard, and the
 * web app reads the same table to decide which controls to render. One
 * definition means the UI can never offer an action the API will reject.
 *
 * The web app using this for rendering is a convenience, NOT a security
 * control — the API enforces every permission server-side regardless.
 */

export const Permission = z.enum([
  'org:billing',
  'org:manage_members',
  'org:update',
  'org:delete',
  'event:create',
  'event:read',
  'event:update',
  'event:delete',
  'question:read',
  'question:moderate',
  'question:answer',
  'ai:run',
  'export:data',
]);
export type Permission = z.infer<typeof Permission>;

/**
 * Role -> permission set.
 *
 * Roles are cumulative in practice but written out explicitly rather than by
 * inheritance: an explicit table is auditable at a glance, and a security
 * review should never have to mentally resolve an inheritance chain.
 */
export const ROLE_PERMISSIONS: Readonly<Record<OrgRole, readonly Permission[]>> = Object.freeze({
  OWNER: [
    'org:billing',
    'org:manage_members',
    'org:update',
    'org:delete',
    'event:create',
    'event:read',
    'event:update',
    'event:delete',
    'question:read',
    'question:moderate',
    'question:answer',
    'ai:run',
    'export:data',
  ],
  ADMIN: [
    'org:manage_members',
    'org:update',
    'event:create',
    'event:read',
    'event:update',
    'question:read',
    'question:moderate',
    'question:answer',
    'ai:run',
    'export:data',
  ],
  MODERATOR: ['event:read', 'question:read', 'question:moderate', 'question:answer', 'ai:run'],
  SPEAKER: ['event:read', 'question:read', 'question:answer'],
} satisfies Record<OrgRole, readonly Permission[]>);

/** Does this role hold this permission? */
export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Does this role hold every one of these permissions? */
export function roleHasAllPermissions(role: OrgRole, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => roleHasPermission(role, permission));
}
