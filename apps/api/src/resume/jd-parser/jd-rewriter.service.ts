import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  JD_LLM_REWRITER_CLIENT,
  type JdLlmRewriterClient,
  type JdRewriteImprovementTarget,
} from '../../common/llm/llm-client.interface';
import type { JdJudgeResult } from './jd-judge.service';
import type {
  ParsedJdResult,
  ParsedResponsibilityItem,
  SeniorityLevel,
} from './types';

/**
 * 低分维度阈值，规则版与 LLM 版共用，保证两者判定一致。
 * 同时供上层（如 `ResumeService.buildRewriteTriggers`）复用，避免多处硬编码。
 */
export const REWRITE_THRESHOLDS = {
  overallScore: 75,
  specificity: 75,
  measurability: 70,
  seniorityFit: 70,
} as const;

const SENIORITY_LEVELS: ReadonlySet<string> = new Set([
  'junior',
  'mid',
  'senior',
  'lead',
  'manager',
  'director',
  'unknown',
]);

/**
 * JD 定向重写服务。
 *
 * 两种实现路径：
 * - `rule`（默认）：基于规则的字符串改写，零延迟、零成本，作为兜底
 * - `llm`：调用 `JdLlmRewriterClient` 做语义级定向重写，失败自动回退规则版
 *
 * 切换由 `JD_REWRITE_PROVIDER` 环境变量控制（`rule` | `llm`），可独立灰度。
 *
 * LLM 路径采用定向重写策略：仅向模型传递低于阈值的维度及改善 hint，避免全量重写
 * 把已 OK 的字段改坏。LLM 输出经 rewriter client 的 zod schema 校验后，这里再做一次
 * deep merge（保留原 parsed 的可选字段，如 `basic.salaryMinK`/`educationMin`），
 * 因为 rewrite_jd 的 schema 只要求 `basic.jobTitleRaw/jobTitleNorm`，可选字段可能缺失。
 */
@Injectable()
export class JdRewriterService {
  private readonly logger = new Logger(JdRewriterService.name);

  constructor(
    @Optional()
    @Inject(JD_LLM_REWRITER_CLIENT)
    private readonly rewriterClient?: JdLlmRewriterClient,
  ) {}

  async rewrite(
    parsed: ParsedJdResult,
    judge: JdJudgeResult,
    rawJdText: string,
  ): Promise<ParsedJdResult> {
    if (!this.shouldUseLlmRewrite()) {
      return this.rewriteRuleBased(parsed, judge, rawJdText);
    }

    if (!this.rewriterClient) {
      this.logger.warn(
        'JD_REWRITE_PROVIDER=llm but no rewriter client registered, fallback to rule-based',
      );
      return this.rewriteRuleBased(parsed, judge, rawJdText);
    }

    const targets = this.buildImprovementTargets(judge);
    if (targets.length === 0) {
      // 所有维度已达标，无需调 LLM，直接标记 rewrite 流程已跑（与规则版行为一致）。
      return this.markRewriteApplied(parsed);
    }

    try {
      const llmOutput = await this.rewriterClient.rewriteJd({
        parsedJd: parsed,
        rawJdText,
        targets,
      });
      const merged = this.mergeRewriteResult(parsed, llmOutput);
      this.logger.log(
        `jd rewrite ok: provider=llm targets=${targets.length} dimensions=${targets.map((t) => t.dimension).join(',')}`,
      );
      return merged;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      this.logger.warn(
        `jd rewrite failed, fallback to rule-based: ${message}`,
      );
      return this.rewriteRuleBased(parsed, judge, rawJdText);
    }
  }

