import { Module } from '@nestjs/common';
import { ObservabilityEventStore } from './observability.store';
import { PrismaObservabilityEventStore } from './prisma-observability-event.store';

@Module({
  providers: [
    {
      provide: ObservabilityEventStore,
      useClass: PrismaObservabilityEventStore,
    },
  ],
  exports: [ObservabilityEventStore],
})
export class ObservabilityModule {}
