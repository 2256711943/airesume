import { Module } from '@nestjs/common';
import { InMemoryRuntimeMemoryStore } from './in-memory-runtime-memory.store';
import {
  DefaultMemorySummarizer,
  MEMORY_SUMMARIZER,
} from './memory-summarizer';
import { MemoryStoreFacade } from './memory-store-facade';
import { PrismaPersistentMemoryStore } from './prisma-persistent-memory.store';
import {
  MemoryStore,
  PersistentMemoryStore,
  RuntimeMemoryStore,
} from './memory.store';

@Module({
  providers: [
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
  ],
  exports: [MemoryStore],
})
export class MemoryModule {}
