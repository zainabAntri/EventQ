import { Module } from '@nestjs/common';
import { InsightsController } from './presentation/insights.controller';
import { GetEventInsightsUseCase } from './application/get-event-insights.use-case';
import { PrismaInsightsRepository } from './infrastructure/prisma-insights.repository';
import { INSIGHTS_REPOSITORY } from './domain/insights.repository';

/**
 * Event Insights: measured facts, read-only.
 *
 * Deliberately does NOT import the AI module. The AI interpretation of an
 * event is served by that module's own endpoints; keeping the two apart in
 * the module graph is what guarantees a fact on this surface was counted,
 * not generated.
 */
@Module({
  controllers: [InsightsController],
  providers: [
    GetEventInsightsUseCase,
    PrismaInsightsRepository,
    { provide: INSIGHTS_REPOSITORY, useExisting: PrismaInsightsRepository },
  ],
})
export class InsightsModule {}
