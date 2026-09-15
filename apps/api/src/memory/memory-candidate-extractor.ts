import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  hasDashscopeChatConfig,
  requestDashscopeChat,
} from '../common/llm/dashscope-chat.client';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import {
  MEMORY_CANDIDATE_TYPES,
  type MemoryCandidate,
  type MemoryCandidateType,
  type MemoryDimensionScores,
} from './memory-candidate.types';

/** 单次抽取允许返回的最大候选数。 */
const MAX_CANDIDATES = 5;

/** 单条候选记忆文本的长度上限。 */
const MAX_CANDIDATE_CONTENT_LENGTH = 500;

/** 单条候选证据片段的长度上限。 */
const MAX_EVIDENCE_LENGTH = 200;

/** 传给 LLM 的原始消息长度上限，避免超长上下文。 */
const MAX_SOURCE_LENGTH = 4_000;

/** 低于该长度的用户消息视为无记忆价值（寒暄/续写等），直接跳过抽取。 */
const MIN_EXTRACTABLE_USER_MESSAGE_LENGTH = 6;

const scoreSchema = z.coerce.number().catch(0);

const dimensionScoresSchema = z.object({
  persistenceIntent: scoreSchema,
  stability: scoreSchema,
  reusability: scoreSchema,
  importance: scoreSchema,
  freshness: scoreSchema,
});

const rawCandidateSchema = z.object({
  type: z.string().optional(),
  content: z.string().optional(),
  evidence: z.string().optional(),
  scores: dimensionScoresSchema.optional(),
});

/**
 * 记忆候选抽取器：从一轮"用户消息 + 助手回复"中抽取值得长期记忆的候选，
 * 并给出 5 个维度的评分（persistence intent / stability / reusability /
 * importance / freshness）。
 *
 * 该抽取器是"慢通道"，在助手回复完成后异步调用，不阻塞主链路。
 * 任何失败（未配置 Dashscope、网络错误、JSON 解析失败等）都降级为空数组，
 * 绝不能影响本轮对话响应。
 */
@Injectable()
export class MemoryCandidateExtractor {
  private readonly logger = new Logger(MemoryCandidateExtractor.name);

