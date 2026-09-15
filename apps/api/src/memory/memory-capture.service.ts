import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { MemoryCandidateExtractor } from './memory-candidate-extractor';
import {
  CANDIDATE_PROMOTION_OBSERVED_COUNT,
  CANDIDATE_TTL_MS,
  MEMORY_CANDIDATE_MERGE_GROUP_PREFIX,
  MEMORY_CONSTRAINT_LIMIT,
  MEMORY_CONSTRAINT_MERGE_GROUP,
  MEMORY_LONG_TERM_MERGE_GROUP,
  MEMORY_METADATA_CANDIDATE_TYPE,
  MEMORY_METADATA_CONSTRAINT_SOURCE,
  MEMORY_METADATA_DECISION,
  MEMORY_METADATA_DIMENSIONS,
  MEMORY_METADATA_OBSERVED_COUNT,
  type MemoryCandidate,
  type MemoryDecision,
} from './memory-candidate.types';
import {
  extractMemoryConstraintCandidates,
  type MemoryConstraintCandidate,
} from './memory-constraint-extractor';
import { MemoryDecisionService } from './memory-decision.service';
import { LongTermMemoryStore, MemoryStore } from './memory.store';
import type { MemoryEntry, MemorySourceRef } from './memory.types';

/** 记忆捕获输入：一轮已完成的用户/助手消息。 */
export interface MemoryCaptureInput {
  userId: string;
  conversationId: string;
  runId?: string | null;
  /** 触发本轮的原始用户消息 id，用于溯源。 */
  userMessageId?: string | null;
  userMessage: string;
  assistantMessage: string;
}

/**
 * 记忆捕获编排器。对外提供两个入口：
 *
 * - {@link captureConstraints}（快通道）：规则抽取硬约束并同步写入，当轮生效；
 * - {@link capture}（慢通道）：LLM 抽取候选 → 决策分流 → 三路落点：
 *   - constraint → preference 层（Runtime Context，每轮注入）；
 *   - persistent → Long-term Memory（跨会话）；
 *   - candidate → candidate 层（观察期，复现达阈值后升级为 persistent）；
 *   - discard → 丢弃。
 *
 * 慢通道在助手回复完成后异步调用，任何异常只记录日志，不影响主链路。
 */
@Injectable()
export class MemoryCaptureService {
  private readonly logger = new Logger(MemoryCaptureService.name);

  constructor(
    private readonly extractor: MemoryCandidateExtractor,
    private readonly decisionService: MemoryDecisionService,
    private readonly memoryStore: MemoryStore,
    private readonly longTermMemoryStore: LongTermMemoryStore,
  ) {}

  /**
   * 捕获一轮对话中值得记忆的内容。
   */
  async capture(input: MemoryCaptureInput): Promise<void> {
    const candidates = await this.extractor.extract({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
    });
    if (candidates.length === 0) {
      return;
    }

    const decisions = candidates.map((candidate) =>
      this.decisionService.decide(candidate),
    );

    for (const decision of decisions) {
      try {
        await this.applyDecision(input, decision);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'unknown_error';
        this.logger.warn(
          `Memory capture failed: kind=${decision.kind} error=${message}`,
        );
      }
    }
  }

