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

const RESUME_SLOT_KEY = 'selected_resume_item_ids';
const CONVERSATION_HISTORY_SUMMARY_SLOT_KEY = 'conversation_history_summary';
const RESUME_SNAPSHOT_MEMORY_GROUP = 'resume_snapshot';
const DEFAULT_HISTORY_MESSAGE_LIMIT = 12;
const DEFAULT_DISPLAY_PREFERENCE_LIMIT = 20;

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
    const displayPreferences =
      this.readDisplayPreferencesFromMemoryEntries(cachedPreferenceMemories);

    let conversationHistorySummary =
      this.readConversationHistorySummaryFromMemoryEntries(cachedHistoryMemories);

    if (!conversationHistorySummary) {
      const historyMessages = await this.prisma.conversationMessage.findMany({
        where: {
          conversationId,
          conversation: {
            userId,
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: DEFAULT_HISTORY_MESSAGE_LIMIT,
        select: {
          role: true,
          content: true,
          intent: true,
          agentName: true,
          createdAt: true,
        },
      });
      const orderedHistoryMessages = [...historyMessages].reverse();
      conversationHistorySummary =
        this.generateConversationHistorySummary(orderedHistoryMessages);
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
   */
  async refreshConversationHistorySummary(
    userId: string,
    conversationId: string,
    messageLimit = DEFAULT_HISTORY_MESSAGE_LIMIT,
  ): Promise<void> {
    const messages = await this.prisma.conversationMessage.findMany({
      where: {
        conversationId,
        conversation: {
          userId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: messageLimit,
      select: {
        role: true,
        content: true,
        intent: true,
        agentName: true,
        createdAt: true,
      },
    });

    const orderedMessages = [...messages].reverse();
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

    const lastMessageAt =
      orderedMessages[orderedMessages.length - 1]?.createdAt?.toISOString() ??
      null;

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
        lastMessageAt,
      },
    });
  }

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
    const contentRecord = this.toRecord(this.tryParseJson(latestMemory.content));
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

    return {
      summary,
      messageCount: Number(record.messageCount ?? 0) || 0,
      lastMessageAt:
        this.toOptionalIsoString(record.lastMessageAt) ??
        updatedAt?.toISOString() ??
        null,
    };
  }

  /**
   * Generate a lightweight summary from recent messages.
   */
  private generateConversationHistorySummary(
    messages: Array<{
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

    return {
      summary: summaryText,
      messageCount: messages.length,
      lastMessageAt:
        messages[messages.length - 1]?.createdAt?.toISOString() ?? null,
    };
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
