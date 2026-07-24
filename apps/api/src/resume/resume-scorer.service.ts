import { Injectable } from '@nestjs/common';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import type { GenerateResumeDto } from './dto/generate-resume.dto';
import type { AiResumeVariant } from './resume.ai.service';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DashscopeChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface RuleScoreResult {
  score: number;
  dimensions: ResumeScoreDimensions;
  issues: string[];
  suggestions: string[];
}

interface LlmScoreResult {
  score: number;
  dimensions: ResumeScoreDimensions;
  issues: string[];
  suggestions: string[];
}

export interface ResumeScoreDimensions {
  readability: number;
  measurability: number;
  roleRelevance: number;
}

export interface ResumeVariantScore {
  ruleScore: number;
  llmScore: number;
  overallScore: number;
  dimensions: ResumeScoreDimensions;
  issues: string[];
  suggestions: string[];
}

@Injectable()
export class ResumeScorerService {
  async scoreVariant(
    input: GenerateResumeDto,
    variant: AiResumeVariant,
  ): Promise<ResumeVariantScore> {
    const rule = this.scoreByRules(input, variant);
    const llm = await this.scoreByLlmJudge(input, variant);
    const llmScore = llm?.score ?? rule.score;
    const mergedDimensions = this.mergeDimensions(
      rule.dimensions,
      llm?.dimensions,
    );
    const issues = this.mergeTopUnique(rule.issues, llm?.issues ?? [], 4);
    const suggestions = this.mergeTopUnique(
      rule.suggestions,
      llm?.suggestions ?? [],
      4,
    );

    return {
      ruleScore: rule.score,
      llmScore,
      overallScore: Number((rule.score * 0.4 + llmScore * 0.6).toFixed(1)),
      dimensions: mergedDimensions,
      issues,
      suggestions,
    };
  }

  private scoreByRules(
    input: GenerateResumeDto,
    variant: AiResumeVariant,
  ): RuleScoreResult {
    const contentUnits = this.extractContentUnits(variant);
    const readability = this.scoreReadability(contentUnits);
    const measurability = this.scoreMeasurability(contentUnits);
    const roleRelevance = this.scoreRoleRelevance(input, contentUnits);
    const score = Number(
      (readability * 0.35 + measurability * 0.3 + roleRelevance * 0.35).toFixed(
        1,
      ),
    );

    const issues: string[] = [];
    const suggestions: string[] = [];
    if (readability < 70) {
      issues.push('low_readability');
      suggestions.push(
        'Use concise action-result bullets and avoid long chained clauses.',
      );
    }
    if (measurability < 65) {
      issues.push('low_measurability');
      suggestions.push(
        'Add quantified outcomes, such as %, latency, throughput, cost, or quality metrics.',
      );
    }
    if (roleRelevance < 70) {
      issues.push('low_role_relevance');
      suggestions.push(
        'Increase target-job keyword coverage in summary and highlights.',
      );
    }

    return {
      score,
      dimensions: {
        readability,
        measurability,
        roleRelevance,
      },
      issues,
      suggestions,
    };
  }

  private scoreReadability(units: string[]): number {
    if (units.length === 0) {
      return 55;
    }

    const cleaned = units
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (cleaned.length === 0) {
      return 55;
    }

    const avgLength =
      cleaned.reduce((sum, item) => sum + item.length, 0) / cleaned.length;
    const longRatio =
      cleaned.filter((item) => item.length > 120).length / cleaned.length;
    const shortRatio =
      cleaned.filter((item) => item.length < 12).length / cleaned.length;
    const base = 88;
    const lengthPenalty =
      avgLength > 80 ? Math.min((avgLength - 80) * 0.5, 16) : 0;
    const longPenalty = longRatio * 22;
    const shortPenalty = shortRatio * 10;
    return this.clampScore(base - lengthPenalty - longPenalty - shortPenalty);
  }

  private scoreMeasurability(units: string[]): number {
    if (units.length === 0) {
      return 55;
    }

    const metricPattern =
      /(\d+(\.\d+)?\s?(%|x|X|ms|s|h|day|days|week|weeks|month|months|year|years|k|K|m|M|w|万|亿))|(p95|p99|roi|gmv|dau|mau|sla|slo|latency|qps|throughput|error rate|conversion)/i;
    const matched = units.filter((item) => metricPattern.test(item)).length;
    const ratio = matched / units.length;
    return this.clampScore(52 + ratio * 48);
  }

