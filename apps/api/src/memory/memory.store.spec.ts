import { InMemoryRuntimeMemoryStore } from './in-memory-runtime-memory.store';
import type { MemoryEntry, MemoryLayer } from './memory.types';

describe('InMemoryRuntimeMemoryStore', () => {
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
      tokenEstimate: 120,
      priority: 10,
      pinned: false,
      freshnessScore: 0.8,
      relevanceScore: 0.9,
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

  it('touches entries on get and keeps the stored value isolated from callers', async () => {
    const store = new InMemoryRuntimeMemoryStore();
    await store.set(createMemoryEntry('memory-1'));

    const first = await store.get('memory-1');
    expect(first).not.toBeNull();
    expect(first?.accessCount).toBe(1);
    expect(first?.lastAccessedAt).toBeInstanceOf(Date);

    if (!first) {
      return;
    }

    first.content = 'mutated-outside';
    const second = await store.get('memory-1');
    expect(second?.content).toBe('content-memory-1');
    expect(second?.accessCount).toBe(2);
  });

  it('filters expired entries from reads and evicts them lazily', async () => {
    const now = Date.now();
    const store = new InMemoryRuntimeMemoryStore();
    await store.set(
      createMemoryEntry('expired', {
        expiresAt: new Date(now - 1_000),
      }),
    );
    await store.set(
      createMemoryEntry('active', {
        expiresAt: new Date(now + 60_000),
      }),
    );

    expect(await store.get('expired')).toBeNull();
    expect(await store.size()).toBe(1);

    const listed = await store.list({});
    expect(listed.map((entry) => entry.memoryId)).toEqual(['active']);
  });

  it('evicts the least recently used low-priority access candidate when capacity is exceeded', async () => {
    const store = new InMemoryRuntimeMemoryStore({ maxEntries: 2 });
    await store.set(createMemoryEntry('memory-1'));
    await store.set(createMemoryEntry('memory-2'));
    await store.get('memory-1');
    await store.set(createMemoryEntry('memory-3'));

    const listed = await store.list({});
    expect(listed.map((entry) => entry.memoryId).sort()).toEqual([
      'memory-1',
      'memory-3',
    ]);
    expect(await store.get('memory-2')).toBeNull();
  });

  it('prefers keeping pinned entries during deleteMany unless explicitly included', async () => {
    const store = new InMemoryRuntimeMemoryStore();
    await store.set(createMemoryEntry('pinned', { pinned: true }));
    await store.set(createMemoryEntry('normal'));

    const deleted = await store.deleteMany({
      conversationId: 'conversation-1',
    });
    expect(deleted).toEqual(['normal']);
    expect(await store.get('pinned')).not.toBeNull();

    const deletedPinned = await store.deleteMany({
      conversationId: 'conversation-1',
      includePinned: true,
    });
    expect(deletedPinned).toEqual(['pinned']);
  });

  it('supports ordering and cursor pagination in list queries', async () => {
    const store = new InMemoryRuntimeMemoryStore();
    await store.set(createMemoryEntry('memory-1', { priority: 10 }));
    await store.set(createMemoryEntry('memory-2', { priority: 20 }));
    await store.set(createMemoryEntry('memory-3', { priority: 30 }));

    const firstPage = await store.list({
      orderBy: {
        field: 'priority',
        direction: 'desc',
      },
      limit: 2,
    });
    expect(firstPage.map((entry) => entry.memoryId)).toEqual([
      'memory-3',
      'memory-2',
    ]);

    const secondPage = await store.list({
      orderBy: {
        field: 'priority',
        direction: 'desc',
      },
      cursor: 'memory-2',
      limit: 2,
    });
    expect(secondPage.map((entry) => entry.memoryId)).toEqual(['memory-1']);
  });
});
