import { Injectable, Optional } from '@nestjs/common';
import {
  hasDashscopeChatConfig,
  requestDashscopeChat,
} from '../common/llm/dashscope-chat.client';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import { mergeContent, mergeMetadata } from './memory-merge.util';
import type {
  MemoryCompactionMode,
  MemorySourceRef,
  MemorySummarizeInput,
  MemorySummarizeResult,
  MemorySummarizer,
} from './memory.types';

/**
 * NestJS 依赖注入令牌，用于区分 MemorySummarizer 的具体实现。
 * 通过 Symbol 保证唯一性，避免与其他注入令牌冲突。
 */
export const MEMORY_SUMMARIZER = Symbol('MEMORY_SUMMARIZER');

/**
 * 内容长度阈值：合并后的内容超过该长度时触发压缩。
 */
const DEFAULT_MAX_CONTENT_LENGTH = 2_000;

/**
 * 摘要长度上限：生成摘要时的最大字符数。
 */
const DEFAULT_SUMMARY_LENGTH = 280;

/**
 * LLM 返回的 JSON 载荷结构，content 与 summary 均要求为字符串。
 */
interface LlmSummaryPayload {
  content?: unknown;
  summary?: unknown;
}

export interface DefaultMemorySummarizerOptions {
  maxContentLength?: number;
  summaryLength?: number;
}

/**
 * 默认记忆摘要器实现。
 *
 * 当记忆条目的 mergeStrategy 为 'summarize' 时，由 MemoryStoreFacade 调用本类，
 * 将旧条目与新写入合并为一条紧凑的记忆条目。合并策略分三级：
 *
 * - pass-through：合并后内容未超过阈值，直接拼接并透传摘要，不做任何压缩；
 * - llm：内容超阈值且 Dashscope 已配置，调用 LLM 压缩并生成摘要；
 * - fallback：内容超阈值但 LLM 不可用或调用失败，退化为确定性截断压缩。
 */
@Injectable()
export class DefaultMemorySummarizer implements MemorySummarizer {
  constructor(
    @Optional() private readonly options: DefaultMemorySummarizerOptions = {},
  ) {}

  /**
   * 合并旧条目与新写入，返回压缩后的记忆内容。
   *
   * 流程：先合并 content / sourceRefs / metadata，再根据合并后内容长度与
   * LLM 可用性，决定走 pass-through（透传）、llm（LLM 压缩）还是 fallback（截断压缩）。
   */
  async summarize(input: MemorySummarizeInput): Promise<MemorySummarizeResult> {
    // 1. 合并内容：新旧内容以换行拼接，空内容自动跳过。
    const mergedContent = mergeContent(
      input.previous.content,
      input.incoming.content,
    );
    // 2. 合并来源引用：新旧 sourceRefs 合并并按 (kind, sourceId, ...) 去重。
    const mergedSourceRefs = this.mergeSourceRefs(
      input.previous.sourceRefs,
      input.incoming.sourceRefs ?? [],
    );
    // 3. 合并元数据：浅合并，incoming 的同名 key 覆盖 previous。
    const mergedMetadata = mergeMetadata(
      input.previous.metadata,
      input.incoming.metadata,
    );

    // 4a. 轻量合并：内容未超阈值，直接透传，不调用 LLM。
    if (mergedContent.length <= this.maxContentLength) {
      return this.createResult({
        content: mergedContent,
        summary: this.resolvePassThroughSummary(input, mergedContent),
        previousTokenEstimate: input.previous.tokenEstimate,
        incomingTokenEstimate: input.incoming.tokenEstimate,
        incomingContent: input.incoming.content,
        incomingSummary: input.incoming.summary ?? null,
        sourceRefs: mergedSourceRefs,
        metadata: mergedMetadata,
        compactionMode: 'pass-through',
        compactedAt: input.now,
      });
    }

    // 4b. LLM 合并：尝试调用 LLM 压缩；失败（无配置/异常/空结果）时返回 null。
    const llmResult = await this.trySummarizeWithLlm(
      input,
      mergedContent,
      mergedSourceRefs,
      mergedMetadata,
    );
    if (llmResult) {
      return llmResult;
    }

    // 4c. 降级合并：LLM 不可用时做确定性截断压缩，保证合并始终可完成。
    return this.createResult({
      content: this.compactContent(mergedContent),
      summary: this.buildFallbackSummary(input),
      previousTokenEstimate: input.previous.tokenEstimate,
      incomingTokenEstimate: input.incoming.tokenEstimate,
      incomingContent: input.incoming.content,
      incomingSummary: input.incoming.summary ?? null,
      sourceRefs: mergedSourceRefs,
      metadata: mergedMetadata,
      compactionMode: 'fallback',
      compactedAt: input.now,
    });
  }