  /** 基于 LLM 输出与原 parsed 做 deep merge，保留原可选字段、追加 rewrite 标记。 */
  private mergeRewriteResult(
    original: ParsedJdResult,
    llmOutput: unknown,
  ): ParsedJdResult {
    if (
      !llmOutput ||
      typeof llmOutput !== 'object' ||
      Array.isArray(llmOutput)
    ) {
      throw new Error('rewrite_output_not_object');
    }
    const llm = llmOutput as Record<string, unknown>;
    const llmBasic = this.toObject(llm.basic);
    const llmRequirements = this.toObject(llm.requirements);
    const llmSkills = this.toObject(llm.skills);

    return {
      basic: { ...original.basic, ...this.pickDefined(llmBasic) },
      responsibilities: this.pickResponsibilities(
        llm.responsibilities,
        original.responsibilities,
      ),
      requirements: {
        must: this.pickRequirements(
          llmRequirements.must,
          original.requirements.must,
        ),
        preferred: this.pickRequirements(
          llmRequirements.preferred,
          original.requirements.preferred,
        ),
      },
      skills: {
        hardSkills: this.pickStringArray(
          llmSkills.hardSkills,
          original.skills.hardSkills,
        ),
        softSkills: this.pickStringArray(
          llmSkills.softSkills,
          original.skills.softSkills,
        ),
        tools: this.pickStringArray(llmSkills.tools, original.skills.tools),
        certificates: this.pickStringArray(
          llmSkills.certificates,
          original.skills.certificates,
        ),
      },
      businessGoals: this.pickBusinessGoals(
        llm.businessGoals,
        original.businessGoals,
      ),
      keywords: this.pickStringArray(llm.keywords, original.keywords),
      seniorityLevel: this.pickSeniority(
        llm.seniorityLevel,
        original.seniorityLevel,
      ),
      quality: {
        ...original.quality,
        warnings: this.withWarning(
          original.quality.warnings,
          'llm_rewrite_applied',
        ),
      },
    };
  }

  /** 根据 judge 低分维度构造定向改善目标，供 LLM 路径使用。 */
  private buildImprovementTargets(
    judge: JdJudgeResult,
  ): JdRewriteImprovementTarget[] {
    const targets: JdRewriteImprovementTarget[] = [];
    const { dimensions } = judge;

    if (dimensions.specificity < REWRITE_THRESHOLDS.specificity) {
      targets.push({
        dimension: 'specificity',
        currentScore: dimensions.specificity,
        threshold: REWRITE_THRESHOLDS.specificity,
        hint: 'improve responsibilities concreteness with explicit action, object and business scenes',
      });
    }
    if (dimensions.measurability < REWRITE_THRESHOLDS.measurability) {
      targets.push({
        dimension: 'measurability',
        currentScore: dimensions.measurability,
        threshold: REWRITE_THRESHOLDS.measurability,
        hint: 'strengthen businessGoals metricHint with quantifiable metrics (e.g. conversion rate, latency, cost)',
      });
    }
    if (dimensions.seniorityFit < REWRITE_THRESHOLDS.seniorityFit) {
      targets.push({
        dimension: 'seniorityFit',
        currentScore: dimensions.seniorityFit,
        threshold: REWRITE_THRESHOLDS.seniorityFit,
        hint: 'adjust responsibilities seniority wording to match years of experience',
      });
    }

    return targets;
  }

  private shouldUseLlmRewrite(): boolean {
    const provider = process.env.JD_REWRITE_PROVIDER?.trim().toLowerCase();
    return provider === 'llm';
  }

  // ---- 规则版重写（作为 LLM 路径的 fallback 与默认实现） ----

  /** 基于规则的定向改写，纯本地字符串操作，零延迟零成本。 */
  private rewriteRuleBased(
    parsed: ParsedJdResult,
    judge: JdJudgeResult,
    rawJdText: string,
  ): ParsedJdResult {
    let next = this.cloneParsed(parsed);

    if (judge.dimensions.specificity < REWRITE_THRESHOLDS.specificity) {
      next = this.rewriteSpecificity(next);
    }

    if (judge.dimensions.measurability < REWRITE_THRESHOLDS.measurability) {
      next = this.rewriteMeasurability(next, rawJdText);
    }

    if (judge.dimensions.seniorityFit < REWRITE_THRESHOLDS.seniorityFit) {
      next = this.rewriteSeniority(next);
    }

    return this.markRewriteApplied(next);
  }

