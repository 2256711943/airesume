/**
 * 记忆候选抽取与决策相关的领域类型。
 *
 * 数据流：用户消息 → MemoryCandidateExtractor（LLM 抽取 + 5 维打分）
 * → MemoryDecisionService（三路分流）→ Constraint / Candidate / Persistent。
 */

/**
 * 记忆候选的语义类型。仅用于辅助决策与可观测，不直接决定落点。
 */
export const MEMORY_CANDIDATE_TYPES = [
  'constraint',
  'fact',
  'profile',
  'decision',
  'task_state',
  'other',
] as const;

export type MemoryCandidateType = (typeof MEMORY_CANDIDATE_TYPES)[number];

/**
 * 决策分流后的落点类型。
 * - constraint：强约束，写入 Runtime Context，每轮注入；
 * - candidate：暂不持久化，进入观察期，复现后升级为长期记忆；
 * - persistent：写入 Long-term Memory，跨会话可见；
 * - discard：不写入，直接丢弃。
 */
export const MEMORY_DECISION_KINDS = [
  'constraint',
  'candidate',
  'persistent',
  'discard',
] as const;

export type MemoryDecisionKind = (typeof MEMORY_DECISION_KINDS)[number];

/**
 * 判断维度评分，所有取值统一归一化到 [0, 1]。
 */
export interface MemoryDimensionScores {
  /** 持久化意图：用户是否表达了"以后都这样 / 记住"等长期保留意图。 */
  persistenceIntent: number;
  /** 稳定性：内容是否稳定，不随对话轮次频繁变化。 */
  stability: number;
  /** 复用性：是否可跨会话、跨任务复用。 */
  reusability: number;
  /** 重要性：对后续任务的影响程度。 */
  importance: number;
  /** 新鲜度：时效性，是否带明确时间窗口。 */
  freshness: number;
}

/**
 * 抽取器输出的单条记忆候选。
 */
export interface MemoryCandidate {
  type: MemoryCandidateType;
  /** 归一化后的记忆文本（自包含、可独立理解）。 */
  content: string;
  /** 支撑该候选的原文片段，用于溯源。 */
  evidence: string;
  scores: MemoryDimensionScores;
}

/**
 * 决策结果。
 */
export interface MemoryDecision {
  kind: MemoryDecisionKind;
  candidate: MemoryCandidate;
  /** 命中的规则说明，便于可观测与调优。 */
  reason: string;
}

/**
 * 决策阈值。任一条件不满足时降级到下一档，全部不满足则丢弃。
 */
export const MEMORY_DECISION_THRESHOLDS = {
  persistent: {
    persistenceIntent: 0.7,
    stability: 0.7,
    reusability: 0.6,
    importance: 0.6,
  },
  constraint: {
    persistenceIntent: 0.5,
    stability: 0.5,
    importance: 0.5,
  },
  candidate: {
    importance: 0.4,
  },
} as const;

/** candidate 复现达到该次数后升级为长期记忆。 */
export const CANDIDATE_PROMOTION_OBSERVED_COUNT = 2;

/** candidate 观察期 TTL（毫秒），默认 14 天。 */
export const CANDIDATE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

/** constraint 记忆在 preference 层中的合并组。 */
export const MEMORY_CONSTRAINT_MERGE_GROUP = 'memory_constraint';

/** constraint 记忆写前的去重窗口与保留上限（按更新时间倒序取前 N 条）。 */
export const MEMORY_CONSTRAINT_LIMIT = 20;

/** constraint 记忆每轮注入提示词的最大条数，读侧窗口与注入上限保持一致。 */
export const MEMORY_CONSTRAINT_INJECT_LIMIT = 8;

/** 快通道单轮消息最多抽取的约束条数。 */
export const MEMORY_CONSTRAINT_MAX_PER_MESSAGE = 3;

/** 长期记忆在 Long-term Memory 中的合并组。 */
export const MEMORY_LONG_TERM_MERGE_GROUP = 'memory_long_term';

/** 跨会话长期记忆每轮注入提示词的最大条数，读侧窗口与注入上限保持一致。 */
export const MEMORY_LONG_TERM_INJECT_LIMIT = 8;

/** candidate 记忆的合并组前缀（后接内容指纹）。 */
export const MEMORY_CANDIDATE_MERGE_GROUP_PREFIX = 'memory_candidate';

/** metadata 中记录决策类型的字段名。 */
export const MEMORY_METADATA_DECISION = 'decisionKind';

/** metadata 中记录候选语义类型的字段名。 */
export const MEMORY_METADATA_CANDIDATE_TYPE = 'candidateType';

/** metadata 中记录 candidate 复现次数的字段名。 */
export const MEMORY_METADATA_OBSERVED_COUNT = 'observedCount';

/** metadata 中记录 5 维评分的字段名。 */
export const MEMORY_METADATA_DIMENSIONS = 'dimensions';

/** metadata 中记录 constraint 抽取来源的字段名（rule=规则快通道 / llm=LLM 慢通道）。 */
export const MEMORY_METADATA_CONSTRAINT_SOURCE = 'constraintSource';