  /**
   * Constraint 快通道：规则抽取硬约束并同步写入，保证当轮即可注入 Runtime Context。
   *
   * 与慢通道的差别：
   * - 零 LLM 调用（纯正则 + 一次读取 + 一次写入），可安全地 await 在请求主链路上；
   * - 每条约束独立成行，不做合并（mergeStrategy 为 null），读侧按更新时间聚合注入。
   *
   * 任何异常都只记录日志：约束捕获失败绝不能影响本轮对话。
   */
  async captureConstraints(input: {
    conversationId: string;
    runId?: string | null;
    userMessageId?: string | null;
    userMessage: string;
  }): Promise<void> {
    try {
      const candidates = extractMemoryConstraintCandidates({
        content: input.userMessage,
      });
      if (candidates.length === 0) {
        return;
      }

      const existing = await this.memoryStore.list({
        conversationId: input.conversationId,
        layer: 'preference',
        mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
        orderBy: {
          field: 'updatedAt',
          direction: 'desc',
        },
        limit: MEMORY_CONSTRAINT_LIMIT,
      });

      const known = this.constraintFingerprints(existing);

      await Promise.all(
        candidates
          .filter(
            (candidate) => !known.has(this.fingerprint(candidate.content)),
          )
          .map((candidate) => this.writeFastConstraint(input, candidate)),
      );

      await this.pruneConstraints(input.conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(`Memory constraint capture skipped: ${message}`);
    }
  }

  /**
   * 约束行保留上限：超出注入窗口的旧约束按更新时间淘汰。
   * 这些行本来就落在注入窗口之外，删除不改变模型可见的上下文，
   * 但能避免 preference 层被单会话的约束行无限撑大。
   */
  private async pruneConstraints(conversationId: string): Promise<void> {
    const rows = await this.memoryStore.list({
      conversationId,
      layer: 'preference',
      mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: MEMORY_CONSTRAINT_LIMIT * 2,
    });

    if (rows.length <= MEMORY_CONSTRAINT_LIMIT) {
      return;
    }

    await this.memoryStore.deleteMany({
      conversationId,
      memoryIds: rows.slice(MEMORY_CONSTRAINT_LIMIT).map((row) => row.memoryId),
    });
  }

  /** 约束行的内容指纹集合（合并行可能包含多条约束，需逐行比对）。 */
  private constraintFingerprints(
    memories: Array<{ content: string; summary: string | null }>,
  ): Set<string> {
    const fingerprints = new Set<string>();

    for (const memory of memories) {
      for (const line of `${memory.content}\n${memory.summary ?? ''}`.split(
        '\n',
      )) {
        const trimmed = line.trim();
        if (trimmed) {
          fingerprints.add(this.fingerprint(trimmed));
        }
      }
    }

    return fingerprints;
  }

  /** 单条快通道约束 → preference 层独立记忆行（不合并、不调用 LLM）。 */
  private async writeFastConstraint(
    input: {
      conversationId: string;
      runId?: string | null;
      userMessageId?: string | null;
    },
    candidate: MemoryConstraintCandidate,
  ): Promise<void> {
    await this.memoryStore.write({
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      layer: 'preference',
      scope: 'conversation',
      content: candidate.content,
      summary: candidate.content,
      tokenEstimate: this.estimateTokens(candidate.content),
      freshnessScore: 1,
      relevanceScore: 1,
      mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
      mergeStrategy: null,
      metadata: {
        [MEMORY_METADATA_DECISION]: 'constraint',
        [MEMORY_METADATA_CONSTRAINT_SOURCE]: 'rule',
      },
      sourceRefs: input.userMessageId
        ? [
            {
              kind: 'conversation_message',
              sourceId: input.userMessageId,
              fragment: candidate.fragment,
              title: null,
              metadata: null,
            },
          ]
        : [],
    });
  }

  /** 按决策结果写入对应落点。 */
  private async applyDecision(
    input: MemoryCaptureInput,
    decision: MemoryDecision,
  ): Promise<void> {
    switch (decision.kind) {
      case 'constraint':
        await this.writeConstraint(input, decision.candidate);
        return;
      case 'persistent':
        await this.writePersistent(input, decision.candidate);
        return;
      case 'candidate':
        await this.writeOrPromoteCandidate(input, decision.candidate);
        return;
      default:
        return;
    }
  }

  /** Constraint → preference 层，按 mergeGroup 累积压缩，每轮注入。 */
  private async writeConstraint(
    input: MemoryCaptureInput,
    candidate: MemoryCandidate,
  ): Promise<void> {
    // 已在约束行中的内容不再重复写入：慢通道每轮都可能抽到同一条约束，
    // 重复写入会触发无意义的 summarize 合并，并在读侧产生重复行。
    const existing = await this.memoryStore.list({
      conversationId: input.conversationId,
      layer: 'preference',
      mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
      orderBy: {
        field: 'updatedAt',
        direction: 'desc',
      },
      limit: MEMORY_CONSTRAINT_LIMIT,
    });

    if (
      this.constraintFingerprints(existing).has(
        this.fingerprint(candidate.content),
      )
    ) {
      return;
    }

    await this.memoryStore.write({
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      layer: 'preference',
      scope: 'conversation',
      content: candidate.content,
      summary: candidate.content,
      tokenEstimate: this.estimateTokens(candidate.content),
      priority: this.toPriority(candidate),
      freshnessScore: candidate.scores.freshness,
      relevanceScore: candidate.scores.reusability,
      mergeGroup: MEMORY_CONSTRAINT_MERGE_GROUP,
      mergeStrategy: 'summarize',
      metadata: {
        ...this.buildMetadata('constraint', candidate),
        [MEMORY_METADATA_CONSTRAINT_SOURCE]: 'llm',
      },
      sourceRefs: this.buildSourceRefs(input, candidate),
    });
  }

  /** Persistent → Long-term Memory，按内容指纹幂等去重。 */
  private async writePersistent(
    input: MemoryCaptureInput,
    candidate: MemoryCandidate,
  ): Promise<void> {
    const mergeGroup = `${MEMORY_LONG_TERM_MERGE_GROUP}:${this.fingerprint(
      candidate.content,
    )}`;

    const existing = await this.longTermMemoryStore.list({
      userId: input.userId,
      mergeGroup,
      limit: 1,
    });
    if (existing.length > 0) {
      return;
    }

    await this.longTermMemoryStore.save(
      input.userId,
      this.buildLongTermEntry(input, candidate, mergeGroup),
    );
  }

  /**
   * Candidate → 观察期（L3 长期记忆层，按 userId 归属）；同名候选复现达到阈值后
   * 升级为 Long-term Memory，并移除观察期条目。
   *
   * 观察期以 userId 归属而非 conversationId：升级目标本身是跨会话的长期记忆，
   * 若按会话隔离，用户在另一个会话重复提到同一事实永远不会被升级。
   */
  private async writeOrPromoteCandidate(
    input: MemoryCaptureInput,
    candidate: MemoryCandidate,
  ): Promise<void> {
    const mergeGroup = `${MEMORY_CANDIDATE_MERGE_GROUP_PREFIX}:${this.fingerprint(
      candidate.content,
    )}`;

    const [existing] = await this.longTermMemoryStore.list({
      userId: input.userId,
      layer: 'candidate',
      mergeGroup,
      limit: 1,
    });

    if (!existing) {
      await this.longTermMemoryStore.save(
        input.userId,
        this.buildCandidateEntry(input, candidate, mergeGroup, 1),
      );
      return;
    }

    const observedCount =
      this.toPositiveInt(existing.metadata?.[MEMORY_METADATA_OBSERVED_COUNT]) +
      1;

    // 复现达阈值：升级为长期记忆，并清理观察期条目。
    if (observedCount >= CANDIDATE_PROMOTION_OBSERVED_COUNT) {
      await this.promoteCandidate(input, existing, candidate);
      return;
    }

    await this.longTermMemoryStore.save(
      input.userId,
      this.buildCandidateEntry(input, candidate, mergeGroup, observedCount, {
        memoryId: existing.memoryId,
        content: existing.content,
        summary: existing.summary,
        tokenEstimate: existing.tokenEstimate,
        priority: existing.priority,
        createdAt: existing.createdAt,
      }),
    );
  }

  /** 构造观察期候选条目（scope 固定为 user，带 TTL），复现时保留原条目 id 与创建时间。 */
  private buildCandidateEntry(
    input: MemoryCaptureInput,
    candidate: MemoryCandidate,
    mergeGroup: string,
    observedCount: number,
    previous?: Pick<
      MemoryEntry,
      | 'memoryId'
      | 'content'
      | 'summary'
      | 'tokenEstimate'
      | 'priority'
      | 'createdAt'
    >,
  ): MemoryEntry {
    const now = new Date();

    return {
      memoryId:
        previous?.memoryId ??
        `um_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      layer: 'candidate',
      scope: 'user',
      content: previous?.content ?? candidate.content,
      summary: previous?.summary ?? candidate.content,
      tokenEstimate:
        previous?.tokenEstimate ?? this.estimateTokens(candidate.content),
      priority: previous?.priority ?? this.toPriority(candidate),
      pinned: false,
      freshnessScore: candidate.scores.freshness,
      relevanceScore: candidate.scores.reusability,
      sourceRefs: this.buildSourceRefs(input, candidate),
      mergeGroup,
      mergeStrategy: null,
      version: 1,
      metadata: {
        ...this.buildMetadata('candidate', candidate),
        [MEMORY_METADATA_OBSERVED_COUNT]: observedCount,
      },
      expiresAt: new Date(Date.now() + CANDIDATE_TTL_MS),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
    };
  }

  /** 将观察期候选升级为长期记忆，并删除原 candidate 条目。 */
  private async promoteCandidate(
    input: MemoryCaptureInput,
    existing: MemoryEntry,
    candidate: MemoryCandidate,
  ): Promise<void> {
    const mergeGroup = `${MEMORY_LONG_TERM_MERGE_GROUP}:${this.fingerprint(
      candidate.content,
    )}`;
    const promoted = await this.longTermMemoryStore.list({
      userId: input.userId,
      mergeGroup,
      limit: 1,
    });

    if (promoted.length === 0) {
      await this.longTermMemoryStore.save(
        input.userId,
        this.buildLongTermEntry(input, candidate, mergeGroup),
      );
    }

    await this.longTermMemoryStore.delete(existing.memoryId);
  }

  /** 构造长期记忆条目（scope 固定为 user）。 */
  private buildLongTermEntry(
    input: MemoryCaptureInput,
    candidate: MemoryCandidate,
    mergeGroup: string,
  ): MemoryEntry {
    const now = new Date();

    return {
      memoryId: `um_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      conversationId: input.conversationId,
      runId: input.runId ?? null,
      layer: this.resolveLongTermLayer(candidate),
      scope: 'user',
      content: candidate.content,
      summary: candidate.content,
      tokenEstimate: this.estimateTokens(candidate.content),
      priority: this.toPriority(candidate),
      pinned: false,
      freshnessScore: candidate.scores.freshness,
      relevanceScore: candidate.scores.reusability,
      sourceRefs: this.buildSourceRefs(input, candidate),
      mergeGroup,
      mergeStrategy: 'replace',
      version: 1,
      metadata: this.buildMetadata('persistent', candidate),
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: null,
      accessCount: 0,
    };
  }

  /** 长期记忆的 layer 归桶：约束/画像/事实归 preference，其余归 session。 */
  private resolveLongTermLayer(
    candidate: MemoryCandidate,
  ): MemoryEntry['layer'] {
    if (
      candidate.type === 'constraint' ||
      candidate.type === 'profile' ||
      candidate.type === 'fact'
    ) {
      return 'preference';
    }

    return 'session';
  }

  /** 将 5 维评分写入 metadata，供溯源与调优。 */
  private buildMetadata(
    decisionKind: string,
    candidate: MemoryCandidate,
  ): Record<string, unknown> {
    return {
      [MEMORY_METADATA_DECISION]: decisionKind,
      [MEMORY_METADATA_CANDIDATE_TYPE]: candidate.type,
      [MEMORY_METADATA_DIMENSIONS]: { ...candidate.scores },
    };
  }

  private buildSourceRefs(
    input: MemoryCaptureInput,
    candidate: MemoryCandidate,
  ): MemorySourceRef[] {
    if (!input.userMessageId) {
      return [];
    }

    return [
      {
        kind: 'conversation_message',
        sourceId: input.userMessageId,
        fragment: candidate.evidence || candidate.content,
        title: null,
        metadata: { candidateType: candidate.type },
      },
    ];
  }

  /** 由 importance 映射到排序用的 priority（0-100）。 */
  private toPriority(candidate: MemoryCandidate): number {
    return Math.round(candidate.scores.importance * 100);
  }

  private estimateTokens(content: string): number {
    return Math.max(1, Math.ceil(content.length / 4));
  }

  private toPositiveInt(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 0;
    }

    return Math.floor(parsed);
  }

  /** 内容指纹：忽略大小写、空白与标点，用于候选去重与合并分组。 */
  private fingerprint(content: string): string {
    const normalized = content.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    let hash = 5381;
    for (let index = 0; index < normalized.length; index += 1) {
      hash = ((hash << 5) + hash + normalized.charCodeAt(index)) >>> 0;
    }

    return hash.toString(36);
  }
}
