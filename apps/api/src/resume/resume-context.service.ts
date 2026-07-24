import { Injectable } from '@nestjs/common';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import { PrismaService } from '../prisma/prisma.service';

const RESUME_SLOT_KEY = 'selected_resume_item_ids';
const CONVERSATION_HISTORY_SUMMARY_SLOT_KEY = 'conversation_history_summary';
const DEFAULT_HISTORY_MESSAGE_LIMIT = 12;

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

/**
 * Conversation context used by chat and agents.
 */
export interface ResumeConversationContext {
  activeResumeIds: string[];
  activeResumeSummaries: ResumeContextSummary[];
  selectedCount: number;
  conversationHistorySummary: ConversationHistorySummary | null;
}

@Injectable()
export class ResumeContextService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Load active resume context and the latest conversation history summary.
   */
  async buildConversationContext(
    userId: string,
    conversationId: string,
  ): Promise<ResumeConversationContext> {
    const [memorySlot, historySlot, historyMessages] = await Promise.all([
      this.prisma.conversationMemorySlot.findFirst({
        where: {
          conversationId,
          slotKey: RESUME_SLOT_KEY,
          conversation: {
            userId,
          },
        },
        select: {
          slotValue: true,
        },
      }),
      this.prisma.conversationMemorySlot.findFirst({
        where: {
          conversationId,
          slotKey: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
          conversation: {
            userId,
          },
        },
        select: {
          slotValue: true,
          updatedAt: true,
        },
      }),
      this.prisma.conversationMessage.findMany({
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
      }),
    ]);

    const activeResumeIds = this.extractResumeIds(memorySlot?.slotValue);
    const activeResumeSummaries = await this.loadResumeSummaries(
      userId,
      activeResumeIds,
    );
    const orderedHistoryMessages = [...historyMessages].reverse();
    const conversationHistorySummary =
      this.parseConversationHistorySummary(
        historySlot?.slotValue,
        historySlot?.updatedAt,
      ) ?? this.generateConversationHistorySummary(orderedHistoryMessages);

    return {
      activeResumeIds,
      activeResumeSummaries,
      selectedCount: activeResumeSummaries.length,
      conversationHistorySummary,
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
      return;
    }

    const lastMessageAt =
      orderedMessages[orderedMessages.length - 1]?.createdAt?.toISOString() ??
      null;

    await this.prisma.conversationMemorySlot.upsert({
      where: {
        conversationId_slotKey: {
          conversationId,
          slotKey: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
        },
      },
      create: {
        conversationId,
        slotKey: CONVERSATION_HISTORY_SUMMARY_SLOT_KEY,
        slotValue: {
          summary: historySummary.summary,
          messageCount: orderedMessages.length,
          lastMessageAt,
        },
      },
      update: {
        slotValue: {
          summary: historySummary.summary,
          messageCount: orderedMessages.length,
          lastMessageAt,
        },
      },
    });
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
}
