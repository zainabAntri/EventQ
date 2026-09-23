import { describe, expect, it } from 'vitest';
import {
  acceptsParticipation,
  allowedTransitions,
  canTransition,
  canUnpublish,
  isEditable,
  publicVisibility,
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
    const PUBLISHED_AT = new Date('2026-09-01T10:00:00Z');

    it('opens a published, public event', () => {
      expect(
        publicVisibility({ status: 'PUBLISHED', accessMode: 'PUBLIC', publishedAt: PUBLISHED_AT }),
      ).toBe('open');
    });

    it('discloses a public event that ran and has since closed', () => {
      // The join code was on a screen in front of a whole room and printed on
      // posters. Confirming the event existed tells an attacker nothing the
      // venue did not already tell everyone in it, and it is what lets a poster
      // scanned on the way home say something useful.
      expect(
        publicVisibility({ status: 'CLOSED', accessMode: 'PUBLIC', publishedAt: PUBLISHED_AT }),
      ).toBe('closed');
    });

    it('hides a closed event that was never published', () => {
      // No broadcast ever happened, so the code is still a secret. Inferring
      // "it ran" from the status alone would leak exactly the events nobody
      // was shown.
      expect(publicVisibility({ status: 'CLOSED', accessMode: 'PUBLIC', publishedAt: null })).toBe(
        'hidden',
      );
    });

    it('hides drafts and archived events', () => {
      for (const status of ['DRAFT', 'ARCHIVED'] as const) {
        expect(publicVisibility({ status, accessMode: 'PUBLIC', publishedAt: null })).toBe(
          'hidden',
        );
        // Even with a publish in their history: an archived event is past its
        // retention, and a draft that was once live has been withdrawn.
        expect(publicVisibility({ status, accessMode: 'PUBLIC', publishedAt: PUBLISHED_AT })).toBe(
          'hidden',
        );
      }
    });

    it('hides a private event in every status', () => {
      // Access mode is an independent axis from status, and it is the
      // organizer's explicit choice that the event not be findable. It
      // therefore overrides the closed-event disclosure entirely.
      for (const status of ['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'] as const) {
        expect(publicVisibility({ status, accessMode: 'PRIVATE', publishedAt: PUBLISHED_AT })).toBe(
          'hidden',
        );
      }
    });
  });

  describe('participation', () => {
    it('accepts questions only while published', () => {
      expect(acceptsParticipation('PUBLISHED')).toBe(true);
    });

    it('refuses participation in a closed event even though it is readable', () => {
      // The split that makes the archive safe: visible does not imply writable.
      expect(
        publicVisibility({
          status: 'CLOSED',
          accessMode: 'PUBLIC',
          publishedAt: new Date('2026-09-01T10:00:00Z'),
        }),
      ).toBe('closed');
      expect(acceptsParticipation('CLOSED')).toBe(false);
    });

    it('refuses participation in drafts and archived events', () => {
      expect(acceptsParticipation('DRAFT')).toBe(false);
      expect(acceptsParticipation('ARCHIVED')).toBe(false);
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
