import { describe, expect, it } from 'vitest';
import { QuestionStatus, type QuestionModerationAction } from '@eventq/contracts';
import {
  allowedActionsFor,
  allowedTransitions,
  canTransition,
  isVisibleToRoom,
  statusOnSubmission,
  statusVisibleToAuthor,
  targetStatusFor,
} from './question-lifecycle';

/**
 * The state machine, asserted exhaustively.
 *
 * Every one of the 36 (from, to) pairs is checked against this table rather
 * than testing a handful of interesting cases. A state machine tested by
 * example is a state machine with untested edges, and the untested edge is
 * exactly where "the frontend moved a question somewhere it should not have
 * been able to" lives.
 */
const LEGAL: Readonly<Record<QuestionStatus, readonly QuestionStatus[]>> = {
  PENDING: ['APPROVED', 'REJECTED', 'SPAM', 'ARCHIVED'],
  APPROVED: ['ANSWERED', 'REJECTED', 'ARCHIVED'],
  REJECTED: ['PENDING', 'ARCHIVED'],
  SPAM: ['PENDING', 'ARCHIVED'],
  ANSWERED: ['APPROVED', 'ARCHIVED'],
  ARCHIVED: [],
};

const ALL_STATUSES = QuestionStatus.options;

describe('question transitions', () => {
  it.each(ALL_STATUSES)('permits exactly the documented moves out of %s', (from) => {
    const permitted = ALL_STATUSES.filter((to) => canTransition(from, to));

    expect([...permitted].sort()).toEqual([...LEGAL[from]].sort());
  });

  it('refuses every transition the table does not name', () => {
    // The complement of the above, stated as its own assertion so a table edited
    // to be more permissive cannot pass by accident.
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = LEGAL[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it('never allows a question to re-enter its own state', () => {
    // A no-op transition would write a spurious moderation audit entry and, for
    // ANSWERED, reset the answered timestamp.
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status), `${status} -> itself`).toBe(false);
    }
  });

  it('makes ARCHIVED terminal, so a removed question cannot return to the board', () => {
    expect(allowedTransitions('ARCHIVED')).toEqual([]);
    for (const to of ALL_STATUSES) {
      expect(canTransition('ARCHIVED', to)).toBe(false);
    }
  });

  it('sends a restored question back to the queue rather than straight to the room', () => {
    // Undoing a mistake must not be a faster route to publishing than the
    // ordinary one. Both recoverable negative states land in PENDING.
    expect(targetStatusFor('restore')).toBe('PENDING');
    expect(canTransition('REJECTED', 'PENDING')).toBe(true);
    expect(canTransition('SPAM', 'PENDING')).toBe(true);
    expect(canTransition('SPAM', 'APPROVED')).toBe(false);
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false);
  });
});

describe('moderation actions', () => {
  const CASES: ReadonlyArray<[QuestionModerationAction, QuestionStatus]> = [
    ['approve', 'APPROVED'],
    ['reject', 'REJECTED'],
    ['spam', 'SPAM'],
    ['answer', 'ANSWERED'],
    ['archive', 'ARCHIVED'],
    ['restore', 'PENDING'],
  ];

  it.each(CASES)('maps the "%s" action to %s', (action, expected) => {
    expect(targetStatusFor(action)).toBe(expected);
  });

  it('decides an action from the CURRENT state, not from anything the client said', () => {
    // This is the real content of "no arbitrary status changes from the
    // frontend". A client names an intent; whether that intent is legal is
    // resolved here against the state the question is actually in. The same
    // action is accepted or refused purely on that basis.
    expect(canTransition('PENDING', targetStatusFor('approve'))).toBe(true);
    expect(canTransition('ARCHIVED', targetStatusFor('approve'))).toBe(false);
    expect(canTransition('SPAM', targetStatusFor('answer'))).toBe(false);
    expect(canTransition('REJECTED', targetStatusFor('spam'))).toBe(false);
  });

  it('leaves no action able to reach a state the table forbids', () => {
    // Exhaustive: for every action and every starting state, the destination is
    // permitted only when the transition table says so. An action added later
    // without a matching table entry cannot quietly become a bypass.
    for (const [action] of CASES) {
      for (const from of ALL_STATUSES) {
        const to = targetStatusFor(action);
        expect(canTransition(from, to), `${action} from ${from} -> ${to}`).toBe(
          LEGAL[from].includes(to),
        );
      }
    }
  });
});

