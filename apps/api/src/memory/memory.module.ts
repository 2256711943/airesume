import { Module } from '@nestjs/common';
import { ContextBudgetManagerService } from './context-budget-manager.service';
import { ContextPackReadService } from './context-pack-read.service';
import { InMemoryRuntimeMemoryStore } from './in-memory-runtime-memory.store';
import { MemoryCandidateExtractor } from './memory-candidate-extractor';
import { MemoryCaptureService } from './memory-capture.service';
import { MemoryDecisionService } from './memory-decision.service';
import {
  DefaultMemorySummarizer,
  MEMORY_SUMMARIZER,
} from './memory-summarizer';
import { MemoryStoreFacade } from './memory-store-facade';
import { PrismaContextPackStore } from './prisma-context-pack.store';
import { PrismaLongTermMemoryStore } from './prisma-long-term-memory.store';
import { PrismaPersistentMemoryStore } from './prisma-persistent-memory.store';
import {
  ContextPackStore,
  LongTermMemoryStore,
  MemoryStore,
  PersistentMemoryStore,
  RuntimeMemoryStore,
} from './memory.store';

@Module({
  providers: [
    ContextBudgetManagerService,
    ContextPackReadService,
    MemoryCandidateExtractor,
    MemoryDecisionService,
    MemoryCaptureService,
    {
      provide: RuntimeMemoryStore,
      useClass: InMemoryRuntimeMemoryStore,
    },
    {
      provide: PersistentMemoryStore,
      useClass: PrismaPersistentMemoryStore,
    },
    {
      provide: LongTermMemoryStore,
      useClass: PrismaLongTermMemoryStore,
    },
    DefaultMemorySummarizer,
    {
      provide: MEMORY_SUMMARIZER,
      useExisting: DefaultMemorySummarizer,
    },
    {
      provide: MemoryStore,
      useClass: MemoryStoreFacade,
    },
    {
      provide: ContextPackStore,
      useClass: PrismaContextPackStore,
    },
  ],
  exports: [
    MemoryStore,
    LongTermMemoryStore,
    ContextPackStore,
    ContextPackReadService,
    ContextBudgetManagerService,
    MemoryCaptureService,
  ],
})
export class MemoryModule {}
