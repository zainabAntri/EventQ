import { Module } from '@nestjs/common';
import { EventsController } from './presentation/events.controller';
import { PublicEventsController } from './presentation/public-events.controller';
import {
  ChangeEventStatusUseCase,
  CreateEventUseCase,
  DeleteEventUseCase,
  FindEventForOrganizerUseCase,
  GetEventQrCodeUseCase,
  GetEventUseCase,
  GetPublicEventUseCase,
  ListEventsUseCase,
  UpdateEventUseCase,
} from './application/event.use-cases';
import { PrismaEventRepository } from './infrastructure/prisma-event.repository';
import { CryptoCodeGenerator } from './infrastructure/crypto-code.generator';
import { EVENT_REPOSITORY } from './domain/event.repository';
import { CODE_GENERATOR } from './domain/code-generator.port';

@Module({
  controllers: [EventsController, PublicEventsController],
  providers: [
    // Application
    FindEventForOrganizerUseCase,
    CreateEventUseCase,
    ListEventsUseCase,
    GetEventUseCase,
    GetEventQrCodeUseCase,
    UpdateEventUseCase,
    ChangeEventStatusUseCase,
    DeleteEventUseCase,
    GetPublicEventUseCase,

    // Infrastructure, bound to the ports the domain declares
    PrismaEventRepository,
    CryptoCodeGenerator,
    { provide: EVENT_REPOSITORY, useExisting: PrismaEventRepository },
    { provide: CODE_GENERATOR, useExisting: CryptoCodeGenerator },
  ],
})
export class EventsModule {}
