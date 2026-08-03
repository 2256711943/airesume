import {
  createResumeFormState,
  getInitialChatMessages,
  parseVariants,
  type ChatMessage,
  type ConversationMessageDto,
  type ResumeFormState,
  type ResumeVariant,
} from './resume';

/**
 * 简历会话恢复接口返回的聚合数据。
 */
export interface ConversationResumeContextSummaryDto {
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

export interface ConversationResumeContextDetailDto {
  conversationId: string;
  resumeLibraryItemIds: string[];
  selectedCount: number;
  slotKey: string;
  activeResumeSummaries: ConversationResumeContextSummaryDto[];
  conversationHistorySummary?: {
    summary: string;
    messageCount: number;
    lastMessageAt: string | null;
  } | null;
}

export interface ConversationContextPackUsageDto {
  maxTokens: number;
  reservedTokens: number;
  usedTokens: number;
  droppedTokens: number;
}

export interface ConversationContextPackSummaryBlockDto {
  blockId: string;
  type: string;
  layer: string;
  position: number;
  title: string;
  content: string;
  memoryIds: string[];
  tokenEstimate: number;
  truncated: boolean;
  metadata?: Record<string, unknown>;
}

export interface ConversationContextPackDroppedMemoryDto {
  memoryId: string;
  layer: string;
  reason: string;
  tokenEstimate: number;
  priority: number;
  pinned: boolean;
  summary: string | null;
}

export interface ConversationContextPackDetailDto {
  packId: string;
  conversationId: string;
  runId: string | null;
  intent: string | null;
  maxTokens: number;
  layerOrder: string[];
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  droppedMemories: ConversationContextPackDroppedMemoryDto[];
  summaryBlocks: ConversationContextPackSummaryBlockDto[];
  finalPromptPreview: string;
  usage: ConversationContextPackUsageDto;
  metadata: Record<string, unknown> | null;
  selectedCount: number;
  droppedCount: number;
  summaryBlockCount: number;
  generatedAt: string;
}

export interface ConversationLatestContextPackDto {
  conversationId: string;
  contextPack: ConversationContextPackDetailDto | null;
}

/**
 * 会话恢复接口的完整响应体。
 */
export interface ConversationResumeSessionDto {
  conversationId: string;
  resumeContext: ConversationResumeContextDetailDto;
  latestContextPack: ConversationContextPackDetailDto | null;
  messages: ConversationMessageDto[];
}

/**
 * 本地保存的简历会话草稿。
 */
export interface ResumeSessionStorageSnapshot {
  conversationId: string;
  form: ResumeFormState;
  resumeVariants: ResumeVariant[];
  selectedVariantIndex: number;
  lastGenerateQuery: string;
}

/**
 * 创建一份空的本地会话草稿。
 *
 * @returns 默认草稿数据
 */
export function createEmptyResumeSessionSnapshot(): ResumeSessionStorageSnapshot {
  return {
    conversationId: '',
    form: createResumeFormState(),
    resumeVariants: [],
    selectedVariantIndex: 0,
    lastGenerateQuery: '',
  };
}

/**
 * 清空本地草稿里的会话 ID，保留表单和已生成草稿。
 *
 * @param snapshot 当前本地草稿
 * @returns 去除 conversationId 后的新草稿
 */
export function clearResumeSessionConversationId(
  snapshot: ResumeSessionStorageSnapshot,
): ResumeSessionStorageSnapshot {
  return {
    ...snapshot,
    conversationId: '',
  };
}

/**
 * 从本地存储读取会话草稿。
 *
 * @param storage 浏览器存储对象
 * @param storageKey 存储键名
 * @returns 读取到的草稿或空值
 */
export function readResumeSessionSnapshot(
  storage: Storage | undefined,
  storageKey: string,
): ResumeSessionStorageSnapshot | null {
  if (!storage) {
    return null;
  }

  const rawValue = storage.getItem(storageKey);
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Partial<ResumeSessionStorageSnapshot>;
    const form = normalizeResumeFormSnapshot(parsed.form);
    const resumeVariants = parseVariants(parsed.resumeVariants);
    const selectedVariantIndex = normalizeSelectedVariantIndex(
      parsed.selectedVariantIndex,
      resumeVariants.length,
    );

    return {
      conversationId: typeof parsed.conversationId === 'string' ? parsed.conversationId : '',
      form,
      resumeVariants,
      selectedVariantIndex,
      lastGenerateQuery:
        typeof parsed.lastGenerateQuery === 'string' ? parsed.lastGenerateQuery : '',
    };
  } catch {
    return null;
  }
}

