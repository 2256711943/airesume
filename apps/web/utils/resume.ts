/**
 * 简历相关工具函数与类型定义（前端）
 *
 * 集中管理：
 * 1. 简历/会话相关数据结构的类型（变体、表单、会话、追踪等）；
 * 2. 表单文本的解析与归一化（经验/项目按行解析）；
 * 3. 生成查询串、系统上下文、Markdown 导出等纯函数工具。
 */

import type { ChatSseEvent } from "./sse-events";

/** 简历重写模式：技术向 / 商务向 / 综合向。 */
export type ResumeMode = "technical" | "business" | "hybrid";
/** 聊天消息角色。 */
export type ChatRole = "system" | "user" | "assistant";
/** 聊天消息类型：纯文本 / 简历表单。 */
export type ChatMessageKind = "text" | "form";

/** 简历中的一段工作经历。 */
export interface ResumeExperience {
  company: string;
  role: string;
  highlights: string[];
}

/** 简历中的一个项目经历。 */
export interface ResumeProject {
  name: string;
  highlights: string[];
}

/** 简历生成结果变体（对应后端 AiResumeVariant）。 */
export interface ResumeVariant {
  id: string;
  mode?: ResumeMode;
  summary: string;
  experience: ResumeExperience[];
  projects: ResumeProject[];
  skills: string[];
}

/** 简历表单状态（与表单控件一一对应）。 */
export interface ResumeFormState {
  /** 姓名。 */
  fullName: string;
  /** 个人背景简介。 */
  background: string;
  /** 目标岗位名称。 */
  targetRole: string;
  /** 目标岗位描述（JD）。 */
  targetDescription: string;
  /** 技能清单（文本，按行/逗号分隔）。 */
  skillsText: string;
  /** 目标岗位必备技能（文本）。 */
  targetSkillsText: string;
  /** 工作经历（按行，格式：公司 | 角色 | 亮点;亮点）。 */
  experienceText: string;
  /** 项目经历（按行，格式：项目名 | 亮点;亮点）。 */
  projectText: string;
  /** 文案语气。 */
  tone: string;
  /** 生成语言。 */
  language: string;
}

/** 通用 API 响应信封。 */
export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error: { code: string; message: string } | null;
  requestId: string;
}

/** 会话（Conversation）概要信息。 */
export interface ConversationDto {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** 会话消息 DTO。 */
export interface ConversationMessageDto {
  id: string;
  role: string;
  content: string;
  intent: string | null;
  agentName: string | null;
  toolCallSummary?: ConversationToolCallSummary[] | null;
  createdAt: string;
}

/** 工具调用摘要（供前端展示调用结果）。 */
export interface ConversationToolCallSummary {
  toolName: string;
  success: boolean;
  latencyMs?: number | null;
  errorCode?: string;
  errorMessage?: string;
}

/** 路由决策命中的规则。 */
export interface ChatRouteDecisionRule {
  ruleId: string;
  label: string;
  matchedKeywords: string[];
}

/** 消息路由决策：选定的意图与 Agent、置信度及回退情况。 */
export interface ChatRouteDecision {
  intent: string;
  selectedAgent: string;
  reason: string;
  confidence: number;
  fallbackUsed: boolean;
  matchedRules: ChatRouteDecisionRule[];
}

/** 聊天接口的响应数据。 */
export interface ChatResponseData {
  conversationId: string;
  agentRunId: string;
  createdConversation: boolean;
  message: ConversationMessageDto;
  assistantMessage?: ConversationMessageDto;
  routeDecision: ChatRouteDecision;
  recentMessages: ConversationMessageDto[];
}

/** 追踪中的一个工具调用 Span。 */
export interface ChatTraceToolSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  startTs: string;
  endTs?: string | null;
  latencyMs?: number | null;
  success?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/** 单条消息的完整追踪信息（路由决策 + 工具 Span + 原始事件）。 */
export interface ChatMessageTrace {
  agentRunId: string;
  mainSpanId?: string;
  routeDecision: ChatRouteDecision;
  toolSpans: ChatTraceToolSpan[];
  rawEvents?: Array<ChatSseEvent & { ts: string }>;
  routeDecisionStarted?: boolean;
  done?: boolean;
}

/** 前端聊天消息（含类型与可选追踪信息）。 */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  streaming?: boolean;
  /** 真截断标记：流异常终止且已产出部分内容时为真，渲染侧据此安全降级并提示 */
  incomplete?: boolean;
  trace?: ChatMessageTrace | null;
}

