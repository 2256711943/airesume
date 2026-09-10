import { Injectable } from '@nestjs/common';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import {
  isDisplayPreferenceCategory,
  isDisplayPreferenceKey,
  isDisplayPreferenceSourceKind,
  isDisplayPreferenceValue,
  type DisplayPreferenceCategory,
  type DisplayPreferenceKey,
  type DisplayPreferenceSourceKind,
  type DisplayPreferenceValue,
} from '../memory/display-preference.types';
import { MemoryStore } from '../memory/memory.store';
import { PrismaService } from '../prisma/prisma.service';

const CONVERSATION_HISTORY_SUMMARY_SLOT_KEY = 'conversation_history_summary';
const RESUME_SNAPSHOT_MEMORY_GROUP = 'resume_snapshot';
const DEFAULT_HISTORY_MESSAGE_LIMIT = 12;
const DEFAULT_DISPLAY_PREFERENCE_LIMIT = 20;

/**
 * History Summary 是 Recent Context 的“压缩缓存”，不是事实源，也不是长期记忆。
 *
 * - 它总是从原始 conversationMessage 重新计算得到（recompute-from-source），可随时删除并重建；
 * - 它不是 Session Decision / Profile / Preference 的事实源，也不能反向覆盖结构化 Memory；
 * - 它只描述“已经完成的历史”（Summary(N) 在第 N 轮 Agent 完成后才更新），
 *   本轮 LLM 请求读取的是上一状态的历史摘要，当前用户消息只作为当前 input 进入模型；
 * - 更新失败可丢弃、更新必须单调（新版本 Summary 不能被旧版本覆盖）。
 *
 * 一句话：History Summary is a rebuildable cache of recent conversation context,
 * not the source of truth.
 */

/**
 * Resume context summary: a compact representation of the active resume items for a conversation.
 */
export interface ResumeContextSummary {
  id: string;
  title: string;
  summary: string;
  sourceMode: string;
  keySkills: string[];
  keyProjects: Array<{
    name: string;
    highlights: string[];
  }>;
  keyExperiences: Array<{
    company: string;
    role: string;
    highlights: string[];
  }>;
}

export interface ConversationHistorySummary {
  summary: string;
  messageCount: number;
  lastMessageAt: string | null;
  /**
   * 该摘要覆盖的最后一条消息 id（sourceMessageId）：用于判断这段缓存对应哪一段
   * conversationMessage，同时作为并发下“新摘要不被旧摘要覆盖”的单调标记。
   */
  lastMessageId?: string | null;
  /** 该摘要缓存槽的代数，随每次真正的新覆盖递增。 */
  summaryVersion?: number;
}

export interface DisplayPreferenceContextItem {
  category: DisplayPreferenceCategory;
  key: DisplayPreferenceKey;
  normalizedValue: DisplayPreferenceValue<DisplayPreferenceKey>;
  sourceKind: DisplayPreferenceSourceKind;
  summary: string | null;
  updatedAt: string;
}

/**
 * Conversation context used by chat and agents.
 */
export interface ResumeConversationContext {
  activeResumeIds: string[];
  activeResumeSummaries: ResumeContextSummary[];
  selectedCount: number;
  conversationHistorySummary: ConversationHistorySummary | null;
  displayPreferences?: DisplayPreferenceContextItem[];
}

interface ResumeSnapshotMemoryMetadata {
  selectedResumeIds: string[];
  resumeSummaries: ResumeContextSummary[];
}