describe('status on submission', () => {
  it('holds a question for a moderator when the event pre-moderates', () => {
    expect(statusOnSubmission('PRE', 'clean')).toBe('PENDING');
  });

  it('publishes immediately when the event post-moderates', () => {
    expect(statusOnSubmission('POST', 'clean')).toBe('APPROVED');
  });

  it('quarantines a spam verdict regardless of the event setting', () => {
    expect(statusOnSubmission('PRE', 'spam')).toBe('SPAM');
    expect(statusOnSubmission('POST', 'spam')).toBe('SPAM');
  });

  it('forces a human to look at an uncertain question even on a post-moderated event', () => {
    expect(statusOnSubmission('POST', 'review')).toBe('PENDING');
    expect(statusOnSubmission('PRE', 'review')).toBe('PENDING');
  });

  it('only ever makes the outcome stricter, never more permissive', () => {
    // The guarantee that matters: an organizer who chose PRE moderation can
    // never have a question published by the spam heuristics deciding it looked
    // fine. If this ever failed, a bug in the heuristics would become a way to
    // bypass moderation entirely.
    const strictness: Record<QuestionStatus, number> = {
      APPROVED: 0,
      ANSWERED: 0,
      PENDING: 1,
      REJECTED: 2,
      SPAM: 2,
      ARCHIVED: 2,
    };

    for (const mode of ['PRE', 'POST'] as const) {
      const baseline = statusOnSubmission(mode, 'clean');
      for (const verdict of ['clean', 'review', 'spam'] as const) {
        const actual = statusOnSubmission(mode, verdict);
        expect(
          strictness[actual],
          `${mode}/${verdict} produced ${actual}, which is looser than ${baseline}`,
        ).toBeGreaterThanOrEqual(strictness[baseline]);
      }
    }
  });

  it('never returns a status a submission should not be able to reach', () => {
    for (const mode of ['PRE', 'POST'] as const) {
      for (const verdict of ['clean', 'review', 'spam'] as const) {
        expect(['PENDING', 'APPROVED', 'SPAM']).toContain(statusOnSubmission(mode, verdict));
      }
    }
  });
});

describe('visibility', () => {
  it('shows the room approved and answered questions only', () => {
    expect(ALL_STATUSES.filter(isVisibleToRoom).sort()).toEqual(['ANSWERED', 'APPROVED']);
  });

  it('keeps an answered question on the board rather than hiding it', () => {
    // It becomes most useful at the moment it is answered; removing it then is
    // exactly backwards.
    expect(isVisibleToRoom('ANSWERED')).toBe(true);
  });

  it('never tells an author their own question was marked as spam', () => {
    // Confirming a hit turns the filter into a free oracle for tuning past it.
    // "Waiting for a moderator" is also what a false positive genuinely is.
    expect(statusVisibleToAuthor('SPAM')).toBe('PENDING');
  });

  it('reports every other status to the author unchanged', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'SPAM')) {
      expect(statusVisibleToAuthor(status)).toBe(status);
    }
  });
});

/**
 * What the dashboard is allowed to offer.
 *
 * These actions are sent to the client on every question, so a bug here is not
 * a wrong answer in a function — it is a button that appears and then fails, or
 * one that never appears and leaves a moderator unable to act.
 */
describe('actions offered to a moderator', () => {
  it('offers only actions whose destination the state machine permits', () => {
    for (const status of ALL_STATUSES) {
      for (const action of allowedActionsFor(status)) {
        expect(
          canTransition(status, targetStatusFor(action)),
          `${status} offered "${action}", which it cannot perform`,
        ).toBe(true);
      }
    }
  });

  it('offers every action the state machine permits, leaving none unreachable', () => {
    // The other direction, and the one a naive hand-written table gets wrong:
    // a legal transition with no action offered is a moderator who simply
    // cannot do something the domain allows.
    for (const status of ALL_STATUSES) {
      const reachable = new Set(allowedActionsFor(status).map(targetStatusFor));

      for (const destination of allowedTransitions(status)) {
        expect(
          reachable.has(destination),
          `${status} can move to ${destination} but no action offers it`,
        ).toBe(true);
      }
    }
  });

  it('offers restore on exactly the states a negative decision put a question in', () => {
    // "Restore where appropriate" made concrete: undoing a rejection or a spam
    // call, and nothing else.
    const restorable = ALL_STATUSES.filter((status) =>
      allowedActionsFor(status).includes('restore'),
    );

    expect([...restorable].sort()).toEqual(['REJECTED', 'SPAM']);
  });

  it('offers nothing at all on an archived question', () => {
    // ARCHIVED is the soft-delete state and is terminal. A dashboard that
    // rendered an action here would be offering to undo a deliberate removal.
    expect(allowedActionsFor('ARCHIVED')).toEqual([]);
  });

  it('never offers approve as a one-click undo of a rejection', () => {
    // The recovery path must not be a faster route to the room than the
    // ordinary one. Restoring returns a question to the queue for a second look.
    expect(allowedActionsFor('REJECTED')).not.toContain('approve');
    expect(allowedActionsFor('SPAM')).not.toContain('approve');
  });

  it('lets an answered question be put back on the board', () => {
    // A question answered by mistake, or reopened because the answer was wrong.
    expect(allowedActionsFor('ANSWERED')).toContain('approve');
  });

  it('offers archive from every state that is not already archived', () => {
    for (const status of ALL_STATUSES.filter((s) => s !== 'ARCHIVED')) {
      expect(allowedActionsFor(status), `${status} cannot be archived`).toContain('archive');
    }
  });
});