/**
 * 写入或清除会话草稿。
 *
 * @param storage 浏览器存储对象
 * @param storageKey 存储键名
 * @param snapshot 草稿内容，传空表示清除
 * @returns 无返回值
 */
export function writeResumeSessionSnapshot(
  storage: Storage | undefined,
  storageKey: string,
  snapshot: ResumeSessionStorageSnapshot | null,
): void {
  if (!storage) {
    return;
  }

  if (!snapshot) {
    storage.removeItem(storageKey);
    return;
  }

  storage.setItem(storageKey, JSON.stringify(snapshot));
}

/**
 * 将接口返回的表单草稿覆盖到当前响应式表单对象。
 *
 * @param target 当前表单
 * @param source 恢复出来的表单
 * @returns 无返回值
 */
export function applyResumeFormSnapshot(
  target: ResumeFormState,
  source: ResumeFormState | null | undefined,
): void {
  const fallback = createResumeFormState();
  const next = normalizeResumeFormSnapshot(source) ?? fallback;

  Object.assign(target, next);
}

/**
 * 将历史消息转换成前端聊天消息。
 *
 * @param messages 后端历史消息
 * @returns 可直接渲染的聊天消息列表
 */
export function toResumeChatMessages(messages: ConversationMessageDto[]): ChatMessage[] {
  if (messages.length === 0) {
    return getInitialChatMessages();
  }

  return messages.map((message) => ({
    id: message.id,
    role: normalizeChatRole(message.role),
    kind: 'text',
    content: message.content,
    streaming: false,
    trace: null,
  }));
}

/**
 * 提取最近一次系统上下文消息，用于恢复后避免重复写入。
 *
 * @param messages 后端历史消息
 * @returns 最近一次系统上下文文本
 */
export function findLatestSystemContextMessage(
  messages: ConversationMessageDto[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'system' &&
      message.content.startsWith('SYSTEM / UP AI')
    ) {
      return message.content;
    }
  }

  return '';
}

/**
 * 规范化会话草稿里的表单字段。
 *
 * @param source 可能不完整的表单对象
 * @returns 可直接使用的表单对象
 */
function normalizeResumeFormSnapshot(
  source: Partial<ResumeFormState> | null | undefined,
): ResumeFormState {
  const fallback = createResumeFormState();
  const record = source && typeof source === 'object' ? source : null;

  return {
    fullName: toStringField(record?.fullName, fallback.fullName),
    background: toStringField(record?.background, fallback.background),
    targetRole: toStringField(record?.targetRole, fallback.targetRole),
    targetDescription: toStringField(
      record?.targetDescription,
      fallback.targetDescription,
    ),
    skillsText: toStringField(record?.skillsText, fallback.skillsText),
    targetSkillsText: toStringField(
      record?.targetSkillsText,
      fallback.targetSkillsText,
    ),
    experienceText: toStringField(record?.experienceText, fallback.experienceText),
    projectText: toStringField(record?.projectText, fallback.projectText),
    tone: toStringField(record?.tone, fallback.tone),
    language: toStringField(record?.language, fallback.language),
  };
}

/**
 * 规范化聊天角色值。
 *
 * @param role 后端消息角色
 * @returns 前端可用的消息角色
 */
function normalizeChatRole(role: string): ChatMessage['role'] {
  if (role === 'assistant' || role === 'system') {
    return role;
  }

  return 'user';
}

/**
 * 读取字符串字段并做兜底。
 *
 * @param value 候选值
 * @param fallback 默认值
 * @returns 规范化后的字符串
 */
function toStringField(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 规范化选中的简历版本索引。
 *
 * @param value 候选索引
 * @param length 版本总数
 * @returns 可用索引
 */
function normalizeSelectedVariantIndex(
  value: unknown,
  length: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return 0;
  }

  if (length <= 0) {
    return 0;
  }

  return Math.min(value, length - 1);
}
