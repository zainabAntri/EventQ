/**
 * Deterministic identifiers for seeded rows.
 *
 * Fixed UUIDs are what make seeding idempotent: every write is an upsert keyed
 * on a known id, so running `pnpm db:seed` ten times produces exactly the same
 * database as running it once. Random ids would accumulate duplicates and make
 * "reset the database" the only safe way to re-seed.
 *
 * These are UUID v7 values with a fixed prefix so seeded rows are obvious at a
 * glance in a query result.
 */
export const SEED_IDS = {
  org: '01930000-0000-7000-8000-000000000001',
  users: {
    owner: '01930000-0000-7000-8000-000000000101',
    admin: '01930000-0000-7000-8000-000000000102',
    moderator: '01930000-0000-7000-8000-000000000103',
    speaker: '01930000-0000-7000-8000-000000000104',
  },
  event: '01930000-0000-7000-8000-000000000201',
  attendees: [
    '01930000-0000-7000-8000-000000000301',
    '01930000-0000-7000-8000-000000000302',
    '01930000-0000-7000-8000-000000000303',
  ],
  questions: [
    '01930000-0000-7000-8000-000000000401',
    '01930000-0000-7000-8000-000000000402',
    '01930000-0000-7000-8000-000000000403',
    '01930000-0000-7000-8000-000000000404',
  ],
} as const;

/**
 * Seeded accounts.
 *
 * One per role, so the permission matrix can be exercised by hand without
 * creating users first. Passwords are NEVER stored here — the seed generates
 * one at runtime and prints it.
 */
export const SEED_USERS = [
  { id: SEED_IDS.users.owner, email: 'owner@eventq.local', name: 'Olivia Owner', role: 'OWNER' },
  { id: SEED_IDS.users.admin, email: 'admin@eventq.local', name: 'Adam Admin', role: 'ADMIN' },
  {
    id: SEED_IDS.users.moderator,
    email: 'moderator@eventq.local',
    name: 'Mia Moderator',
    role: 'MODERATOR',
  },
  {
    id: SEED_IDS.users.speaker,
    email: 'speaker@eventq.local',
    name: 'Sam Speaker',
    role: 'SPEAKER',
  },
] as const;

/**
 * Realistic questions for a business networking event — the first use case.
 *
 * Deliberately includes a near-duplicate pair (indices 0 and 3) so the
 * pg_trgm duplicate detection built in a later phase has something real to
 * find, at zero API cost.
 */
export const SEED_QUESTIONS = [
  {
    id: SEED_IDS.questions[0],
    body: 'What is the most effective way to follow up after meeting someone at an event like this?',
    status: 'APPROVED',
    upvoteCount: 12,
    attendeeIndex: 0,
  },
  {
    id: SEED_IDS.questions[1],
    body: 'How do you keep a professional network warm without it feeling transactional?',
    status: 'APPROVED',
    upvoteCount: 8,
    attendeeIndex: 1,
  },
  {
    id: SEED_IDS.questions[2],
    body: 'Which metrics actually matter when measuring the return on networking events?',
    status: 'PENDING',
    upvoteCount: 0,
    attendeeIndex: 2,
  },
  {
    id: SEED_IDS.questions[3],
    body: "What's the best approach for following up with someone after an event?",
    status: 'PENDING',
    upvoteCount: 0,
    attendeeIndex: 1,
  },
] as const;

export const SEED_ATTENDEES = [
  { id: SEED_IDS.attendees[0], displayName: 'Priya Raman', company: 'Northwind Labs' },
  { id: SEED_IDS.attendees[1], displayName: 'Tomás Ferreira', company: 'Beacon Analytics' },
  // Identity is OPTIONAL on this event, so one attendee stays anonymous.
  { id: SEED_IDS.attendees[2], displayName: null, company: null },
] as const;

export const SEED_EVENT = {
  id: SEED_IDS.event,
  title: 'Founders & Funders Networking Night',
  description:
    'An evening of introductions between early-stage founders and investors. Ask anything.',
  // Must satisfy the JoinCode contract, whose alphabet excludes I, L, O and U.
  // "DEMO2026" looks fine and is invalid — the O is not in the alphabet.
  joinCode: 'EVENTQ26',
  slug: 'founders-and-funders',
  type: 'NETWORKING',
  status: 'PUBLISHED',
} as const;

export const SEED_ORG = {
  id: SEED_IDS.org,
  name: 'EventQ Demo Organisation',
  slug: 'eventq-demo',
} as const;