  private rewriteSpecificity(parsed: ParsedJdResult): ParsedJdResult {
    const rewrittenResponsibilities = parsed.responsibilities.map((item) => {
      const text = item.text.trim();
      const hasScene = /(场景|业务|流程|系统|平台|项目|产品)/.test(text);
      const hasObject = item.object.trim().length >= 5;

      if (hasScene && hasObject) {
        return item;
      }

      const newText = `${text.replace(/[。.!?]+$/, '')}，覆盖具体业务场景与交付范围。`;
      return {
        ...item,
        text: newText,
        object: hasObject ? item.object : '相关业务流程与交付结果',
        confidence: Math.min(0.95, item.confidence + 0.05),
      };
    });

    return {
      ...parsed,
      responsibilities: rewrittenResponsibilities,
    };
  }

  private rewriteMeasurability(
    parsed: ParsedJdResult,
    rawJdText: string,
  ): ParsedJdResult {
    const metricHints = this.extractMetricHints(rawJdText);
    const mergedGoals = [...parsed.businessGoals];

    if (mergedGoals.length === 0) {
      mergedGoals.push({
        goalType: '提效',
        text: '围绕关键流程效率提升推动目标达成',
        metricHint: metricHints[0] ?? '时效/人效',
        evidenceSpan: rawJdText.slice(0, 120),
        confidence: 0.72,
      });
    } else {
      for (let i = 0; i < mergedGoals.length; i += 1) {
        if (!mergedGoals[i].metricHint) {
          mergedGoals[i] = {
            ...mergedGoals[i],
            metricHint: metricHints[i] ?? '转化率/时效/成本',
          };
        }
      }
    }

    return {
      ...parsed,
      businessGoals: mergedGoals,
    };
  }

  private rewriteSeniority(parsed: ParsedJdResult): ParsedJdResult {
    const years = Math.max(
      parsed.basic.yearsExpMin ?? 0,
      parsed.basic.yearsExpMax ?? 0,
    );
    const next = this.cloneParsed(parsed);

    if (years <= 2) {
      next.seniorityLevel = 'junior';
      next.responsibilities = next.responsibilities.map((item) => ({
        ...item,
        text: item.text.replace(/制定战略|集团级|全面负责/g, '参与执行'),
      }));
      return next;
    }

    if (years >= 5 && next.seniorityLevel === 'junior') {
      next.seniorityLevel = 'mid';
    }

    return next;
  }

  private extractMetricHints(rawJdText: string): string[] {
    const text = rawJdText.toLowerCase();
    const hints: string[] = [];

    if (/(转化率|留存率|gmv|dau|mau)/i.test(text)) {
      hints.push('转化率/留存率');
    }
    if (/(时效|效率|自动化|人效)/i.test(text)) {
      hints.push('时效/人效');
    }
    if (/(成本|roi|预算)/i.test(text)) {
      hints.push('成本率/ROI');
    }

    return hints.length > 0 ? hints : ['转化率/时效/成本'];
  }

  // ---- merge 辅助：保证 LLM 输出与 ParsedJdResult 兼容 ----

  private markRewriteApplied(parsed: ParsedJdResult): ParsedJdResult {
    const next = this.cloneParsed(parsed);
    if (!next.quality.warnings.includes('rewrite_applied')) {
      next.quality.warnings.push('rewrite_applied');
    }
    return next;
  }

