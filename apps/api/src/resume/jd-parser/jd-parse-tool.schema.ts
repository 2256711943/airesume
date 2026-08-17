import { z } from 'zod';
import type { ToolRegistry } from '../../common/llm/tool-registry';

/**
 * `parse_jd` 工具契约。
 *
 * 这是 JD 解析业务与 LLM provider 之间的结构化输出约定，作为单一来源：
 * - `parseJdToolArgumentsSchema`: zod 运行时校验 schema（`ToolRegistry.validateArguments` 使用）
 * - zod -> OpenAI `parameters` 的转换由 `ToolRegistry.toOpenAiTools` 统一完成
 *
 * 字段与 `ParsedJdResult` 对齐（不含 `quality`，该字段由 `JdParserService` 本地构建）。
 */
export const PARSE_JD_TOOL_NAME = 'parse_jd';

/**
 * `rewrite_jd` 工具名。
 *
 * 与 `parse_jd` 共用同一份 zod schema（`parseJdToolArgumentsSchema`），因为重写的输出
 * 结构就是已解析的 JD（不含 quality）。
 *
 * tool name 必须独立：LLM 靠 tool name 理解任务语义（解析 vs 定向重写），
 * 薄适配器也按 tool name 从调用结果中识别对应输出。
 */
export const REWRITE_JD_TOOL_NAME = 'rewrite_jd';

const educationLevelSchema = z.enum(['不限', '大专', '本科', '硕士', '博士']);
const seniorityLevelSchema = z.enum([
  'junior',
  'mid',
  'senior',
  'lead',
  'manager',
  'director',
  'unknown',
]);
const requirementTypeSchema = z.enum([
  '经验',
  '技能',
  '学历',
  '证书',
  '语言',
  '其他',
]);
const businessGoalTypeSchema = z.enum([
  '增长',
  '降本',
  '提效',
  '质量',
  '合规',
  '风控',
  '交付',
  '创新',
  '客户成功',
  '其他',
]);
const confidenceSchema = z.number().min(0).max(1);

const responsibilityItemSchema = z.object({
  text: z.string(),
  action: z.string(),
  object: z.string(),
  scope: z.string().optional(),
  evidenceSpan: z.string(),
  confidence: confidenceSchema,
});

const requirementItemSchema = z.object({
  text: z.string(),
  type: requirementTypeSchema,
  evidenceSpan: z.string(),
  confidence: confidenceSchema,
});

const businessGoalSchema = z.object({
  goalType: businessGoalTypeSchema,
  text: z.string(),
  metricHint: z.string().optional(),
  evidenceSpan: z.string(),
  confidence: confidenceSchema,
});

export const parseJdToolArgumentsSchema = z.object({
  basic: z.object({
    jobTitleRaw: z.string(),
    jobTitleNorm: z.string(),
    industry: z.string().optional(),
    city: z.string().optional(),
    educationMin: educationLevelSchema.optional(),
    yearsExpMin: z.number().optional(),
    yearsExpMax: z.number().optional(),
    salaryMinK: z.number().optional(),
    salaryMaxK: z.number().optional(),
    salaryMonths: z.number().optional(),
    reportTo: z.string().optional(),
    teamSize: z.number().optional(),
  }),
  responsibilities: z.array(responsibilityItemSchema).max(15),
  requirements: z.object({
    must: z.array(requirementItemSchema).max(20),
    preferred: z.array(requirementItemSchema).max(20),
  }),
  skills: z.object({
    hardSkills: z.array(z.string()).max(40),
    softSkills: z.array(z.string()).max(40),
    tools: z.array(z.string()).max(40),
    certificates: z.array(z.string()).max(40),
  }),
  businessGoals: z.array(businessGoalSchema).max(10),
  keywords: z.array(z.string()).max(60),
  seniorityLevel: seniorityLevelSchema,
});

export type ParseJdToolArguments = z.infer<typeof parseJdToolArgumentsSchema>;

/** `parse_jd` 工具描述，注册进 ToolRegistry 时供 LLM 参考。 */
export const PARSE_JD_TOOL_DESCRIPTION =
  'Extract structured fields from a job description and return them as JSON.';

/** `rewrite_jd` 工具描述，注册进 ToolRegistry 时供 LLM 参考。 */
export const REWRITE_JD_TOOL_DESCRIPTION =
  'Rewrite a parsed job description to improve only the specified low-scoring dimensions. Returns JSON with the same schema as the input parsed JD (without quality field).';

/**
 * 将 JD 链路的两个工具注册进 ToolRegistry（zod schema 单一来源）。
 * 由 `ResumeModule` 初始化时调用一次，避免各 client 自行注册造成重复。
 */
export function registerJdTools(registry: ToolRegistry): void {
  registry.register({
    name: PARSE_JD_TOOL_NAME,
    description: PARSE_JD_TOOL_DESCRIPTION,
    inputSchema: parseJdToolArgumentsSchema,
  });
  registry.register({
    name: REWRITE_JD_TOOL_NAME,
    description: REWRITE_JD_TOOL_DESCRIPTION,
    inputSchema: parseJdToolArgumentsSchema,
  });
}

/** `jd_parse` 工具名：JD 解析（本地路由，executor 模式执行）。 */
export const JD_PARSE_TOOL_NAME = 'jd_parse';

/** `jd_score` 工具名：JD 打分（本地路由，executor 模式执行）。 */
export const JD_SCORE_TOOL_NAME = 'jd_score';

/** `jd_parse` 入参：原始 JD 文本。 */
export const jdParseToolInputSchema = z.object({
  jdText: z.string().min(1),
});

/** `jd_score` 入参：原始 JD 文本 + 已解析结果。 */
export const jdScoreToolInputSchema = z.object({
  jdText: z.string().min(1),
  parsedJd: z.record(z.string(), z.unknown()),
});

export type JdParseToolInput = z.infer<typeof jdParseToolInputSchema>;
export type JdScoreToolInput = z.infer<typeof jdScoreToolInputSchema>;

/** `jd_parse` 工具描述，注册进 ToolRegistry 时供 LLM 参考。 */
export const JD_PARSE_TOOL_DESCRIPTION =
  'Parse a raw job description text into a structured JD result. Returns { parsedJd } with basic info, responsibilities, requirements, skills, business goals and keywords.';

/** `jd_score` 工具描述，注册进 ToolRegistry 时供 LLM 参考。 */
export const JD_SCORE_TOOL_DESCRIPTION =
  'Score the quality of a parsed job description against its raw text. Returns { judge } with an overall score, per-dimension scores, issues and suggestions.';

/**
 * 将 JD 诊断（解析/打分）工具注册进 ToolRegistry（zod schema 单一来源）。
 * 由 `ResumeModule` 初始化时调用一次；executor 模式的路由实现见 `JdToolExecutor`。
 */
export function registerJdDiagnosisTools(registry: ToolRegistry): void {
  registry.register({
    name: JD_PARSE_TOOL_NAME,
    description: JD_PARSE_TOOL_DESCRIPTION,
    inputSchema: jdParseToolInputSchema,
  });
  registry.register({
    name: JD_SCORE_TOOL_NAME,
    description: JD_SCORE_TOOL_DESCRIPTION,
    inputSchema: jdScoreToolInputSchema,
  });
}
