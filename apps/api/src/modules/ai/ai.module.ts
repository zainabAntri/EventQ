import { Module } from '@nestjs/common';
import { AiController } from './presentation/ai.controller';
import { AiRunner } from './application/ai-runner';
import {
  CategorizeQuestionsUseCase,
  ClusterQuestionsUseCase,
  FindSimilarQuestionUseCase,
  GetAiStatusUseCase,
  GetLatestSummaryUseCase,
  ListTopicsUseCase,
  SuggestAnswerUseCase,
  SummarizeEventUseCase,
} from './application/ai.use-cases';
import { AnthropicAiProvider } from './infrastructure/anthropic-ai.provider';
import { PrismaAiRepository } from './infrastructure/prisma-ai.repository';
import { RedisAiCoordination } from './infrastructure/redis-ai-coordination';
import { AI_PROVIDER } from './domain/ai-provider.port';
import { AI_COORDINATION, AI_REPOSITORY } from './domain/ai.repository';

/**
 * Where the AI ports meet their adapters.
 *
 * `AI_PROVIDER` is the line that names the vendor. Swapping it for another
 * adapter — or, in the integration tests, for a fake that never touches a
 * network — is the whole of what changing provider takes. Everything above
 * this file is vendor-blind by construction.
 *
 * The Anthropic adapter is constructed even when AI is off. It holds a
 * client object and no connection; the runner refuses before any call is
 * made, so with AI_ENABLED=false this module costs nothing and does nothing.
 */
@Module({
  controllers: [AiController],
  providers: [
    AiRunner,
    GetAiStatusUseCase,
    CategorizeQuestionsUseCase,
    FindSimilarQuestionUseCase,
    ClusterQuestionsUseCase,
    ListTopicsUseCase,
    SuggestAnswerUseCase,
    SummarizeEventUseCase,
    GetLatestSummaryUseCase,

    AnthropicAiProvider,
    PrismaAiRepository,
    RedisAiCoordination,
    { provide: AI_PROVIDER, useExisting: AnthropicAiProvider },
    { provide: AI_REPOSITORY, useExisting: PrismaAiRepository },
    { provide: AI_COORDINATION, useExisting: RedisAiCoordination },
  ],
})
export class AiModule {}