@Injectable()
export class ResumeContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memoryStore: MemoryStore,
  ) {}

  /**
   * Persist the conversation's active resume selection into the memory store.
   */
  async setActiveResumeContext(
    userId: string,
    conversationId: string,
    selectedResumeIds: string[],
  ): Promise<void> {
    const resumeSummaries = await this.loadResumeSummaries(
      userId,
      selectedResumeIds,
    );

    if (selectedResumeIds.length === 0 && resumeSummaries.length === 0) {
      await this.memoryStore.deleteMany({
        conversationId,
        layer: 'resume',
        mergeGroup: RESUME_SNAPSHOT_MEMORY_GROUP,
        includePinned: true,
      });
      return;
    }

    await this.writeResumeSnapshot(
      conversationId,
      resumeSummaries,
      selectedResumeIds,
    );
  }

  /**
   * Load active resume context and the latest conversation history summary.
   */
  async buildConversationContext(
    userId: string,
    conversationId: string,
  ): Promise<ResumeConversationContext> {
    const [
      cachedResumeMemories,
      cachedHistoryMemories,
      cachedPreferenceMemories,
    ] = await Promise.all([
      this.memoryStore.list({
        conversationId,
        layer: 'resume',
        mergeGroup: RESUME_SNAPSHOT_MEMORY_GROUP,
        orderBy: {
          field: 'updatedAt',
          direction: 'desc',
        },
        limit: 1,
      }),
      this.memoryStore.list({
        conversationId,
        layer: 'session',
        mergeGroup: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
        orderBy: {
          field: 'updatedAt',
          direction: 'desc',
        },
        limit: 1,
      }),
      this.memoryStore.list({
        conversationId,
        layer: 'preference',
        orderBy: {
          field: 'updatedAt',
          direction: 'desc',
        },
        limit: DEFAULT_DISPLAY_PREFERENCE_LIMIT,
      }),
    ]);

    const cachedResumeSnapshot =
      this.readResumeSnapshotFromMemoryEntries(cachedResumeMemories);
    const activeResumeIds = cachedResumeSnapshot?.selectedResumeIds ?? [];
    const activeResumeSummaries = cachedResumeSnapshot?.resumeSummaries ?? [];
    const displayPreferences = this.readDisplayPreferencesFromMemoryEntries(
      cachedPreferenceMemories,
    );

    let conversationHistorySummary =
      this.readConversationHistorySummaryFromMemoryEntries(
        cachedHistoryMemories,
      );

    if (!conversationHistorySummary) {
      // 缓存槽缺失（首轮、被清理或丢失）时才重建：只基于“已经完成的历史”，
      // 保证正在进行的当前用户消息不会被折进本轮即将读取的 Summary，避免重复上下文。
      conversationHistorySummary = await this.summarizeCompletedHistory(
        userId,
        conversationId,
      );
    }

    return {
      activeResumeIds,
      activeResumeSummaries,
      selectedCount: activeResumeSummaries.length,
      conversationHistorySummary,
      displayPreferences,
    };
  }

  /**
   * Refresh the conversation history summary slot from the latest conversation messages.
   *
   * 这是纯缓存重建：读取原始 conversationMessage → 重新计算 → replace 固定 slot。
   * 绝不基于旧 Summary 递归压缩。失败应被调用方容忍（缓存可丢弃）。
   */
  async refreshConversationHistorySummary(
    userId: string,
    conversationId: string,
    messageLimit = DEFAULT_HISTORY_MESSAGE_LIMIT,
  ): Promise<void> {
    // 按会话串行化刷新：保证并发刷新按触发顺序执行，避免 Summary(N+2)
    // 被较晚完成/较旧的 Summary(N) 覆盖（单调性）。
    const previous =
      this.refreshQueues.get(conversationId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() =>
        this.refreshConversationHistorySummaryNow(
          userId,
          conversationId,
          messageLimit,
        ),
      );
    this.refreshQueues.set(conversationId, run);

    try {
      await run;
    } finally {
      if (this.refreshQueues.get(conversationId) === run) {
        this.refreshQueues.delete(conversationId);
      }
    }
  }

  /** 读取原始消息并写入最新历史摘要；同一会话内由串行队列保证不会并发交错。 */
  private async refreshConversationHistorySummaryNow(
    userId: string,
    conversationId: string,
    messageLimit: number,
  ): Promise<void> {
    const orderedMessages = await this.loadRecentMessages(
      userId,
      conversationId,
      messageLimit,
    );
    const historySummary =
      this.generateConversationHistorySummary(orderedMessages);
    if (!historySummary) {
      await this.memoryStore.deleteMany({
        conversationId,
        layer: 'session',
        mergeGroup: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
        includePinned: true,
      });
      return;
    }

    // 写前单调检查（额外防线）：若当前槽位已覆盖到相同或更新的历史位置，
    // 说明这是一次过期刷新，丢弃本次写入。
    const [existingSlot] = await this.memoryStore.list({
      conversationId,
      layer: 'session',
      mergeGroup: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: 1,
    });
    const currentSummary = this.readConversationHistorySummaryFromMemoryEntries(
      existingSlot ? [existingSlot] : [],
    );
    if (
      currentSummary &&
      this.isCoveredByCurrentSlot(currentSummary, historySummary)
    ) {
      return;
    }

    const lastMessage = orderedMessages[orderedMessages.length - 1] ?? null;
    const summaryVersion = (currentSummary?.summaryVersion ?? 0) + 1;

    await this.memoryStore.write({
      conversationId,
      layer: 'session',
      scope: 'conversation',
      content: historySummary.summary,
      summary: historySummary.summary,
      mergeGroup: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
      mergeStrategy: 'replace',
      metadata: {
        summary: historySummary.summary,
        messageCount: orderedMessages.length,
        lastMessageAt: lastMessage?.createdAt.toISOString() ?? null,
        lastMessageId: lastMessage?.id ?? null,
        summaryVersion,
      },
    });
  }

  /**
   * 缓存缺失时从原始消息重建摘要（可丢弃、可重建缓存）。
   * 只基于“已经完成的历史”：截断到最近一条 assistant（含），
   * 不把正在进行、尚未完成的用户消息折进摘要。
   */
  private async summarizeCompletedHistory(
    userId: string,
    conversationId: string,
  ): Promise<ConversationHistorySummary | null> {
    const orderedMessages = await this.loadRecentMessages(
      userId,
      conversationId,
      DEFAULT_HISTORY_MESSAGE_LIMIT,
    );

    return this.generateConversationHistorySummary(
      this.trimToCompletedExchanges(orderedMessages),
    );
  }

  /** 读取最近 N 条原始消息（时间升序，覆盖到哪一段由消息本身决定）。 */
  private async loadRecentMessages(
    userId: string,
    conversationId: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      role: string;
      content: string;
      intent?: string | null;
      agentName?: string | null;
      createdAt: Date;
    }>
  > {
    const messages = await this.prisma.conversationMessage.findMany({
      where: {
        conversationId,
        conversation: {
          userId,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: {
        id: true,
        role: true,
        content: true,
        intent: true,
        agentName: true,
        createdAt: true,
      },
    });

    return [...messages].reverse();
  }

  /**
   * 截断到最近一条 assistant（含），去掉其后尚未完成的用户/系统消息。
   */
  private trimToCompletedExchanges<T extends { role: string }>(
    messages: T[],
  ): T[] {
    let lastCompletedIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index].role === 'assistant') {
        lastCompletedIndex = index;
      }
    }

    if (lastCompletedIndex < 0) {
      return [];
    }

    return messages.slice(0, lastCompletedIndex + 1);
  }

  /**
   * 判断 candidate 是否已被 current 槽位覆盖（current 更新或相等时返回 true），
   * 用于避免旧摘要覆盖新摘要。
   */
  private isCoveredByCurrentSlot(
    current: ConversationHistorySummary,
    candidate: ConversationHistorySummary,
  ): boolean {
    if (
      current.lastMessageId &&
      current.lastMessageId === candidate.lastMessageId
    ) {
      return true;
    }

    if (current.lastMessageAt && candidate.lastMessageAt) {
      return candidate.lastMessageAt <= current.lastMessageAt;
    }

    return false;
  }

  /** 各会话进行中的刷新队列（保证同一会话的刷新单调串行）。 */
  private readonly refreshQueues = new Map<string, Promise<void>>();

  /**
   * Persist a resume snapshot into the in-process memory cache.
   */
  private async writeResumeSnapshot(
    conversationId: string,
    resumeSummaries: ResumeContextSummary[],
    selectedResumeIds: string[],
  ): Promise<void> {
    await this.memoryStore.write({
      conversationId,
      layer: 'resume',
      scope: 'conversation',
      content: JSON.stringify({
        selectedResumeIds,
        resumeSummaries,
      }),
      summary: this.buildResumeSnapshotSummary(resumeSummaries),
      mergeGroup: RESUME_SNAPSHOT_MEMORY_GROUP,
      mergeStrategy: 'replace',
      metadata: {
        selectedResumeIds,
        resumeSummaries,
      } satisfies ResumeSnapshotMemoryMetadata,
    });
  }

  /**
   * Read a cached resume snapshot from runtime memory entries.
   */
  private readResumeSnapshotFromMemoryEntries(
    memories: Array<{
      metadata: unknown;
      content?: string;
      updatedAt: Date;
    }>,
  ): ResumeSnapshotMemoryMetadata | null {
    const latestMemory = [...memories].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    )[0];
    if (!latestMemory) {
      return null;
    }

    const metadataRecord = this.toRecord(latestMemory.metadata);
    const contentRecord = this.toRecord(
      this.tryParseJson(latestMemory.content),
    );
    const record =
      Object.keys(metadataRecord).length > 0 ? metadataRecord : contentRecord;
    const selectedResumeIds = this.extractResumeIds(
      record.selectedResumeIds ?? [],
    );
    const resumeSummaries = Array.isArray(record.resumeSummaries)
      ? (record.resumeSummaries as ResumeContextSummary[])
      : [];

    if (selectedResumeIds.length === 0 && resumeSummaries.length === 0) {
      return null;
    }

    return {
      selectedResumeIds,
      resumeSummaries,
    };
  }

  /**
   * Read the latest conversation history summary from memory entries.
   */
  private readConversationHistorySummaryFromMemoryEntries(
    memories: Array<{
      metadata: unknown;
      content: string;
      summary: string | null;
      updatedAt: Date;
    }>,
  ): ConversationHistorySummary | null {
    const latestMemory = [...memories].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    )[0];
    if (!latestMemory) {
      return null;
    }

    return (
      this.parseConversationHistorySummary(
        latestMemory.metadata,
        latestMemory.updatedAt,
      ) ??
      this.parseConversationHistorySummary(
        latestMemory.summary ?? latestMemory.content,
        latestMemory.updatedAt,
      )
    );
  }

  /**
   * 从 preference memory 中读取当前会话的显示偏好集合。
   */
  private readDisplayPreferencesFromMemoryEntries(
    memories: Array<{
      metadata: unknown;
      content: string;
      summary: string | null;
      updatedAt: Date;
    }>,
  ): DisplayPreferenceContextItem[] {
    const sortedMemories = [...memories].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
    const preferencesByKey = new Map<
      DisplayPreferenceKey,
      DisplayPreferenceContextItem
    >();

    for (const memory of sortedMemories) {
      const parsed = this.parseDisplayPreferenceMemoryEntry(memory);
      if (!parsed || preferencesByKey.has(parsed.key)) {
        continue;
      }

      preferencesByKey.set(parsed.key, parsed);
    }

    return Array.from(preferencesByKey.values());
  }

  /**
   * Build a short human-readable summary for the resume snapshot memory entry.
   */
  private buildResumeSnapshotSummary(
    resumeSummaries: ResumeContextSummary[],
  ): string {
    const titles = resumeSummaries
      .map((item) => this.toText(item.title))
      .filter(Boolean)
      .slice(0, 3);

    if (titles.length === 0) {
      return 'Resume snapshot';
    }

    return `Resume snapshot: ${titles.join(', ')}`;
  }

  /**
   * Extract resume IDs from a memory slot value.
   */
  private extractResumeIds(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return [];
      }

      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim()).filter(Boolean);
        }
      } catch {
        return trimmed
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
      }
    }

    return [];
  }

  /**
   * Load resume library items and map them into a compact summary payload.
   */
  private async loadResumeSummaries(
    userId: string,
    activeResumeIds: string[],
  ): Promise<ResumeContextSummary[]> {
    if (activeResumeIds.length === 0) {
      return [];
    }

    const items = await this.prisma.resumeLibraryItem.findMany({
      where: {
        userId,
        id: {
          in: activeResumeIds,
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
      select: {
        id: true,
        title: true,
        summary: true,
        sourceMode: true,
        skills: true,
        projects: true,
        experience: true,
      },
    });

    return items.map((item) => this.toSummary(item));
  }

  /**
   * Turn a resume item into a compact summary structure.
   */
  private toSummary(item: {
    id: string;
    title: string;
    summary: string;
    sourceMode: string;
    skills: unknown;
    projects: unknown;
    experience: unknown;
  }): ResumeContextSummary {
    const keySkills = this.toStringArray(item.skills, 10);
    const keyProjects = this.toProjectSummaries(item.projects);
    const keyExperiences = this.toExperienceSummaries(item.experience);

    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      sourceMode: item.sourceMode,
      keySkills,
      keyProjects,
      keyExperiences,
    };
  }

  /**
   * Convert a projects field into a compact list.
   */
  private toProjectSummaries(
    value: unknown,
  ): Array<{ name: string; highlights: string[] }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.slice(0, 5).map((item) => {
      const record = this.toRecord(item);
      return {
        name: this.toText(record.name) || 'Unnamed project',
        highlights: this.toStringArray(record.highlights, 5),
      };
    });
  }

  /**
   * Convert an experience field into a compact list.
   */
  private toExperienceSummaries(
    value: unknown,
  ): Array<{ company: string; role: string; highlights: string[] }> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.slice(0, 5).map((item) => {
      const record = this.toRecord(item);
      return {
        company: this.toText(record.company) || 'Unknown company',
        role: this.toText(record.role) || 'Unknown role',
        highlights: this.toStringArray(record.highlights, 5),
      };
    });
  }

  /**
   * Convert any array-like value into a bounded string array.
   */
  private toStringArray(value: unknown, limit: number): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.toText(item))
      .filter(Boolean)
      .slice(0, limit);
  }

  /**
   * Safely cast a value to a record.
   */
  private toRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return value as Record<string, unknown>;
  }

  /**
   * Convert a value into a trimmed string.
   */
  private toText(value: unknown): string {
    return LlmSanitizer.toText(value);
  }

  /**
   * 解析单条 preference memory 为结构化显示偏好。
   */
  private parseDisplayPreferenceMemoryEntry(input: {
    metadata: unknown;
    content: string;
    summary: string | null;
    updatedAt: Date;
  }): DisplayPreferenceContextItem | null {
    const metadata = this.toRecord(input.metadata);
    const category = this.toText(metadata.category);
    const key = this.toText(metadata.key);
    const normalizedValue = this.toText(metadata.normalizedValue);
    const sourceKind = this.toText(metadata.sourceKind);

    if (
      !isDisplayPreferenceCategory(category) ||
      !isDisplayPreferenceKey(key) ||
      !isDisplayPreferenceSourceKind(sourceKind) ||
      !isDisplayPreferenceValue(key, normalizedValue)
    ) {
      return null;
    }

    const summary = this.toText(input.summary ?? input.content);

    return {
      category,
      key,
      normalizedValue,
      sourceKind,
      summary: summary || null,
      updatedAt: input.updatedAt.toISOString(),
    };
  }

  /**
   * Parse a persisted conversation history summary.
   */
  private parseConversationHistorySummary(
    value: unknown,
    updatedAt?: Date,
  ): ConversationHistorySummary | null {
    if (typeof value === 'string') {
      const summary = value.trim();
      if (!summary) {
        return null;
      }

      return {
        summary,
        messageCount: 0,
        lastMessageAt: updatedAt?.toISOString() ?? null,
      };
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const summary = this.toText(record.summary);
    if (!summary) {
      return null;
    }

    const parsed: ConversationHistorySummary = {
      summary,
      messageCount: Number(record.messageCount ?? 0) || 0,
      lastMessageAt:
        this.toOptionalIsoString(record.lastMessageAt) ??
        updatedAt?.toISOString() ??
        null,
    };
    const lastMessageId = this.toOptionalString(record.lastMessageId);
    if (lastMessageId) {
      parsed.lastMessageId = lastMessageId;
    }
    const summaryVersion = Number(record.summaryVersion);
    if (Number.isFinite(summaryVersion) && summaryVersion > 0) {
      parsed.summaryVersion = summaryVersion;
    }

    return parsed;
  }

  /**
   * Generate a lightweight summary from recent messages.
   */
  private generateConversationHistorySummary(
    messages: Array<{
      id?: string;
      role: string;
      content: string;
      intent?: string | null;
      agentName?: string | null;
      createdAt: Date;
    }>,
  ): ConversationHistorySummary | null {
    if (messages.length === 0) {
      return null;
    }

    const summaryParts: string[] = [];
    const topicLabels = Array.from(
      new Set(
        messages
          .map((message) =>
            this.describeConversationTopic(message.intent, message.agentName),
          )
          .filter(Boolean),
      ),
    );
    const userFocus = messages
      .filter((message) => message.role === 'user')
      .slice(-3)
      .map((message) => this.normalizeMessageContent(message.content))
      .filter(Boolean);
    const assistantFocus = messages
      .filter((message) => message.role === 'assistant')
      .slice(-2)
      .map((message) => this.normalizeMessageContent(message.content))
      .filter(Boolean);

    if (topicLabels.length > 0) {
      summaryParts.push(`主要话题：${topicLabels.join('、')}`);
    }

    if (userFocus.length > 0) {
      summaryParts.push(`用户关注：${userFocus.join('；')}`);
    }

    if (assistantFocus.length > 0) {
      summaryParts.push(`已给建议：${assistantFocus.join('；')}`);
    }

    const summaryText = this.limitLength(summaryParts.join(' | '), 600);
    if (!summaryText) {
      return null;
    }

    const lastMessage = messages[messages.length - 1] ?? null;
    const generated: ConversationHistorySummary = {
      summary: summaryText,
      messageCount: messages.length,
      lastMessageAt: lastMessage?.createdAt.toISOString() ?? null,
    };
    if (lastMessage?.id) {
      generated.lastMessageId = lastMessage.id;
    }

    return generated;
  }

  /**
   * Keep message fragments concise and readable.
   */
  private normalizeMessageContent(content: string): string {
    const compact = content.replace(/\s+/g, ' ').trim();
    if (!compact) {
      return '';
    }

    const firstSentence = compact.split(/[。！？!?]/)[0]?.trim() ?? compact;
    return this.limitLength(firstSentence || compact, 120);
  }

  /**
   * Map a message intent or agent into a human-readable topic label.
   */
  private describeConversationTopic(
    intent?: string | null,
    agentName?: string | null,
  ): string {
    const normalizedIntent = this.toText(intent);
    if (normalizedIntent === 'resume_diagnosis') {
      return '简历诊断';
    }
    if (normalizedIntent === 'interview_guidance') {
      return '面试指导';
    }
    if (normalizedIntent === 'career_planning') {
      return '职业规划';
    }

    const normalizedAgent = this.toText(agentName);
    if (normalizedAgent === 'resumeDiagnosisAgent') {
      return '简历诊断';
    }
    if (normalizedAgent === 'interviewCoachAgent') {
      return '面试指导';
    }
    if (normalizedAgent === 'careerPlannerAgent') {
      return '职业规划';
    }

    return '';
  }

  /**
   * Truncate a string without splitting the flow too aggressively.
   */
  private limitLength(text: string, maxLength: number): string {
    const compact = text.trim();
    if (compact.length <= maxLength) {
      return compact;
    }

    return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
  }

  /**
   * Parse an optional ISO timestamp string.
   */
  private toOptionalIsoString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Parse an optional non-empty string.
   */
  private toOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private tryParseJson(value: unknown): unknown {
    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
}