/** 三版简历的展示标签（与技术/商务/综合三种模式对应）。 */
export const variantLabels = ["技术版", "业务版", "综合版"] as const;
/** 快捷提问标签。 */
export const quickTags = [
  "简历诊断",
  "简历翻译",
  "项目亮点优化",
  "职业规划",
] as const;

/** 路由决策的空值兜底。 */
export const defaultRouteDecision: ChatRouteDecision = {
  intent: "",
  selectedAgent: "",
  reason: "",
  confidence: 0,
  fallbackUsed: false,
  matchedRules: [],
};

/** 创建一份空白的简历表单状态（含语气/语言默认值）。 */
export function createResumeFormState(): ResumeFormState {
  return {
    fullName: "",
    background: "",
    targetRole: "",
    targetDescription: "",
    skillsText: "",
    targetSkillsText: "",
    experienceText: "",
    projectText: "",
    tone: "professional",
    language: "zh-CN",
  };
}

/** 初始聊天消息：放置简历表单引导消息。 */
export function getInitialChatMessages(): ChatMessage[] {
  return [
    {
      id: "resume-form",
      role: "system",
      kind: "form",
      content:
        "请先填写这张简历表单。你可以填写后生成三版简历，也可以跳过直接开始对话。",
    },
  ];
}

/** 构建一条消息的初始追踪结构（空路由决策 + 空 Span 列表）。 */
export function buildChatTrace(
  agentRunId = "",
  routeDecision: ChatRouteDecision = defaultRouteDecision,
): ChatMessageTrace {
  return {
    agentRunId,
    mainSpanId: "",
    routeDecision: {
      ...routeDecision,
      matchedRules: [...routeDecision.matchedRules],
    },
    toolSpans: [],
    rawEvents: [],
    routeDecisionStarted: false,
    done: false,
  };
}

/** 生成聊天消息 ID：角色 + 时间戳 + 随机后缀，保证唯一性。 */
export function createChatMessageId(
  role: string,
  now = Date.now(),
  random = Math.random(),
) {
  return `${role}_${now}_${random.toString(36).slice(2, 8)}`;
}

/** 将文本按换行或逗号拆分，去除空白并过滤空项（用于技能等清单）。 */
export function splitEntries(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 解析工作经历文本：
 * 每行格式「公司 | 角色 | 亮点1;亮点2」，缺公司或角色的一行会被忽略；
 * 未提供亮点时使用默认占位亮点。
 */
export function parseExperienceLines(value: string): ResumeExperience[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((line) => {
      // 按 | 拆分：公司、角色、亮点文本
      const [company = "", role = "", highlightText = ""] = line
        .split("|")
        .map((item) => item.trim());
      if (!company || !role) {
        return null;
      }

      // 亮点按 ; 拆分
      const highlights = highlightText
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      return {
        company,
        role,
        highlights:
          highlights.length > 0 ? highlights : [`负责 ${role} 相关工作`],
      };
    })
    .filter((item): item is ResumeExperience => item !== null);
}

/**
 * 解析项目经历文本：
 * 每行格式「项目名 | 亮点1;亮点2」，缺项目名的一行会被忽略；
 * 未提供亮点时使用默认占位亮点。
 */
export function parseProjectLines(value: string): ResumeProject[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((line) => {
      // 按 | 拆分：项目名、亮点文本
      const [name = "", highlightText = ""] = line
        .split("|")
        .map((item) => item.trim());
      if (!name) {
        return null;
      }

      // 亮点按 ; 拆分
      const highlights = highlightText
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      return {
        name,
        highlights:
          highlights.length > 0 ? highlights : ["完成了该项目的关键交付"],
      };
    })
    .filter((item): item is ResumeProject => item !== null);
}

/** 类型守卫：判断未知值是否为合法的 ResumeVariant（校验核心字段）。 */
export function isResumeVariant(value: unknown): value is ResumeVariant {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.summary === "string" &&
    Array.isArray(item.experience) &&
    Array.isArray(item.projects) &&
    Array.isArray(item.skills)
  );
}