  /**
   * 尝试调用 LLM 压缩超长记忆内容。
   *
   * 任何失败场景（未配置 Dashscope、网络错误、返回空内容、JSON 解析失败等）
   * 都会捕获并返回 null，由调用方降级到 fallback 模式，保证合并不中断。
   */
  private async trySummarizeWithLlm(
    input: MemorySummarizeInput,
    mergedContent: string,
    mergedSourceRefs: MemorySourceRef[],
    mergedMetadata: Record<string, unknown> | null,
  ): Promise<MemorySummarizeResult | null> {
    // 未配置 API key / 模型时直接跳过 LLM。
    if (!hasDashscopeChatConfig()) {
      return null;
    }

    try {
      const response = await requestDashscopeChat([
        {
          role: 'system',
          // System prompt：要求只输出 JSON、保留关键事实、输出固定结构。
          content: [
            'You are an expert memory compaction assistant.',
            'Return valid JSON only.',
            'Do not wrap JSON in markdown fences.',
            'Preserve factual details, decisions, numbers, names, and open questions.',
            'Remove repetition and compress the memory into a concise form.',
            'Output schema:',
            '{"content":"...","summary":"..."}',
          ].join(' '),
        },
        {
          role: 'user',
          // 将新旧条目完整上下文（含内容、摘要、token 估算、来源、元数据）
          // 序列化为 JSON 传给 LLM，并附上合并预览与长度限制。
          content: JSON.stringify({
            mode: 'summarize',
            maxContentLength: this.maxContentLength,
            summaryLength: this.summaryLength,
            previous: {
              content: input.previous.content,
              summary: input.previous.summary,
              tokenEstimate: input.previous.tokenEstimate,
              sourceRefs: input.previous.sourceRefs,
              metadata: input.previous.metadata,
            },
            incoming: {
              content: input.incoming.content,
              summary: input.incoming.summary ?? null,
              tokenEstimate: input.incoming.tokenEstimate ?? null,
              sourceRefs: input.incoming.sourceRefs ?? [],
              metadata: input.incoming.metadata ?? null,
            },
            mergedPreview: mergedContent,
          }),
        },
      ]);

      const content = response.choices?.[0]?.message?.content?.trim();
      if (!content) {
        return null;
      }

      // 解析 LLM 返回的 JSON，并清洗字段。
      const parsed = LlmSanitizer.parseJsonObject<LlmSummaryPayload>(content);
      // content 必须非空且被截断到阈值内，否则视为无效结果。
      const llmContent = this.normalizeContent(
        LlmSanitizer.toOptionalText(parsed.content) ?? '',
        this.maxContentLength,
      );
      if (!llmContent) {
        return null;
      }

      // summary 缺失时，从压缩后的 content 中截取摘要。
      const llmSummary =
        LlmSanitizer.toOptionalText(parsed.summary) ??
        this.buildExcerpt(llmContent, this.summaryLength);

      return this.createResult({
        content: llmContent,
        summary: llmSummary,
        previousTokenEstimate: input.previous.tokenEstimate,
        incomingTokenEstimate: input.incoming.tokenEstimate,
        incomingContent: input.incoming.content,
        incomingSummary: input.incoming.summary ?? null,
        sourceRefs: mergedSourceRefs,
        metadata: mergedMetadata,
        compactionMode: 'llm',
        compactedAt: input.now,
      });
    } catch {
      // LLM 不可用或调用出错：降级到 fallback，不向上抛错。
      return null;
    }
  }

  /**
   * 组装最终返回结果，并计算压缩前后的 token 估算。
   *
   * token 估算规则：
   * - pass-through：token 数 = 旧条目 token + 新写入 token（累加）；
   * - llm / fallback：token 数 = 取「累加值」与「压缩后估算值」的较小者，
   *   以反映压缩带来的节省。
   */
  private createResult(input: {
    content: string;
    summary: string | null;
    previousTokenEstimate: number;
    incomingTokenEstimate: number | undefined;
    incomingContent: string;
    incomingSummary: string | null;
    sourceRefs: MemorySourceRef[];
    metadata: Record<string, unknown> | null;
    compactionMode: MemoryCompactionMode;
    compactedAt: Date;
  }): MemorySummarizeResult {
    // 新写入未提供 token 数时，按内容长度粗略估算（每 4 字符 ≈ 1 token）。
    const incomingTokenEstimate =
      input.incomingTokenEstimate ??
      this.estimateTokens(input.incomingContent, input.incomingSummary);
    // 不压缩情况下的预估 token 总量。
    const mergedTokenEstimate =
      input.previousTokenEstimate + incomingTokenEstimate;
    // 压缩后内容的 token 估算。
    const compactedTokenEstimate = this.estimateTokens(
      input.content,
      input.summary,
    );

    return {
      content: input.content,
      summary: input.summary,
      tokenEstimate:
        input.compactionMode === 'pass-through'
          ? mergedTokenEstimate
          : Math.min(mergedTokenEstimate, compactedTokenEstimate),
      sourceRefs: input.sourceRefs,
      // 在 metadata 中记录本次压缩的模式与时间，供溯源和前端展示。
      metadata: this.withCompactionMetadata(
        input.metadata,
        input.compactionMode,
        input.compactedAt,
      ),
      compactionMode: input.compactionMode,
    };
  }

