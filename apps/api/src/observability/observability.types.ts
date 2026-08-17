/**
 * 观测域的数据模型定义，仅用于类型层冻结字段边界。
 */

export type ChatIntent = string;

export type SpecialistAgentName = string;

export type ObservabilityJsonPrimitive = string | number | boolean | null;

export type ObservabilityJsonValue =
  | ObservabilityJsonPrimitive
  | ObservabilityJsonObject
  | ObservabilityJsonValue[];

export interface ObservabilityJsonObject {
  [key: string]: ObservabilityJsonValue;
}

export const OBSERVABILITY_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const;

export type ObservabilityRunStatus =
  (typeof OBSERVABILITY_RUN_STATUSES)[number];

export const OBSERVABILITY_SPAN_KINDS = [
  'run',
  'step',
  'tool',
  'text',
  'checkpoint',
] as const;

export type ObservabilitySpanKind = (typeof OBSERVABILITY_SPAN_KINDS)[number];

export const OBSERVABILITY_SPAN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'canceled',
] as const;

export type ObservabilitySpanStatus =
  (typeof OBSERVABILITY_SPAN_STATUSES)[number];

export const OBSERVABILITY_EVENT_STATUSES = [
  'normal',
  'replay',
  'suppressed',
] as const;

export type ObservabilityEventStatus =
  (typeof OBSERVABILITY_EVENT_STATUSES)[number];

export const OBSERVABILITY_EVENT_TYPES = [
  'start',
  'route_decision',
  'agent.step.started',
  'agent.step.finished',
  'tool.call.started',
  'tool.call.finished',
  'tool_start',
  'tool_done',
  'assistant_chunk',
  'assistant_done',
  'done',
  'error',
  'canceled',
  'checkpoint',
  'chunk',
  'progress',
] as const;

export type ObservabilityEventType = (typeof OBSERVABILITY_EVENT_TYPES)[number];

export const OBSERVABILITY_DIAGNOSTIC_CATEGORIES = [
  'route_misjudgment',
  'tool_failure',
  'tool_timeout',
  'context_missing',
  'context_duplicate',
  'context_truncation',
  'stream_interrupt',
  'stream_incomplete',
  'agent_loop',
  'other',
] as const;

export type ObservabilityDiagnosticCategory =
  (typeof OBSERVABILITY_DIAGNOSTIC_CATEGORIES)[number];

export const OBSERVABILITY_DIAGNOSTIC_SEVERITIES = [
  'critical',
  'warning',
  'info',
] as const;

export type ObservabilityDiagnosticSeverity =
  (typeof OBSERVABILITY_DIAGNOSTIC_SEVERITIES)[number];

/**
 * 上下文包里可直接挂到观测链路中的摘要块。
 */
export interface ObservabilityContextPackSummaryBlock {
  blockId: string;
  type: string;
  layer: string;
  position: number;
  title: string;
  content: string;
  memoryIds: string[];
  tokenEstimate: number;
  truncated: boolean;
  metadata?: ObservabilityJsonObject | null;
}

/**
 * 运行时上下文包快照的公共字段。
 */
export interface ObservabilityContextPackMeta {
  contextPackId: string | null;
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  summaryBlocks: ObservabilityContextPackSummaryBlock[];
  finalPromptPreview: string | null;
}

/**
 * 运行级别根对象，对应一次用户消息触发的完整链路。
 */