  /**
   * 抽取记忆候选。
   *
   * @param input 一轮完整的用户消息与助手回复
   * @returns 归一化后的候选列表；失败或无需记忆时返回空数组
   */
  async extract(input: {
    userMessage: string;
    assistantMessage: string;
  }): Promise<MemoryCandidate[]> {
    const userMessage = input.userMessage.trim();
    if (userMessage.length < MIN_EXTRACTABLE_USER_MESSAGE_LENGTH) {
      return [];
    }

    if (!hasDashscopeChatConfig()) {
      return [];
    }

    try {
      const response = await requestDashscopeChat([
        { role: 'system', content: this.buildSystemPrompt() },
        {
          role: 'user',
          content: JSON.stringify({
            userMessage: this.truncate(userMessage, MAX_SOURCE_LENGTH),
            assistantMessage: this.truncate(
              input.assistantMessage.trim(),
              MAX_SOURCE_LENGTH,
            ),
          }),
        },
      ]);

      const content = response.choices?.[0]?.message?.content?.trim();
      if (!content) {
        return [];
      }

      return this.parseCandidates(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(`Memory candidate extraction skipped: ${message}`);
      return [];
    }
  }

  /** 解析 LLM 返回的 JSON，逐条校验并归一化，跳过非法条目。 */
  private parseCandidates(content: string): MemoryCandidate[] {
    let payload: { candidates?: unknown };
    try {
      payload = LlmSanitizer.parseJsonObject<{ candidates?: unknown }>(content);
    } catch {
      return [];
    }

    if (!Array.isArray(payload.candidates)) {
      return [];
    }

    const candidates: MemoryCandidate[] = [];
    for (const raw of payload.candidates) {
      const parsed = rawCandidateSchema.safeParse(raw);
      if (!parsed.success) {
        continue;
      }

      const candidate = this.toCandidate(parsed.data);
      if (candidate) {
        candidates.push(candidate);
      }

      if (candidates.length >= MAX_CANDIDATES) {
        break;
      }
    }

    return candidates;
  }

  /** 将校验后的原始条目归一化为 MemoryCandidate。 */
  private toCandidate(raw: {
    type?: string;
    content?: string;
    evidence?: string;
    scores?: {
      persistenceIntent: number;
      stability: number;
      reusability: number;
      importance: number;
      freshness: number;
    };
  }): MemoryCandidate | null {
    const content = (raw.content ?? '').replace(/\s+/g, ' ').trim();
    if (!content) {
      return null;
    }

    const type = MEMORY_CANDIDATE_TYPES.includes(
      raw.type as MemoryCandidateType,
    )
      ? (raw.type as MemoryCandidateType)
      : 'other';

    return {
      type,
      content: this.truncate(content, MAX_CANDIDATE_CONTENT_LENGTH),
      evidence: this.truncate(
        (raw.evidence ?? '').replace(/\s+/g, ' ').trim(),
        MAX_EVIDENCE_LENGTH,
      ),
      scores: this.normalizeScores(raw.scores),
    };
  }

  /** 将 5 维评分裁剪到 [0, 1]；缺失时按 0 处理。 */
  private normalizeScores(
    scores:
      | {
          persistenceIntent: number;
          stability: number;
          reusability: number;
          importance: number;
          freshness: number;
        }
      | undefined,
  ): MemoryDimensionScores {
    if (!scores) {
      return {
        persistenceIntent: 0,
        stability: 0,
        reusability: 0,
        importance: 0,
        freshness: 0,
      };
    }

    return {
      persistenceIntent: this.clamp01(scores.persistenceIntent),
      stability: this.clamp01(scores.stability),
      reusability: this.clamp01(scores.reusability),
      importance: this.clamp01(scores.importance),
      freshness: this.clamp01(scores.freshness),
    };
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.min(1, Math.max(0, value));
  }

  private truncate(value: string, limit: number): string {
    if (value.length <= limit) {
      return value;
    }

    return value.slice(0, limit);
  }

  private buildSystemPrompt(): string {
    return [
      'You are a long-term memory extraction assistant for a career-assistant chatbot.',
      'Given one completed user/assistant exchange, extract only durable memories worth remembering across turns.',
      '',
      'Extract these kinds only:',
      '- constraint: explicit instructions/rules the user wants followed (identity, prohibitions, hard requirements).',
      '- profile: stable facts about the user (role, industry, location, experience, goals).',
      '- fact: stable factual information useful later.',
      '- decision: a decision or conclusion reached in the conversation.',
      '- task_state: ongoing task progress worth resuming later.',
      '',
      'Do NOT extract:',
      '- response style preferences (language, tone, length, formatting) — handled by another subsystem.',
      "- greetings, small talk, transient questions, or the assistant's own content.",
      '- anything not grounded in the user message.',
      '',
      'Each item must be self-contained (understandable without the original conversation).',
      'Return at most 5 items. If nothing is worth remembering, return {"candidates":[]}.',
      '',
      'For each candidate, score five dimensions in [0,1]:',
      '- persistenceIntent: user intent to keep this long-term ("以后/记住/always").',
      '- stability: how stable the fact is (residence/job high; a passing mood low).',
      '- reusability: usefulness across sessions and tasks.',
      '- importance: impact on future answers.',
      '- freshness: time-sensitivity (an explicit deadline scores high).',
      '',
      'Return valid JSON only. Do not wrap JSON in markdown fences.',
      'Schema:',
      '{"candidates":[{"type":"constraint|profile|fact|decision|task_state|other","content":"...","evidence":"...","scores":{"persistenceIntent":0.0,"stability":0.0,"reusability":0.0,"importance":0.0,"freshness":0.0}}]}',
    ].join('\n');
  }
}
