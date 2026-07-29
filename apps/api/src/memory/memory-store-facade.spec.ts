import { InMemoryRuntimeMemoryStore } from './in-memory-runtime-memory.store';
import { MemoryStoreFacade } from './memory-store-facade';
import { PersistentMemoryStore } from './memory.store';
import type {
  MemoryEntry,
  MemoryHydrationOptions,
  MemoryHydrationResult,
  MemoryLayer,
  MemoryPatchInput,
  MemoryQuery,
  MemoryWriteInput,
} from './memory.types';

class TestPersistentMemoryStore extends PersistentMemoryStore {
  private readonly delegate = new InMemoryRuntimeMemoryStore();

  get(memoryId: string): Promise<MemoryEntry | null> {
    return this.delegate.get(memoryId);
  }

  list(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.delegate.list(query);
  }

  save(memory: MemoryEntry): Promise<MemoryEntry> {
    return this.delegate.set(memory);
  }

  saveMany(memories: MemoryEntry[]): Promise<MemoryEntry[]> {
    return Promise.all(memories.map((memory) => this.delegate.set(memory)));
  }

  patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null> {
    return this.delegate.patch(memoryId, patch);
  }

  delete(memoryId: string): Promise<boolean> {
    return this.delegate.delete(memoryId);
  }

  deleteMany(query: {
    conversationId?: string;
    memoryIds?: string[];
    layer?: MemoryLayer;
    mergeGroup?: string;
    includePinned?: boolean;
  }): Promise<string[]> {
    return this.delegate.deleteMany(query);
  }

  async hydrateConversation(
    conversationId: string,
    options?: MemoryHydrationOptions,
  ): Promise<MemoryHydrationResult> {
    const hydratedAt = options?.hydratedAt ?? new Date();
    const allMemories = await this.delegate.list({
      conversationId,
      layers: options?.layers,
      includeExpired: true,
    });
    const expiredMemoryIds = allMemories
      .filter(
        (memory) =>
          memory.expiresAt !== null &&
          memory.expiresAt.getTime() <= hydratedAt.getTime(),
      )
      .map((memory) => memory.memoryId);

    if (expiredMemoryIds.length > 0) {
      await this.delegate.deleteMany({
        memoryIds: expiredMemoryIds,
        includePinned: true,
      });
    }

    const memories = await this.delegate.list({
      conversationId,
      layers: options?.layers,
      limit: options?.limit,
    });

    return {
      conversationId,
      memories,
      expiredMemoryIds,
      hydratedAt,
    };
  }
}

