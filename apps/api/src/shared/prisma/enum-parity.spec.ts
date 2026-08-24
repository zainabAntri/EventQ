import { describe, expect, it } from 'vitest';
import { $Enums } from '@prisma/client';
import {
  ActorType,
  AttendeeIdentityMode,
  EnrichmentStatus,
  EventStatus,
  EventType,
  ModerationMode,
  OrgRole,
  QuestionStatus,
} from '@eventq/contracts';

/**
 * Guards the one coupling the architecture cannot express in a type: the same
 * vocabulary is declared twice, once in @eventq/contracts (the source of truth,
 * shared with the web app) and once in schema.prisma (which the database needs).
 *
 * Without this test, adding a value in one place and forgetting the other is a
 * silent failure that surfaces as a runtime crash the first time a real user
 * triggers the new value — plausibly mid-event, in front of an audience.
 *
 * Sets, not arrays: declaration order is irrelevant, membership is not.
 */
const CASES: ReadonlyArray<{
  name: string;
  contract: readonly string[];
  prisma: Readonly<Record<string, string>>;
}> = [
  { name: 'EventType', contract: EventType.options, prisma: $Enums.EventType },
  { name: 'EventStatus', contract: EventStatus.options, prisma: $Enums.EventStatus },
  { name: 'QuestionStatus', contract: QuestionStatus.options, prisma: $Enums.QuestionStatus },
  { name: 'ModerationMode', contract: ModerationMode.options, prisma: $Enums.ModerationMode },
  {
    name: 'AttendeeIdentityMode',
    contract: AttendeeIdentityMode.options,
    prisma: $Enums.AttendeeIdentityMode,
  },
  { name: 'OrgRole', contract: OrgRole.options, prisma: $Enums.OrgRole },
  { name: 'ActorType', contract: ActorType.options, prisma: $Enums.ActorType },
  { name: 'EnrichmentStatus', contract: EnrichmentStatus.options, prisma: $Enums.EnrichmentStatus },
];

describe('enum parity between @eventq/contracts and the Prisma schema', () => {
  it.each(CASES)('$name has identical values in both definitions', ({ contract, prisma }) => {
    const fromContract = [...contract].sort();
    const fromPrisma = Object.values(prisma).sort();

    expect(fromPrisma).toEqual(fromContract);
  });

  it('covers every enum the Prisma schema defines', () => {
    // Catches the other direction: a NEW enum added to the schema that nobody
    // added a parity case for would otherwise slip through unnoticed.
    const checked = new Set(CASES.map((c) => c.name));
    const declared = Object.keys($Enums);

    expect([...declared].sort()).toEqual([...checked].sort());
  });
});
