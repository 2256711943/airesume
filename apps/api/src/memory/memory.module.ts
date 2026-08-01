import { Module } from '@nestjs/common';
import { ContextBudgetManagerService } from './context-budget-manager.service';
import { ContextPackReadService } from './context-pack-read.service';
import { InMemoryRuntimeMemoryStore } from './in-memory-runtime-memory.store';
import {
  DefaultMemorySummarizer,
  MEMORY_SUMMARIZER,
} from './memory-summarizer';
import { MemoryStoreFacade } from './memory-store-facade';
import { PrismaContextPackStore } from './prisma-context-pack.store';
import { PrismaPersistentMemoryStore } from './prisma-persistent-memory.store';
import {
  ContextPackStore,
  MemoryStore,
  PersistentMemoryStore,
  RuntimeMemoryStore,
} from './memory.store';

@Module({
  providers: [
    ContextBudgetManagerService,
    ContextPackReadService,
    {
      provide: RuntimeMemoryStore,
      useClass: InMemoryRuntimeMemoryStore,
    },
    {
      provide: PersistentMemoryStore,
      useClass: PrismaPersistentMemoryStore,
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
    ContextPackStore,
    ContextPackReadService,
    ContextBudgetManagerService,
  ],
})
export class MemoryModule {}
