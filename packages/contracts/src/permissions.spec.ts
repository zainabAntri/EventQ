import { describe, expect, it } from 'vitest';
import { OrgRole } from './enums.js';
import {
  Permission,
  ROLE_PERMISSIONS,
  roleHasAllPermissions,
  roleHasPermission,
} from './permissions.js';

/**
 * The permission matrix is a security control, not a lookup table.
 *
 * It is shared by the API guard and the web UI, so a mistake here is either a
 * privilege escalation or a control the user can see but never use. These tests
 * assert the boundaries that actually matter.
 */
describe('permission matrix', () => {
  it('defines permissions for every role, with none left out', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...OrgRole.options].sort());
  });

  it('only references permissions that exist', () => {
    // Catches a typo'd permission string, which would otherwise silently grant
    // nothing and look like a mysterious 403.
    const valid = new Set(Permission.options);
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(valid.has(permission), `${role} references unknown "${permission}"`).toBe(true);
      }
    }
  });

  it('gives the owner every permission', () => {
    expect(roleHasAllPermissions('OWNER', Permission.options)).toBe(true);
  });

  it('reserves billing for the owner alone', () => {
    // Deliberately excluded from ADMIN: managing members is not the same
    // authority as spending money.
    expect(roleHasPermission('OWNER', 'org:billing')).toBe(true);
    for (const role of ['ADMIN', 'MODERATOR', 'SPEAKER'] as const) {
      expect(roleHasPermission(role, 'org:billing')).toBe(false);
    }
  });

  it('reserves organization deletion for the owner alone', () => {
    for (const role of ['ADMIN', 'MODERATOR', 'SPEAKER'] as const) {
      expect(roleHasPermission(role, 'org:delete')).toBe(false);
    }
  });

  it('lets moderators moderate but not create or reconfigure events', () => {
    expect(roleHasPermission('MODERATOR', 'question:moderate')).toBe(true);
    expect(roleHasPermission('MODERATOR', 'event:create')).toBe(false);
    expect(roleHasPermission('MODERATOR', 'event:update')).toBe(false);
  });

  it('lets speakers answer but never moderate', () => {
    // A speaker seeing questions is the point; a speaker silently rejecting the
    // ones they dislike is not.
    expect(roleHasPermission('SPEAKER', 'question:answer')).toBe(true);
    expect(roleHasPermission('SPEAKER', 'question:read')).toBe(true);
    expect(roleHasPermission('SPEAKER', 'question:moderate')).toBe(false);
  });

  it('restricts data export to owner and admin', () => {
    // Export means bulk attendee PII leaving the system.
    expect(roleHasPermission('OWNER', 'export:data')).toBe(true);
    expect(roleHasPermission('ADMIN', 'export:data')).toBe(true);
    expect(roleHasPermission('MODERATOR', 'export:data')).toBe(false);
    expect(roleHasPermission('SPEAKER', 'export:data')).toBe(false);
  });

  it('lets every role read events', () => {
    for (const role of OrgRole.options) {
      expect(roleHasPermission(role, 'event:read')).toBe(true);
    }
  });

  it('cannot be mutated at runtime', () => {
    // Frozen so a caller cannot grant itself a permission by pushing onto the
    // array it was handed.
    expect(Object.isFrozen(ROLE_PERMISSIONS)).toBe(true);
  });
});
