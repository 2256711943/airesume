/* eslint-disable @typescript-eslint/require-await */

import { RuntimeMemoryStore } from './memory.store';
import type {
  MemoryDeleteQuery,
  MemoryEntry,
  MemoryOrderField,
  MemoryPatchInput,
  MemoryQuery,
  MemorySourceRef,
} from './memory.types';

/**
 * Configuration for the default in-process runtime store.
 */
export interface InMemoryRuntimeMemoryStoreOptions {
  maxEntries?: number;
  defaultEntryTtlMs?: number;
}

/**
 * L1 cache implementation backed by a single Map.
 * Access order is maintained by deleting and re-inserting touched entries so
 * native Map iteration order can act as the LRU queue.
 */
export class InMemoryRuntimeMemoryStore extends RuntimeMemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  private readonly maxEntries: number;

  private readonly defaultEntryTtlMs: number | null;

  /** 使用可选的容量/TTL 配置初始化一个空的运行时存储。 */
  constructor(options: InMemoryRuntimeMemoryStoreOptions = {}) {
    super();
    this.maxEntries = this.normalizeMaxEntries(options.maxEntries);
    this.defaultEntryTtlMs = this.normalizeDefaultTtl(
      options.defaultEntryTtlMs,
    );
  }

  /** 按 ID 获取单条 memory，命中后刷新访问统计；若已过期则删除并返回 null。 */
  async get(memoryId: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(memoryId);
    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      this.entries.delete(memoryId);
      return null;
    }

    const touched = this.touchEntry(entry);
    this.persistEntry(touched);
    return this.cloneMemoryEntry(touched);
  }

  /** 按查询条件过滤、排序、分页后返回 memory 列表，自动排除过期条目。 */
  async list(query: MemoryQuery): Promise<MemoryEntry[]> {
    this.removeExpiredEntries();

    const filtered = Array.from(this.entries.values()).filter((entry) =>
      this.matchesQuery(entry, query),
    );
    const ordered = this.sortEntries(filtered, query.orderBy);
    const paged = this.applyCursorAndLimit(ordered, query);

    return paged.map((entry) => this.cloneMemoryEntry(entry));
  }

  /** 写入（覆盖）一条 memory，触发过期淘汰和 LRU 溢出淘汰。 */
  async set(memory: MemoryEntry): Promise<MemoryEntry> {
    const normalized = this.normalizeEntry(memory);
    this.persistEntry(normalized);
    this.evictOverflow();
    return this.cloneMemoryEntry(normalized);
  }

  /** 部分更新已存在的 memory 条目，未传入的字段保持不变。 */
  async patch(
    memoryId: string,
    patch: MemoryPatchInput,
  ): Promise<MemoryEntry | null> {
    const existing = this.entries.get(memoryId);
    if (!existing) {
      return null;
    }

    if (this.isExpired(existing)) {
      this.entries.delete(memoryId);
      return null;
    }

    const now = new Date();
    const patched: MemoryEntry = this.normalizeEntry({
      ...existing,
      content: patch.content ?? existing.content,
      summary: patch.summary !== undefined ? patch.summary : existing.summary,
      tokenEstimate:
        patch.tokenEstimate !== undefined
          ? patch.tokenEstimate
          : existing.tokenEstimate,
      priority:
        patch.priority !== undefined ? patch.priority : existing.priority,
      pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
      freshnessScore:
        patch.freshnessScore !== undefined
          ? patch.freshnessScore
          : existing.freshnessScore,
      relevanceScore:
        patch.relevanceScore !== undefined
          ? patch.relevanceScore
          : existing.relevanceScore,
      sourceRefs:
        patch.sourceRefs !== undefined
          ? this.cloneSourceRefs(patch.sourceRefs)
          : this.cloneSourceRefs(existing.sourceRefs),
      metadata:
        patch.metadata !== undefined
          ? this.cloneMetadata(patch.metadata)
          : this.cloneMetadata(existing.metadata),
      expiresAt:
        patch.expiresAt !== undefined
          ? this.cloneDate(patch.expiresAt)
          : this.cloneDate(existing.expiresAt),
      updatedAt: now,
    });

    this.persistEntry(this.touchEntry(patched, now));
    this.evictOverflow();

    const next = this.entries.get(memoryId);
    return next ? this.cloneMemoryEntry(next) : null;
  }

  /** 删除单条 memory，返回是否实际删除。 */
  async delete(memoryId: string): Promise<boolean> {
    return this.entries.delete(memoryId);
  }

  async deleteMany(query: MemoryDeleteQuery): Promise<string[]> {
    const deletedIds: string[] = [];

    for (const entry of Array.from(this.entries.values())) {
      if (!this.matchesDeleteQuery(entry, query)) {
        continue;
      }

      this.entries.delete(entry.memoryId);
      deletedIds.push(entry.memoryId);
    }

    return deletedIds;
  }

  /** 刷新指定 memory 的访问时间与计数，已过期则删除。 */
  async touch(memoryId: string, accessedAt?: Date): Promise<void> {
    const existing = this.entries.get(memoryId);
    if (!existing) {
      return;
    }

    if (this.isExpired(existing, accessedAt)) {
      this.entries.delete(memoryId);
      return;
    }

    this.persistEntry(this.touchEntry(existing, accessedAt));
  }

  /** 立即清除所有已过期的条目，返回被清除的 ID 列表。 */
  async evictExpired(now?: Date): Promise<string[]> {
    return this.removeExpiredEntries(now);
  }

  /** 清空指定会话的全部 memory（包括 pinned），返回被删除的 ID 列表。 */
  async clearConversation(conversationId: string): Promise<string[]> {
    const deletedIds: string[] = [];

    for (const entry of Array.from(this.entries.values())) {
      if (entry.conversationId !== conversationId) {
        continue;
      }

      this.entries.delete(entry.memoryId);
      deletedIds.push(entry.memoryId);
    }

    return deletedIds;
  }

  /** 返回当前有效（未过期）条目数。 */
  async size(): Promise<number> {
    this.removeExpiredEntries();
    return this.entries.size;
  }

  /** 规范化最大条目数：非法值或非正数时使用默认值 200。 */
  private normalizeMaxEntries(value?: number): number {
    if (!Number.isFinite(value) || (value ?? 0) <= 0) {
      return 200;
    }

    return Math.floor(value as number);
  }

  /** 规范化默认 TTL：非法值或非正数时返回 null（永不过期）。 */
  private normalizeDefaultTtl(value?: number): number | null {
    if (!Number.isFinite(value) || (value ?? 0) <= 0) {
      return null;
    }

    return Math.floor(value as number);
  }

  /** 深拷贝并规范化一条 memory，确保所有日期/嵌套字段的引用安全。 */
  private normalizeEntry(memory: MemoryEntry): MemoryEntry {
    const createdAt = this.cloneDate(memory.createdAt) ?? new Date();
    const updatedAt = this.cloneDate(memory.updatedAt) ?? createdAt;
    const expiresAt = this.resolveExpiresAt(memory, updatedAt);
    const lastAccessedAt = this.cloneDate(memory.lastAccessedAt) ?? null;

    return {
      ...memory,
      sourceRefs: this.cloneSourceRefs(memory.sourceRefs),
      metadata: this.cloneMetadata(memory.metadata),
      createdAt,
      updatedAt,
      expiresAt,
      lastAccessedAt,
      accessCount: this.normalizeAccessCount(memory.accessCount),
    };
  }

  /** 解析过期时间：优先用显式的 expiresAt，否则通过默认 TTL 推算。 */
  private resolveExpiresAt(
    memory: MemoryEntry,
    fallbackBase: Date,
  ): Date | null {
    const explicit = this.cloneDate(memory.expiresAt);
    if (explicit) {
      return explicit;
    }

    if (this.defaultEntryTtlMs === null) {
      return null;
    }

    return new Date(fallbackBase.getTime() + this.defaultEntryTtlMs);
  }

  private normalizeAccessCount(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
      return 0;
    }

    return Math.floor(value);
  }

  /** 判断一条 memory 是否匹配查询条件（多字段 AND 逻辑）。 */
  private matchesQuery(entry: MemoryEntry, query: MemoryQuery): boolean {
    if (!query.includeExpired && this.isExpired(entry)) {
      return false;
    }

    if (query.conversationId && entry.conversationId !== query.conversationId) {
      return false;
    }

    if (query.runId && entry.runId !== query.runId) {
      return false;
    }

    if (query.memoryIds && !query.memoryIds.includes(entry.memoryId)) {
      return false;
    }

    if (query.layer && entry.layer !== query.layer) {
      return false;
    }

    if (query.layers && !query.layers.includes(entry.layer)) {
      return false;
    }

    if (query.scope && entry.scope !== query.scope) {
      return false;
    }

    if (query.scopes && !query.scopes.includes(entry.scope)) {
      return false;
    }

    if (query.mergeGroup && entry.mergeGroup !== query.mergeGroup) {
      return false;
    }

    if (query.pinned !== undefined && entry.pinned !== query.pinned) {
      return false;
    }

    return true;
  }

  private matchesDeleteQuery(
    entry: MemoryEntry,
    query: MemoryDeleteQuery,
  ): boolean {
    if (!query.includePinned && entry.pinned) {
      return false;
    }

    if (query.conversationId && entry.conversationId !== query.conversationId) {
      return false;
    }

    if (query.memoryIds && !query.memoryIds.includes(entry.memoryId)) {
      return false;
    }

    if (query.layer && entry.layer !== query.layer) {
      return false;
    }

    if (query.mergeGroup && entry.mergeGroup !== query.mergeGroup) {
      return false;
    }

    return true;
  }

  /** 按指定字段和方向对 memory 列表排序，同值时以 memoryId 做稳定排序。 */
  private sortEntries(
    entries: MemoryEntry[],
    orderBy?: {
      field: MemoryOrderField;
      direction: 'asc' | 'desc';
    },
  ): MemoryEntry[] {
    if (!orderBy) {
      return entries;
    }

    const direction = orderBy.direction === 'asc' ? 1 : -1;
    return [...entries].sort((left, right) => {
      const comparison = this.compareByField(left, right, orderBy.field);

      if (comparison !== 0) {
        return comparison * direction;
      }

      return left.memoryId.localeCompare(right.memoryId) * direction;
    });
  }

  /** 比较两条 memory 在指定字段上的值。 */
  private compareByField(
    left: MemoryEntry,
    right: MemoryEntry,
    field: MemoryOrderField,
  ): number {
    switch (field) {
      case 'priority':
      case 'freshnessScore':
      case 'relevanceScore':
      case 'lastAccessedAt':
      case 'createdAt':
      case 'updatedAt':
      case 'expiresAt':
        return this.compareFieldValues(left[field], right[field]);
      default:
        return 0;
    }
  }

  private compareFieldValues(
    left: number | Date | null,
    right: number | Date | null,
  ): number {
    const leftValue = this.toComparableValue(left);
    const rightValue = this.toComparableValue(right);

    if (leftValue < rightValue) {
      return -1;
    }

    if (leftValue > rightValue) {
      return 1;
    }

    return 0;
  }

  /** 将 value 统一转为可比较的数值，null 视为负无穷。 */
  private toComparableValue(value: number | Date | null): number {
    if (value === null) {
      return Number.NEGATIVE_INFINITY;
    }

    if (value instanceof Date) {
      return value.getTime();
    }

    return value;
  }

  /** 按游标和 limit 对已排序列表做分页切片。 */
  private applyCursorAndLimit(
    entries: MemoryEntry[],
    query: MemoryQuery,
  ): MemoryEntry[] {
    let startIndex = 0;
    if (query.cursor) {
      const cursorIndex = entries.findIndex(
        (entry) => entry.memoryId === query.cursor,
      );
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1;
      }
    }

    const sliced = entries.slice(startIndex);
    if (!query.limit || query.limit <= 0) {
      return sliced;
    }

    return sliced.slice(0, query.limit);
  }

  /** 内部写入 Map（先 delete 再 set 以刷新 Map 迭代顺序）。 */
  private persistEntry(entry: MemoryEntry): void {
    this.entries.delete(entry.memoryId);
    this.entries.set(entry.memoryId, entry);
  }

  /** 遍历并删除所有已过期的条目，返回被删除的 ID 列表。 */
  private removeExpiredEntries(now = new Date()): string[] {
    const deletedIds: string[] = [];

    for (const entry of Array.from(this.entries.values())) {
      if (!this.isExpired(entry, now)) {
        continue;
      }

      this.entries.delete(entry.memoryId);
      deletedIds.push(entry.memoryId);
    }

    return deletedIds;
  }

  /** 当条目超出上限时，按 LRU 策略淘汰 unpinned 条目。 */
  private evictOverflow(): void {
    this.removeExpiredEntries();

    while (this.entries.size > this.maxEntries) {
      const candidate = this.selectEvictionCandidate();
      if (!candidate) {
        break;
      }

      this.entries.delete(candidate.memoryId);
    }
  }

  /** 在 unpinned 条目中选择淘汰候选：先按访问计数升序，再按最近访问时间升序。 */
  private selectEvictionCandidate(): MemoryEntry | null {
    const entries = Array.from(this.entries.values());
    if (entries.length === 0) {
      return null;
    }

    const unpinned = entries.filter((entry) => !entry.pinned);
    const candidates = unpinned.length > 0 ? unpinned : entries;

    return candidates.reduce(
      (best, current) => {
        if (!best) {
          return current;
        }

        if (current.accessCount !== best.accessCount) {
          return current.accessCount < best.accessCount ? current : best;
        }

        const currentLastSeen = this.getLruTimestamp(current);
        const bestLastSeen = this.getLruTimestamp(best);
        if (currentLastSeen !== bestLastSeen) {
          return currentLastSeen < bestLastSeen ? current : best;
        }

        return current.updatedAt.getTime() < best.updatedAt.getTime()
          ? current
          : best;
      },
      null as MemoryEntry | null,
    );
  }

  /** 获取用于 LRU 比较的时间戳（lastAccessedAt → updatedAt → createdAt 降级）。 */
  private getLruTimestamp(entry: MemoryEntry): number {
    return (
      entry.lastAccessedAt?.getTime() ??
      entry.updatedAt.getTime() ??
      entry.createdAt.getTime()
    );
  }

  /** 刷新单条 memory 的最后访问时间和自增计数。 */
  private touchEntry(entry: MemoryEntry, accessedAt = new Date()): MemoryEntry {
    return {
      ...entry,
      sourceRefs: this.cloneSourceRefs(entry.sourceRefs),
      metadata: this.cloneMetadata(entry.metadata),
      lastAccessedAt: this.cloneDate(accessedAt),
      accessCount: this.normalizeAccessCount(entry.accessCount) + 1,
    };
  }

  /** 判断一条 memory 是否已过期（expiresAt 不为 null 且小于等于当前时间）。 */
  private isExpired(entry: MemoryEntry, now = new Date()): boolean {
    return (
      entry.expiresAt !== null && entry.expiresAt.getTime() <= now.getTime()
    );
  }

  /** 深拷贝整个 MemoryEntry 对象，确保所有嵌套字段独立引用。 */
  private cloneMemoryEntry(entry: MemoryEntry): MemoryEntry {
    return {
      ...entry,
      sourceRefs: this.cloneSourceRefs(entry.sourceRefs),
      metadata: this.cloneMetadata(entry.metadata),
      createdAt: this.cloneDate(entry.createdAt) ?? new Date(entry.createdAt),
      updatedAt: this.cloneDate(entry.updatedAt) ?? new Date(entry.updatedAt),
      expiresAt: this.cloneDate(entry.expiresAt),
      lastAccessedAt: this.cloneDate(entry.lastAccessedAt),
    };
  }

  private cloneSourceRefs(
    sourceRefs: MemoryEntry['sourceRefs'],
  ): MemorySourceRef[] {
    return sourceRefs.map((sourceRef) => ({
      ...sourceRef,
      metadata: sourceRef.metadata
        ? { ...sourceRef.metadata }
        : undefined,
    }));
  }

  /** 深拷贝 metadata 对象，null/undefined 时返回 null。 */
  private cloneMetadata(
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (!metadata) {
      return null;
    }

    return { ...metadata };
  }

  /** 深拷贝 Date 对象，null/undefined 时返回 null。 */
  private cloneDate(value: Date | null | undefined): Date | null {
    if (!value) {
      return null;
    }

    return new Date(value);
  }
}
