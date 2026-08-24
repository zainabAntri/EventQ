import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  canTransition,
  canUnpublish,
  isEditable,
  isPubliclyVisible,
  resolveDeletion,
} from './event-lifecycle';

describe('event lifecycle', () => {
  describe('transitions', () => {
    it('allows the intended path through the lifecycle', () => {
      expect(canTransition('DRAFT', 'PUBLISHED')).toBe(true);
      expect(canTransition('PUBLISHED', 'DRAFT')).toBe(true);
      expect(canTransition('PUBLISHED', 'CLOSED')).toBe(true);
    });

    it('refuses to reopen a closed event', () => {
      // Reopening would let questions arrive after attendees were told the
      // event had finished. Organizers who need this duplicate the event.
      expect(canTransition('CLOSED', 'PUBLISHED')).toBe(false);
      expect(canTransition('CLOSED', 'DRAFT')).toBe(false);
    });

    it('treats archived as terminal', () => {
      // Archived is a soft delete. Anything leaving this state would resurrect
      // an event the organizer believes they deleted.
      expect(allowedTransitions('ARCHIVED')).toEqual([]);
      for (const target of ['DRAFT', 'PUBLISHED', 'CLOSED'] as const) {
        expect(canTransition('ARCHIVED', target)).toBe(false);
      }
    });

    it('refuses to publish an already published event', () => {
      expect(canTransition('PUBLISHED', 'PUBLISHED')).toBe(false);
    });

    it('allows archiving from every non-terminal state', () => {
      for (const from of ['DRAFT', 'PUBLISHED', 'CLOSED'] as const) {
        expect(canTransition(from, 'ARCHIVED')).toBe(true);
      }
    });
  });

  describe('public visibility', () => {
    it('shows only a published, public event', () => {
      expect(isPubliclyVisible('PUBLISHED', 'PUBLIC')).toBe(true);
    });

    it('hides drafts, closed and archived events', () => {
      for (const status of ['DRAFT', 'CLOSED', 'ARCHIVED'] as const) {
        expect(isPubliclyVisible(status, 'PUBLIC')).toBe(false);
      }
    });

    it('hides a private event even when published', () => {
      // Access mode is an independent axis from status: publishing makes an
      // event ready, not necessarily open to the world.
      expect(isPubliclyVisible('PUBLISHED', 'PRIVATE')).toBe(false);
    });
  });

  describe('editability', () => {
    it('allows edits while draft or published', () => {
      expect(isEditable('DRAFT')).toBe(true);
      expect(isEditable('PUBLISHED')).toBe(true);
    });

    it('freezes a closed event', () => {
      // A closed event is a record of what happened. Editing it afterwards
      // would make that record untrustworthy.
      expect(isEditable('CLOSED')).toBe(false);
      expect(isEditable('ARCHIVED')).toBe(false);
    });
  });

  describe('unpublishing', () => {
    it('allows withdrawal while nobody has participated', () => {
      expect(canUnpublish('PUBLISHED', 0)).toBe(true);
    });

    it('refuses once anyone has participated', () => {
      // Withdrawing would hide their contributions and break links people
      // already hold. Closing is the honest action, and it stays available.
      expect(canUnpublish('PUBLISHED', 1)).toBe(false);
    });

    it('refuses from any state other than published', () => {
      expect(canUnpublish('DRAFT', 0)).toBe(false);
      expect(canUnpublish('CLOSED', 0)).toBe(false);
    });
  });

  describe('safe deletion', () => {
    it('permanently deletes an untouched draft', () => {
      // Nothing to lose: an organizer who created an event by mistake should
      // be able to remove it completely.
      expect(resolveDeletion({ status: 'DRAFT', publishedAt: null, participantCount: 0 })).toBe(
        'deleted',
      );
    });

    it('archives a draft that has participation', () => {
      expect(resolveDeletion({ status: 'DRAFT', publishedAt: null, participantCount: 3 })).toBe(
        'archived',
      );
    });

    it('archives anything that was ever published, even with no participants', () => {
      // The link was public. Someone may hold it, and the fact that the event
      // existed is part of the organization's history.
      expect(
        resolveDeletion({ status: 'DRAFT', publishedAt: new Date(), participantCount: 0 }),
      ).toBe('archived');
      expect(
        resolveDeletion({ status: 'PUBLISHED', publishedAt: new Date(), participantCount: 0 }),
      ).toBe('archived');
      expect(
        resolveDeletion({ status: 'CLOSED', publishedAt: new Date(), participantCount: 0 }),
      ).toBe('archived');
    });

    it('never hard-deletes an event with attendee data', () => {
      // The guarantee that matters: attendee contributions are not the
      // organizer's to destroy from a confirmation dialog.
      for (const status of ['DRAFT', 'PUBLISHED', 'CLOSED'] as const) {
        expect(resolveDeletion({ status, publishedAt: new Date(), participantCount: 1 })).toBe(
          'archived',
        );
      }
    });
  });
});
