import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PublicQuestionsController } from './presentation/public-questions.controller';
import { QuestionsController } from './presentation/questions.controller';
import { AttendeeGuard } from './presentation/attendee.guard';
import {
  GetQuestionStatsUseCase,
  JoinEventUseCase,
  ListModerationQueueUseCase,
  ListPublicQuestionsUseCase,
  ModerateQuestionUseCase,
  SubmitQuestionUseCase,
} from './application/question.use-cases';
import {
  PrismaAttendeeRepository,
  PrismaQuestionRepository,
} from './infrastructure/prisma-question.repository';
import { PrismaEventPolicyReader } from './infrastructure/prisma-event-policy.reader';
import { AttendeeTokenService } from './infrastructure/attendee-token.service';
import { ATTENDEE_REPOSITORY, QUESTION_REPOSITORY } from './domain/question.repository';
import { EVENT_POLICY_READER } from './domain/event-policy.port';
import { ATTENDEE_TOKENS } from './domain/attendee-tokens.port';

/**
 * The one place where the question domain's ports meet their adapters.
 *
 * Swapping the token format, moving questions off Prisma, or replacing the
 * heuristics with something else touches only infrastructure/ and this provider
 * list. Nothing in application/ or domain/ changes.
 *
 * JwtModule is registered with an empty config, exactly as AuthModule does: the
 * secret is passed per call rather than baked in here, so the attendee secret
 * and the organizer secret can never be confused for one another at the point
 * of signing.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [PublicQuestionsController, QuestionsController],
  providers: [
    // Application
    JoinEventUseCase,
    SubmitQuestionUseCase,
    ListPublicQuestionsUseCase,
    ListModerationQueueUseCase,
    GetQuestionStatsUseCase,
    ModerateQuestionUseCase,

    // Presentation
    AttendeeGuard,

    // Infrastructure, bound to the ports the domain declares
    PrismaQuestionRepository,
    PrismaAttendeeRepository,
    PrismaEventPolicyReader,
    AttendeeTokenService,
    { provide: QUESTION_REPOSITORY, useExisting: PrismaQuestionRepository },
    { provide: ATTENDEE_REPOSITORY, useExisting: PrismaAttendeeRepository },
    { provide: EVENT_POLICY_READER, useExisting: PrismaEventPolicyReader },
    { provide: ATTENDEE_TOKENS, useExisting: AttendeeTokenService },
  ],
})
export class QuestionsModule {}