  /**
   * pass-through 模式下的摘要解析优先级：
   * 1. 新写入显式提供的 summary（含 null，表示清空摘要）；
   * 2. 旧条目已有的 summary；
   * 3. 都没有时，从合并后内容中截取前 summaryLength 个字符作为摘要。
   */
  private resolvePassThroughSummary(
    input: MemorySummarizeInput,
    mergedContent: string,
  ): string | null {
    if (input.incoming.summary !== undefined) {
      return input.incoming.summary;
    }

    if (input.previous.summary !== null) {
      return input.previous.summary;
    }

    return this.buildExcerpt(mergedContent, this.summaryLength);
  }

  /**
   * fallback 模式下的摘要生成：从多个候选片段（新旧 summary、新旧内容截断）中
   * 取非空去重片段，用 " | " 连接后截断到摘要长度。
   * 无法凑出任何片段时返回 null。
   */
  private buildFallbackSummary(input: MemorySummarizeInput): string | null {
    const parts = this.uniqueNonEmpty([
      input.incoming.summary,
      input.previous.summary,
      this.buildExcerpt(input.previous.content, 120),
      this.buildExcerpt(input.incoming.content, 120),
    ]);

    if (parts.length === 0) {
      return null;
    }

    return this.buildExcerpt(parts.join(' | '), this.summaryLength);
  }

  /**
   * 将超长内容截断到 maxContentLength，作为 fallback 的压缩后内容。
   */
  private compactContent(content: string): string {
    return this.buildExcerpt(content, this.maxContentLength);
  }

  /**
   * 将 LLM 返回的 content 规范化：截断到阈值内。
   */
  private normalizeContent(value: string, limit: number): string {
    return this.buildExcerpt(value, limit);
  }

  /**
   * 合并新旧 sourceRefs：先深拷贝（避免共享引用），再按
   * (kind, sourceId, fragment, title) 组合键去重，保留首次出现的记录。
   */
  private mergeSourceRefs(
    previous: MemorySourceRef[],
    next: MemorySourceRef[],
  ): MemorySourceRef[] {
    const merged = [...previous, ...next].map((sourceRef) => ({
      ...sourceRef,
      metadata: sourceRef.metadata ? { ...sourceRef.metadata } : null,
    }));
    const deduped = new Map<string, MemorySourceRef>();

    for (const sourceRef of merged) {
      const key = [
        sourceRef.kind,
        sourceRef.sourceId,
        sourceRef.fragment ?? '',
        sourceRef.title ?? '',
      ].join(':');

      if (!deduped.has(key)) {
        deduped.set(key, sourceRef);
      }
    }

    return Array.from(deduped.values());
  }

  /**
   * 将压缩信息（模式、时间）写入 metadata，供溯源与前端展示。
   */
  private withCompactionMetadata(
    metadata: Record<string, unknown> | null,
    compactionMode: MemoryCompactionMode,
    compactedAt: Date,
  ): Record<string, unknown> {
    return {
      ...(metadata ?? {}),
      compactionMode,
      compactedAt: compactedAt.toISOString(),
    };
  }

  /**
   * 粗略估算 token 数：按字符长度 / 4 向上取整，至少为 1。
   */
  private estimateTokens(content: string, summary: string | null): number {
    const totalLength = content.length + (summary?.length ?? 0);
    return Math.max(1, Math.ceil(totalLength / 4));
  }

  /**
   * 生成截断文本：压缩连续空白、去首尾空格，超长时截断并在末尾加省略号。
   */
  private buildExcerpt(value: string, limit: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }

    if (normalized.length <= limit) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
  }

  /**
   * 过滤空值并按原始顺序去重，返回非空字符串数组。
   */
  private uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => value?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    );
  }

  /**
   * 内容长度阈值，支持通过 options 覆盖默认值。
   */
  private get maxContentLength(): number {
    return this.options.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  }

  /**
   * 摘要长度上限，支持通过 options 覆盖默认值。
   */
  private get summaryLength(): number {
    return this.options.summaryLength ?? DEFAULT_SUMMARY_LENGTH;
  }
}
