import { Module } from '@nestjs/common';
import { ObservabilityEventStore } from './observability.store';
import { PrismaObservabilityEventStore } from './prisma-observability-event.store';
import { ObservabilityDiagnosticController } from './diagnostics/observability-diagnostic.controller';
import { ObservabilityDiagnosticService } from './diagnostics/observability-diagnostic.service';
import { ObservabilityReplayController } from './replay/observability-replay.controller';
import { ObservabilityReplayService } from './replay/observability-replay.service';

@Module({
  providers: [
    {
      provide: ObservabilityEventStore,
      useClass: PrismaObservabilityEventStore,
    },
    ObservabilityDiagnosticService,
    ObservabilityReplayService,
  ],
  controllers: [
    ObservabilityDiagnosticController,
    ObservabilityReplayController,
  ],
  exports: [ObservabilityEventStore, ObservabilityDiagnosticService, ObservabilityReplayService],
})
export class ObservabilityModule {}