describe('MemoryStoreFacade', () => {
  function createWriteInput(
    overrides: Partial<MemoryWriteInput> = {},
  ): MemoryWriteInput {
    return {
      conversationId: 'conversation-1',
      runId: 'run-1',
      layer: 'resume' satisfies MemoryLayer,
      scope: 'conversation',
      content: 'base-content',
      ...overrides,
    };
  }

  function createMemoryEntry(
    memoryId: string,
    overrides: Partial<MemoryEntry> = {},
  ): MemoryEntry {
    const baseTime = new Date('2026-07-28T09:00:00.000Z');

    return {
      memoryId,
      conversationId: 'conversation-1',
      runId: 'run-1',
      layer: 'resume' satisfies MemoryLayer,
      scope: 'conversation',
      content: `content-${memoryId}`,
      summary: `summary-${memoryId}`,
      tokenEstimate: 100,
      priority: 1,
      pinned: false,
      freshnessScore: 0.1,
      relevanceScore: 0.2,
      sourceRefs: [],
      mergeGroup: null,
      mergeStrategy: null,
      version: 1,
      metadata: null,
      expiresAt: null,
      createdAt: baseTime,
      updatedAt: baseTime,
      lastAccessedAt: null,
      accessCount: 0,
      ...overrides,
    };
  }

  function createFacade() {
    const runtime = new InMemoryRuntimeMemoryStore();
    const persistent = new TestPersistentMemoryStore();
    return {
      runtime,
      persistent,
      facade: new MemoryStoreFacade(runtime, persistent),
    };
  }

  it('creates a new entry and persists it to both layers', async () => {
    const { facade, runtime, persistent } = createFacade();

    const result = await facade.write(createWriteInput());

    expect(result.merged).toBe(false);
    expect(result.memory.memoryId).toMatch(/^c/);
    expect(result.memory.version).toBe(1);
    expect(await runtime.get(result.memory.memoryId)).not.toBeNull();
    expect(await persistent.get(result.memory.memoryId)).not.toBeNull();
  });

  it('uses the latest persistent entry in the same merge group for append', async () => {
    const { facade, persistent } = createFacade();

    await persistent.save(
      createMemoryEntry('old-1', {
        mergeGroup: 'group-a',
        mergeStrategy: 'append',
        updatedAt: new Date('2026-07-28T08:00:00.000Z'),
        content: 'older',
      }),
    );
    await persistent.save(
      createMemoryEntry('old-2', {
        mergeGroup: 'group-a',
        mergeStrategy: 'append',
        updatedAt: new Date('2026-07-28T10:00:00.000Z'),
        content: 'latest',
      }),
    );

    const result = await facade.write(
      createWriteInput({
        mergeGroup: 'group-a',
        mergeStrategy: 'append',
        content: 'next',
        tokenEstimate: 20,
      }),
    );

    expect(result.merged).toBe(true);
    expect(result.memory.memoryId).toBe('old-2');
    expect(result.memory.content).toBe('latest\nnext');
    expect(result.memory.version).toBe(2);
    expect(result.memory.tokenEstimate).toBe(120);
  });

  it('replaces the previous entry for replace strategy across both layers', async () => {
    const { facade, runtime, persistent } = createFacade();

    await persistent.save(
      createMemoryEntry('replace-me', {
        mergeGroup: 'group-a',
        mergeStrategy: 'replace',
      }),
    );
    await runtime.set(
      createMemoryEntry('replace-me', {
        mergeGroup: 'group-a',
        mergeStrategy: 'replace',
      }),
    );

    const result = await facade.write(
      createWriteInput({
        mergeGroup: 'group-a',
        mergeStrategy: 'replace',
        content: 'replacement',
      }),
    );

    expect(result.merged).toBe(true);
    expect(result.replacedMemoryId).toBe('replace-me');
    expect(result.memory.memoryId).not.toBe('replace-me');
    expect(await runtime.get('replace-me')).toBeNull();
    expect(await persistent.get('replace-me')).toBeNull();
  });

  it('falls back to persistent storage on get and warms runtime cache', async () => {
    const { facade, runtime, persistent } = createFacade();
    await persistent.save(createMemoryEntry('persistent-only'));

    const memory = await facade.get('persistent-only');

    expect(memory?.memoryId).toBe('persistent-only');
    expect(await runtime.get('persistent-only')).not.toBeNull();
  });

  it('hydrates active memories and removes expired ones', async () => {
    const { facade, runtime, persistent } = createFacade();
    const now = new Date('2026-07-29T08:00:00.000Z');

    await persistent.saveMany([
      createMemoryEntry('active-1', {
        layer: 'resume',
        updatedAt: new Date('2026-07-29T07:00:00.000Z'),
      }),
      createMemoryEntry('expired-1', {
        layer: 'resume',
        expiresAt: new Date('2026-07-29T06:00:00.000Z'),
      }),
      createMemoryEntry('other-layer', {
        layer: 'session',
      }),
    ]);

    const result = await facade.hydrateConversation('conversation-1', {
      layers: ['resume'],
      hydratedAt: now,
    });

    expect(result.memories.map((memory) => memory.memoryId)).toEqual([
      'active-1',
    ]);
    expect(result.expiredMemoryIds).toEqual(['expired-1']);
    expect(await runtime.get('active-1')).not.toBeNull();
    expect(await persistent.get('expired-1')).toBeNull();
  });

  it('patches and bulk-deletes through both layers', async () => {
    const { facade, runtime, persistent } = createFacade();
    const memory = createMemoryEntry('delegated');
    await persistent.save(memory);
    await runtime.set(memory);

    const patched = await facade.patch('delegated', { priority: 9 });
    expect(patched?.priority).toBe(9);

    expect(await facade.deleteMany({ memoryIds: ['delegated'] })).toEqual([
      'delegated',
    ]);
    expect(await runtime.get('delegated')).toBeNull();
    expect(await persistent.get('delegated')).toBeNull();
  });
});