  private scoreRoleRelevance(
    input: GenerateResumeDto,
    units: string[],
  ): number {
    const roleTokens = this.tokenize(
      [
        input.targetJob.title,
        input.targetJob.description,
        ...input.targetJob.mustHaveSkills,
        ...input.profile.skills,
      ].join(' '),
    );
    if (roleTokens.size === 0) {
      return 65;
    }

    const contentTokens = this.tokenize(units.join(' '));
    const overlap = [...roleTokens].filter((token) =>
      contentTokens.has(token),
    ).length;
    const ratio = overlap / roleTokens.size;
    return this.clampScore(58 + ratio * 42);
  }

  private async scoreByLlmJudge(
    input: GenerateResumeDto,
    variant: AiResumeVariant,
  ): Promise<LlmScoreResult | undefined> {
    if (!this.hasDashscopeConfig()) {
      return undefined;
    }

    try {
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: [
            'You are a strict resume quality judge.',
            'Return JSON only, without markdown fences.',
            'Output schema:',
            '{"score":0-100,"dimensions":{"readability":0-100,"measurability":0-100,"roleRelevance":0-100},"issues":["..."],"suggestions":["..."]}',
            'Scores must be integers from 0 to 100.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Target role: ${input.targetJob.title}`,
            `Target skills: ${input.targetJob.mustHaveSkills.join(', ') || 'N/A'}`,
            `Resume summary: ${variant.summary}`,
            `Experience highlights: ${variant.experience.flatMap((item) => item.highlights).join(' | ')}`,
            `Project highlights: ${variant.projects.flatMap((item) => item.highlights).join(' | ')}`,
            'Evaluate readability, measurability, and role relevance.',
          ].join('\n'),
        },
      ];

      const response = await this.requestDashscope(messages);
      const content = response.choices?.[0]?.message?.content?.trim();
      if (!content) {
        return undefined;
      }

      const parsed =
        LlmSanitizer.parseJsonObject<Record<string, unknown>>(content);
      const dimensionsRaw = LlmSanitizer.toRecord(parsed.dimensions);
      return {
        score: this.clampScore(
          LlmSanitizer.toOptionalNumber(parsed.score) ?? 0,
        ),
        dimensions: {
          readability: this.clampScore(
            LlmSanitizer.toOptionalNumber(dimensionsRaw.readability) ?? 0,
          ),
          measurability: this.clampScore(
            LlmSanitizer.toOptionalNumber(dimensionsRaw.measurability) ?? 0,
          ),
          roleRelevance: this.clampScore(
            LlmSanitizer.toOptionalNumber(dimensionsRaw.roleRelevance) ?? 0,
          ),
        },
        issues: LlmSanitizer.toStringArray(parsed.issues, 4),
        suggestions: LlmSanitizer.toStringArray(parsed.suggestions, 4),
      };
    } catch {
      return undefined;
    }
  }

  private async requestDashscope(
    messages: ChatMessage[],
  ): Promise<DashscopeChatResponse> {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const model = process.env.DASHSCOPE_MODEL ?? 'qwen-plus';
    const timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS ?? 20000);
    const baseUrl =
      process.env.DASHSCOPE_BASE_URL ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1';

    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `DashScope request failed: ${response.status} ${message}`,
        );
      }

      return (await response.json()) as DashscopeChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private hasDashscopeConfig(): boolean {
    return Boolean(
      process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_MODEL,
    );
  }

  private extractContentUnits(variant: AiResumeVariant): string[] {
    return [
      variant.summary,
      ...variant.experience.flatMap((item) => item.highlights),
      ...variant.projects.flatMap((item) => item.highlights),
    ]
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private tokenize(text: string): Set<string> {
    const normalized = text.toLowerCase();
    const matches = normalized.match(/[a-z0-9+#.]{2,}/g) ?? [];
    return new Set(matches);
  }

  private mergeDimensions(
    base: ResumeScoreDimensions,
    llm?: ResumeScoreDimensions,
  ): ResumeScoreDimensions {
    if (!llm) {
      return base;
    }

    return {
      readability: this.clampScore((base.readability + llm.readability) / 2),
      measurability: this.clampScore(
        (base.measurability + llm.measurability) / 2,
      ),
      roleRelevance: this.clampScore(
        (base.roleRelevance + llm.roleRelevance) / 2,
      ),
    };
  }

  private mergeTopUnique(
    primary: string[],
    secondary: string[],
    limit: number,
  ): string[] {
    return Array.from(new Set([...primary, ...secondary]))
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, limit);
  }

  private clampScore(score: number): number {
    const normalized = Number.isFinite(score) ? score : 0;
    return Math.max(0, Math.min(100, Math.round(normalized)));
  }
}
