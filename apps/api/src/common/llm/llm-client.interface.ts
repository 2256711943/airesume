/**
 * JD 链路使用的 LLM 客户端抽象。
 *
 * 包含两类客户端：
 * - `JdLlmParserClient`: JD 解析（文本 -> 结构化 ParsedJdResult）
 * - `JdLlmRewriterClient`: JD 定向重写（基于 judge 低分维度改善已解析结果）
 *
 * 业务服务只依赖这些接口，不直接接触具体 provider（OpenAI / Dashscope），
 * 后续切换 provider 或引入 agent loop 时无需重写业务逻辑。
 */
export interface JdLlmParserClient {
  /**
   * 请求 LLM 解析 JD 文本。
   *
   * 返回 `parse_jd` function call 的 arguments（已解析为 JSON 对象），
   * 由调用方交给 `LlmSanitizer` / `convertLlmPayloadToParsedResult()` 消费。
   *
   * 模型未产生 tool call、arguments 为空或非法 JSON 时抛错，由调用方走 fallback。
   */
  parseJd(input: { jdText: string; signal?: AbortSignal }): Promise<unknown>;
}

/** NestJS 依赖注入 token，用于注册/注入 `JdLlmParserClient` 实现。 */
export const JD_LLM_PARSER_CLIENT = Symbol('JD_LLM_PARSER_CLIENT');

/**
 * 单个维度的定向改善目标。
 *
 * 由 `JdRewriterService` 根据 `JdJudgeResult` 的低分维度构造，
 * 告诉 LLM "哪些维度需要改、当前差多少、往什么方向改"。
 */
export interface JdRewriteImprovementTarget {
  /** 低分维度名（如 specificity / measurability / seniorityFit），由 service 层决定 */
  dimension: string;
  /** 当前得分 */
  currentScore: number;
  /** 达标阈值，用于让 LLM 理解差距 */
  threshold: number;
  /** 给 LLM 的改善方向提示（如 "improve responsibilities concreteness"） */
  hint: string;
}

/** `JdLlmRewriterClient.rewriteJd` 的输入。 */
export interface JdLlmRewriteInput {
  /** 已解析的 ParsedJdResult（client 会原样序列化进 prompt） */
  parsedJd: unknown;
  /** 原始 JD 文本，用于让 LLM 保持 evidenceSpan 可溯源、避免捏造 */
  rawJdText: string;
  /** 定向改善目标列表，调用方需保证非空 */
  targets: JdRewriteImprovementTarget[];
  signal?: AbortSignal;
}

/**
 * JD 定向重写使用的 LLM 客户端抽象。
 *
 * `JdRewriterService` 只依赖该接口。LLM 调用失败时由 service 层回退到规则版重写，
 * 因此 client 可以在任意失败分支直接抛错。
 */
export interface JdLlmRewriterClient {
  /**
   * 请求 LLM 对已解析的 JD 做定向重写。
   *
   * 返回 `rewrite_jd` function call 的 arguments（已解析为 JSON 对象），
   * 结构与 `parse_jd` 一致（复用 `parseJdToolArgumentsSchema` 校验），
   * 由调用方负责合并 quality 字段后构造完整 ParsedJdResult。
   *
   * 模型未产生 tool call、arguments 为空、非法 JSON 或 schema 校验失败时抛错。
   */
  rewriteJd(input: JdLlmRewriteInput): Promise<unknown>;
}

/** NestJS 依赖注入 token，用于注册/注入 `JdLlmRewriterClient` 实现。 */
export const JD_LLM_REWRITER_CLIENT = Symbol('JD_LLM_REWRITER_CLIENT');