/** 将未知值安全转为记录对象（非对象时返回空对象）。 */
function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : ({} as Record<string, unknown>);
}

/**
 * 解析后端返回的变体列表：
 * 过滤非法项，并对每个字段做字符串化清洗（防御后端字段缺失）。
 */
export function parseVariants(value: unknown): ResumeVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isResumeVariant).map((item) => ({
    id: item.id,
    mode: item.mode,
    summary: item.summary,
    experience: item.experience.map((exp) => {
      const record = toRecord(exp);
      return {
        company: String(record.company ?? ""),
        role: String(record.role ?? ""),
        highlights: Array.isArray(record.highlights)
          ? record.highlights.map((highlight) => String(highlight))
          : [],
      };
    }),
    projects: item.projects.map((project) => {
      const record = toRecord(project);
      return {
        name: String(record.name ?? ""),
        highlights: Array.isArray(record.highlights)
          ? record.highlights.map((highlight) => String(highlight))
          : [],
      };
    }),
    skills: item.skills.map((skill) => String(skill)),
  }));
}

/** 获取指定下标变体的展示标签（越界时回退为「版本 N」）。 */
export function getVariantLabel(index: number): string {
  return variantLabels[index] ?? `版本 ${index + 1}`;
}

/** 生成指定变体的导出文件名（Markdown）。 */
export function buildVariantFileName(
  targetRole: string,
  index: number,
): string {
  return `${buildVariantFileStem(targetRole, index)}.md`;
}

/**
 * 生成不带扩展名的导出文件基础名称：目标岗位 + 版本标签。
 *
 * @param targetRole 当前目标岗位名称。
 * @param index 当前简历版本索引。
 * @returns 不带扩展名的导出文件基础名称。
 */
export function buildVariantFileStem(
  targetRole: string,
  index: number,
): string {
  const safeRole = targetRole.trim() || "resume";
  return `${safeRole}-${getVariantLabel(index)}`;
}

/** 将流式生成阶段标识映射为中文展示文案。 */
export function getStreamStageLabel(stage: string): string {
  const stageLabelMap: Record<string, string> = {
    planning: "规划中",
    generating: "生成中",
    post_processing: "整理中",
    idle: "空闲",
  };

  if (!stage) {
    return "等待生成";
  }

  return stageLabelMap[stage] ?? stage;
}

/** 表单是否满足生成前置条件：姓名、背景、目标岗位、至少一项技能。 */
export function isGenerationReady(form: ResumeFormState): boolean {
  return (
    form.fullName.trim().length > 0 &&
    form.background.trim().length > 0 &&
    form.targetRole.trim().length > 0 &&
    splitEntries(form.skillsText).length > 0
  );
}

/** 构建当前会话标题（无目标岗位时使用默认标题）。 */
export function buildCurrentChatTitle(targetRole: string): string {
  return targetRole.trim() || "UP AI 简历对话";
}

/** 构建表单核心信息的摘要行（用于会话上下文展示）。 */
export function buildFormSummaryLines(form: ResumeFormState): string[] {
  return [
    form.fullName.trim() ? `姓名：${form.fullName.trim()}` : "姓名：未填写",
    form.targetRole.trim()
      ? `目标岗位：${form.targetRole.trim()}`
      : "目标岗位：未填写",
    form.background.trim() ? `背景：${form.background.trim()}` : "背景：未填写",
    splitEntries(form.skillsText).length > 0
      ? `技能：${splitEntries(form.skillsText).join(" / ")}`
      : "技能：未填写",
  ];
}