  private toObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  /** 仅保留非 undefined/null 的字段，用于 basic/skills 等对象级 merge。 */
  private pickDefined(
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (value !== undefined && value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  private pickResponsibilities(
    value: unknown,
    fallback: ParsedResponsibilityItem[],
  ): ParsedResponsibilityItem[] {
    if (!Array.isArray(value) || value.length === 0) {
      return fallback;
    }
    const items: ParsedResponsibilityItem[] = [];
    for (const raw of value) {
      const record = this.toObject(raw);
      const text = this.toText(record.text).slice(0, 200);
      if (!text) {
        continue;
      }
      items.push({
        text,
        action: this.toText(record.action) || '负责',
        object: this.toText(record.object) || text.slice(0, 120),
        scope: this.toOptionalText(record.scope),
        evidenceSpan: this.toText(record.evidenceSpan) || text,
        confidence: this.toConfidence(record.confidence, 0.8),
      });
      if (items.length >= 15) {
        break;
      }
    }
    return items.length > 0 ? items : fallback;
  }

  private pickRequirements(
    value: unknown,
    fallback: ParsedJdResult['requirements']['must'],
  ): ParsedJdResult['requirements']['must'] {
    if (!Array.isArray(value) || value.length === 0) {
      return fallback;
    }
    const items: ParsedJdResult['requirements']['must'] = [];
    for (const raw of value) {
      const record = this.toObject(raw);
      const text = this.toText(record.text).slice(0, 180);
      if (!text) {
        continue;
      }
      items.push({
        text,
        type: this.toRequirementType(record.type),
        evidenceSpan: this.toText(record.evidenceSpan) || text,
        confidence: this.toConfidence(record.confidence, 0.8),
      });
      if (items.length >= 20) {
        break;
      }
    }
    return items.length > 0 ? items : fallback;
  }

  private pickBusinessGoals(
    value: unknown,
    fallback: ParsedJdResult['businessGoals'],
  ): ParsedJdResult['businessGoals'] {
    if (!Array.isArray(value) || value.length === 0) {
      return fallback;
    }
    const items: ParsedJdResult['businessGoals'] = [];
    for (const raw of value) {
      const record = this.toObject(raw);
      const text = this.toText(record.text).slice(0, 200);
      if (!text) {
        continue;
      }
      items.push({
        goalType: this.toGoalType(record.goalType),
        text,
        metricHint: this.toOptionalText(record.metricHint),
        evidenceSpan: this.toText(record.evidenceSpan) || text,
        confidence: this.toConfidence(record.confidence, 0.8),
      });
      if (items.length >= 10) {
        break;
      }
    }
    return items.length > 0 ? items : fallback;
  }

  private pickStringArray(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value) || value.length === 0) {
      return fallback;
    }
    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
    return normalized.length > 0 ? Array.from(new Set(normalized)) : fallback;
  }

  private pickSeniority(
    value: unknown,
    fallback: SeniorityLevel,
  ): SeniorityLevel {
    if (typeof value === 'string' && SENIORITY_LEVELS.has(value)) {
      return value as SeniorityLevel;
    }
    return fallback;
  }

  private withWarning(warnings: string[], warning: string): string[] {
    return warnings.includes(warning)
      ? [...warnings]
      : [...warnings, warning];
  }

  private toText(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim();
    }
    return '';
  }

  private toOptionalText(value: unknown): string | undefined {
    const text = this.toText(value);
    return text.length > 0 ? text : undefined;
  }

  private toConfidence(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.min(1, Math.max(0, value));
    }
    return fallback;
  }

  private toRequirementType(
    value: unknown,
  ): ParsedJdResult['requirements']['must'][number]['type'] {
    const text = this.toText(value);
    if (
      text === '经验' ||
      text === '技能' ||
      text === '学历' ||
      text === '证书' ||
      text === '语言' ||
      text === '其他'
    ) {
      return text;
    }
    return '其他';
  }

  private toGoalType(
    value: unknown,
  ): ParsedJdResult['businessGoals'][number]['goalType'] {
    const text = this.toText(value);
    const allowed = [
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
    ] as const;
    return (allowed as readonly string[]).includes(text)
      ? (text as (typeof allowed)[number])
      : '其他';
  }

  private cloneParsed(parsed: ParsedJdResult): ParsedJdResult {
    return JSON.parse(JSON.stringify(parsed)) as ParsedJdResult;
  }
}
