import type { ChatSseEvent } from "./sse-events";

export type ResumeMode = "technical" | "business" | "hybrid";
export type ChatRole = "system" | "user" | "assistant";
export type ChatMessageKind = "text" | "form";

export interface ResumeExperience {
  company: string;
  role: string;
  highlights: string[];
}

export interface ResumeProject {
  name: string;
  highlights: string[];
}

export interface ResumeVariant {
  id: string;
  mode?: ResumeMode;
  summary: string;
  experience: ResumeExperience[];
  projects: ResumeProject[];
  skills: string[];
}

export interface ResumeFormState {
  fullName: string;
  background: string;
  targetRole: string;
  targetDescription: string;
  skillsText: string;
  targetSkillsText: string;
  experienceText: string;
  projectText: string;
  tone: string;
  language: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error: { code: string; message: string } | null;
  requestId: string;
}

export interface ConversationDto {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessageDto {
  id: string;
  role: string;
  content: string;
  intent: string | null;
  agentName: string | null;
  toolCallSummary?: ConversationToolCallSummary[] | null;
  createdAt: string;
}

export interface ConversationToolCallSummary {
  toolName: string;
  success: boolean;
  latencyMs?: number | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface ChatRouteDecisionRule {
  ruleId: string;
  label: string;
  matchedKeywords: string[];
}

export interface ChatRouteDecision {
  intent: string;
  selectedAgent: string;
  reason: string;
  confidence: number;
  fallbackUsed: boolean;
  matchedRules: ChatRouteDecisionRule[];
}

export interface ChatResponseData {
  conversationId: string;
  agentRunId: string;
  createdConversation: boolean;
  message: ConversationMessageDto;
  assistantMessage?: ConversationMessageDto;
  routeDecision: ChatRouteDecision;
  recentMessages: ConversationMessageDto[];
}

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

export interface ChatMessageTrace {
  agentRunId: string;
  mainSpanId?: string;
  routeDecision: ChatRouteDecision;
  toolSpans: ChatTraceToolSpan[];
  rawEvents?: Array<ChatSseEvent & { ts: string }>;
  routeDecisionStarted?: boolean;
  done?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  kind: ChatMessageKind;
  content: string;
  streaming?: boolean;
  trace?: ChatMessageTrace | null;
}

export const variantLabels = ["技术版", "业务版", "综合版"] as const;
export const quickTags = [
  "简历诊断",
  "简历翻译",
  "项目亮点优化",
  "职业规划",
] as const;

export const defaultRouteDecision: ChatRouteDecision = {
  intent: "",
  selectedAgent: "",
  reason: "",
  confidence: 0,
  fallbackUsed: false,
  matchedRules: [],
};

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

export function createChatMessageId(
  role: string,
  now = Date.now(),
  random = Math.random(),
) {
  return `${role}_${now}_${random.toString(36).slice(2, 8)}`;
}

export function splitEntries(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseExperienceLines(value: string): ResumeExperience[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((line) => {
      const [company = "", role = "", highlightText = ""] = line
        .split("|")
        .map((item) => item.trim());
      if (!company || !role) {
        return null;
      }

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

export function parseProjectLines(value: string): ResumeProject[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((line) => {
      const [name = "", highlightText = ""] = line
        .split("|")
        .map((item) => item.trim());
      if (!name) {
        return null;
      }

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

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : ({} as Record<string, unknown>);
}

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

export function getVariantLabel(index: number): string {
  return variantLabels[index] ?? `版本 ${index + 1}`;
}

export function buildVariantFileName(
  targetRole: string,
  index: number,
): string {
  return `${buildVariantFileStem(targetRole, index)}.md`;
}

/**
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

export function isGenerationReady(form: ResumeFormState): boolean {
  return (
    form.fullName.trim().length > 0 &&
    form.background.trim().length > 0 &&
    form.targetRole.trim().length > 0 &&
    splitEntries(form.skillsText).length > 0
  );
}

export function buildCurrentChatTitle(targetRole: string): string {
  return targetRole.trim() || "UP AI 简历对话";
}

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

export function buildVariantMarkdown(
  variant: ResumeVariant,
  label: string,
): string {
  const experienceSection = variant.experience
    .map((item) => {
      const highlights = item.highlights
        .map((highlight) => `- ${highlight}`)
        .join("\n");
      return `### ${item.company} | ${item.role}\n${highlights}`;
    })
    .join("\n\n");

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