/**
 * 根据表单构建生成请求的查询串：
 * profile / targetJob 序列化为 JSON，并携带语气、语言、变体数量。
 */
export function buildGenerateQuery(form: ResumeFormState): string {
  const profile = {
    fullName: form.fullName.trim(),
    background: form.background.trim(),
    skills: splitEntries(form.skillsText),
    experiences: parseExperienceLines(form.experienceText),
    projects: parseProjectLines(form.projectText),
  };

  const targetJob = {
    title: form.targetRole.trim(),
    description: form.targetDescription.trim(),
    mustHaveSkills: splitEntries(form.targetSkillsText),
  };

  return new URLSearchParams({
    profile: JSON.stringify(profile),
    targetJob: JSON.stringify(targetJob),
    tone: form.tone.trim() || "professional",
    language: form.language.trim() || "zh-CN",
    variants: "3",
  }).toString();
}

/**
 * 构建写入会话的系统上下文消息：
 * 汇总表单中的姓名/岗位/背景/技能/经历等信息，并提示模型优先结合上下文回答。
 */
export function buildSystemContextMessage(form: ResumeFormState): string {
  const experienceLines = parseExperienceLines(form.experienceText);
  const projectLines = parseProjectLines(form.projectText);
  const skillEntries = splitEntries(form.skillsText);
  const targetSkillEntries = splitEntries(form.targetSkillsText);

  return [
    "SYSTEM / UP AI 简历上下文",
    form.fullName.trim() ? `- 姓名：${form.fullName.trim()}` : "- 姓名：未填写",
    form.targetRole.trim()
      ? `- 目标岗位：${form.targetRole.trim()}`
      : "- 目标岗位：未填写",
    form.background.trim()
      ? `- 背景：${form.background.trim()}`
      : "- 背景：未填写",
    skillEntries.length > 0
      ? `- 技能：${skillEntries.join(" / ")}`
      : "- 技能：未填写",
    targetSkillEntries.length > 0
      ? `- 岗位要求：${targetSkillEntries.join(" / ")}`
      : "- 岗位要求：未填写",
    experienceLines.length > 0
      ? `- 工作经历：${experienceLines.length} 条`
      : "- 工作经历：未填写",
    projectLines.length > 0
      ? `- 项目经历：${projectLines.length} 条`
      : "- 项目经历：未填写",
    "说明：后续回答应优先结合上述上下文；如果信息不足，先追问再给方案。",
  ].join("\n");
}

/** 将单个变体渲染为 Markdown 简历文本（用于展示与导出）。 */
export function buildVariantMarkdown(
  variant: ResumeVariant,
  label: string,
): string {
  // 工作经历段落
  const experienceSection = variant.experience
    .map((item) => {
      const highlights = item.highlights
        .map((highlight) => `- ${highlight}`)
        .join("\n");
      return `### ${item.company} | ${item.role}\n${highlights}`;
    })
    .join("\n\n");

  // 项目经历段落
  const projectSection = variant.projects
    .map((item) => {
      const highlights = item.highlights
        .map((highlight) => `- ${highlight}`)
        .join("\n");
      return `### ${item.name}\n${highlights}`;
    })
    .join("\n\n");

  return [
    `# ${label}`,
    "",
    "## 个人总结",
    variant.summary || "暂无摘要",
    "",
    "## 工作经历",
    experienceSection || "- 暂无工作经历",
    "",
    "## 项目经历",
    projectSection || "- 暂无项目经历",
    "",
    "## 核心技能",
    variant.skills.join(" / ") || "暂无技能",
  ].join("\n");
}

/** 将所有变体拼接为一份 Markdown（各变体之间用分隔线隔开）。 */
export function buildAllVariantsMarkdown(variants: ResumeVariant[]): string {
  if (variants.length === 0) {
    return "当前还没有生成结果。";
  }

  return variants
    .map((variant, index) =>
      buildVariantMarkdown(variant, getVariantLabel(index)),
    )
    .join("\n\n---\n\n");
}