export interface ObservabilityRun {
  runId: string;
  conversationId: string;
  userId: string | null;
  intent: ChatIntent | null;
  selectedAgent: SpecialistAgentName | null;
  status: ObservabilityRunStatus;
  startedAt: Date;
  endedAt: Date | null;
  rootSpanId: string;
  contextPackId: string | null;
  selectedMemoryIds: string[];
  droppedMemoryIds: string[];
  summaryBlocks: ObservabilityContextPackSummaryBlock[];
  finalPromptPreview: string | null;
  replayVersion: number;
  modelName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * 运行态根 span 的附加元数据。
 */
export interface ObservabilityRunSpanMeta extends ObservabilityContextPackMeta {
  conversationId: string;
  intent: ChatIntent | null;
  selectedAgent: SpecialistAgentName | null;
  modelName: string | null;
}

/**
 * 步骤 span 的附加元数据。
 */
export interface ObservabilityStepSpanMeta extends ObservabilityContextPackMeta {
  stepIndex: number;
  promptPreview: string | null;
}

/**
 * 工具调用 span 的附加元数据。
 */
export interface ObservabilityToolSpanMeta {
  toolName: string;
  success: boolean;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * 文本输出 span 的附加元数据。
 */
export interface ObservabilityTextSpanMeta {
  totalChars: number;
  chunkCount: number;
}

/**
 * 检查点 span 的附加元数据。
 */
export interface ObservabilityCheckpointSpanMeta {
  label: string;
  keyValues: ObservabilityJsonObject | null;
}

/**
 * Span 共用字段。
 */
export interface ObservabilitySpanBase<TKind extends ObservabilitySpanKind> {
  spanId: string;
  parentSpanId: string | null;
  runId: string;
  kind: TKind;
  name: string;
  status: ObservabilitySpanStatus;
  startTs: Date;
  endTs: Date | null;
  seqStart: number;
  seqEnd: number | null;
}

export interface ObservabilityRunSpan extends ObservabilitySpanBase<'run'> {
  meta: ObservabilityRunSpanMeta;
}

export interface ObservabilityStepSpan extends ObservabilitySpanBase<'step'> {
  meta: ObservabilityStepSpanMeta;
}

export interface ObservabilityToolSpan extends ObservabilitySpanBase<'tool'> {
  meta: ObservabilityToolSpanMeta;
}

export interface ObservabilityTextSpan extends ObservabilitySpanBase<'text'> {
  meta: ObservabilityTextSpanMeta;
}

export interface ObservabilityCheckpointSpan extends ObservabilitySpanBase<'checkpoint'> {
  meta: ObservabilityCheckpointSpanMeta;
}

export type ObservabilitySpan =
  | ObservabilityRunSpan
  | ObservabilityStepSpan
  | ObservabilityToolSpan
  | ObservabilityTextSpan
  | ObservabilityCheckpointSpan;

/**
 * 不可变事件记录，作为持久化和回放的最小单元。
 */
export interface ObservabilityEvent<
  TType extends ObservabilityEventType = ObservabilityEventType,
  TPayload extends ObservabilityJsonObject = ObservabilityJsonObject,
> {
  eventId: string;
  seq: number;
  runId: string;
  spanId: string | null;
  type: TType;
  status: ObservabilityEventStatus | null;
  ts: Date;
  payload: TPayload;
}

/**
 * 事件日志持久化记录，补充查询维度和落库时间。
 */
export interface PersistedObservabilityEvent<
  TType extends ObservabilityEventType = ObservabilityEventType,
  TPayload extends ObservabilityJsonObject = ObservabilityJsonObject,
> extends ObservabilityEvent<TType, TPayload> {
  conversationId: string | null;
  userId: string | null;
  agentRunId: string | null;
  createdAt: Date;
}

/**
 * 事件日志写入载荷。
 */
export interface ObservabilityEventWriteInput<
  TType extends ObservabilityEventType = ObservabilityEventType,
  TPayload extends ObservabilityJsonObject = ObservabilityJsonObject,
> {
  eventId: string;
  seq: number;
  runId: string;
  conversationId?: string | null;
  userId?: string | null;
  agentRunId?: string | null;
  spanId?: string | null;
  type: TType;
  status?: ObservabilityEventStatus | null;
  ts: Date;
  payload: TPayload;
}

/**
 * 事件日志查询条件。
 */
export interface ObservabilityEventQuery {
  eventId?: string;
  runId?: string;
  conversationId?: string;
  agentRunId?: string;
  spanId?: string | null;
  types?: ObservabilityEventType[];
  statuses?: ObservabilityEventStatus[];
  seqGte?: number;
  seqGt?: number;
  seqLte?: number;
  seqLt?: number;
  tsAfter?: Date;
  tsBefore?: Date;
  limit?: number;
  orderBy?: {
    field: 'seq' | 'ts' | 'createdAt';
    direction: 'asc' | 'desc';
  };
}

/**
 * SSE 传输信封，语义上等价于事件对象，仅作网络层扁平化。
 */
export interface ObservabilitySseEnvelope<
  TType extends ObservabilityEventType = ObservabilityEventType,
  TPayload extends ObservabilityJsonObject = ObservabilityJsonObject,
> {
  id: string;
  seq: number;
  runId: string;
  spanId: string | null;
  type: TType;
  ts: Date;
  payload: TPayload;
}

/**
 * 回放恢复锚点，保存关键状态快照的增量信息。
 */
export interface ObservabilityCheckpoint {
  checkpointId: string;
  runId: string;
  spanId: string | null;
  seq: number;
  label: string;
  keyValues: ObservabilityJsonObject;
  createdAt: Date;
}

/**
 * 规则引擎输出的结构化诊断结果。
 */
export interface ObservabilityDiagnosticEvidence {
  type: string;
  value: string;
  eventId: string;
}

export interface ObservabilityDiagnosticIssue {
  issueId: string;
  runId: string;
  spanId: string | null;
  category: ObservabilityDiagnosticCategory;
  severity: ObservabilityDiagnosticSeverity;
  title: string;
  reason: string;
  evidence: ObservabilityDiagnosticEvidence[];
  suggestion: string | null;
  createdAt: Date;
  /** 规则引擎补充字段：产出该 issue 的规则标识。 */
  ruleId?: string;
  /** 稳定去重 key：{runId}:{category}:{ruleId}:{spanId||"run"}:{primaryEvidenceEventId}。 */
  dedupeKey?: string;
  /** 聚合后最后更新时间。 */
  updatedAt?: Date;
  /** 聚合次数：同一问题被命中的证据条数（同类多证据合并时大于 1）。 */
  occurrenceCount?: number;
}
