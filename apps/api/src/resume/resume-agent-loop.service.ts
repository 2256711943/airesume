import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { GenerateResumeDto } from './dto/generate-resume.dto';
import {
  ResumeAiService,
  type AiResumeVariant,
  type ResumePromptVersionMap,
} from './resume.ai.service';
import {
  ResumeScorerService,
  type ResumeVariantScore,
} from './resume-scorer.service';
import {
  WEB_SEARCH_TOOL,
  type WebSearchTool,
} from './web-search-tool.interface';

/** 连续多少轮最弱变体分数无提升则提前停止。 */
const NO_IMPROVEMENT_LIMIT = 2;
/** 分数提升低于该值时视为"无有效改进"。 */
const IMPROVEMENT_EPSILON = 0.1;

/**
 * 简历重写 Agent Loop（只迭代最弱变体）。
 *
 * 流程：生成初始变体 → 评分 → 每轮只重写分数最低的变体 → 再评，直到：
 * 1. 最弱变体达到目标分（隐含全部变体达标）；
 * 2. 达到 maxTurns；
 * 3. 连续两轮最弱变体分数无有效提升。
 *
 * 说明:
 * - 打分复用 `ResumeScorerService`，不重写评分算法。
 * - `webSearchTool` 为预留能力（默认未注入），注入后会在重写前提供搜索摘要。
 * - 配置项：`RESUME_AGENT_LOOP_ENABLED`（由上层控制）、`RESUME_AGENT_LOOP_MAX_TURNS`（默认 3）、
 *   `RESUME_AGENT_LOOP_TARGET_SCORE`（默认 85）。
 */
@Injectable()
export class ResumeAgentLoopService {
  private readonly logger = new Logger(ResumeAgentLoopService.name);

  constructor(
    private readonly resumeAiService: ResumeAiService,
    private readonly resumeScorerService: ResumeScorerService,
    @Optional()
    @Inject(WEB_SEARCH_TOOL)
    private readonly webSearchTool?: WebSearchTool,
  ) {}

  /**
   * 执行简历重写 agent loop，返回最终变体及其分数。
   * 分数由 loop 内部产出（复用 Scorer），上层可直接用于最终输出，避免重复评分。
   */
  async run(
    input: GenerateResumeDto,
    promptVersions?: Partial<ResumePromptVersionMap>,
  ): Promise<{
    variants: AiResumeVariant[];
    scores: ResumeVariantScore[];
  }> {
    const maxTurns = this.readMaxTurns();
    const targetScore = this.readTargetScore();

    const variants = await this.resumeAiService.generate(input, promptVersions);
    const scores = await this.scoreAll(input, variants);
    let noImprovementRounds = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      const weakestIndex = this.findWeakestIndex(scores);
      // 停止条件 1：最弱变体已达标（隐含所有变体达标）
      if (scores[weakestIndex].overallScore >= targetScore) {
        break;
      }
      // 停止条件 2：连续两轮无有效提升
      if (noImprovementRounds >= NO_IMPROVEMENT_LIMIT) {
        break;
      }

      const previousScore = scores[weakestIndex].overallScore;
      const searchContext = await this.collectSearchContext(input);
      const improved = await this.resumeAiService.rewriteVariantWithFeedback(
        input,
        variants[weakestIndex],
        scores[weakestIndex],
        searchContext,
      );
      variants[weakestIndex] = improved;
      scores[weakestIndex] = await this.resumeScorerService.scoreVariant(
        input,
        improved,
      );

      const gained = scores[weakestIndex].overallScore - previousScore;
      noImprovementRounds =
        gained > IMPROVEMENT_EPSILON ? 0 : noImprovementRounds + 1;
      this.logger.log(
        `resume agent loop turn=${turn} weakest_improved=${gained.toFixed(1)} score=${scores[weakestIndex].overallScore.toFixed(1)} target=${targetScore}`,
      );
    }

    return { variants, scores };
  }

  private async scoreAll(
    input: GenerateResumeDto,
    variants: AiResumeVariant[],
  ): Promise<ResumeVariantScore[]> {
    return Promise.all(
      variants.map((variant) =>
        this.resumeScorerService.scoreVariant(input, variant),
      ),
    );
  }

  /** 选出整体分数最低的变体下标（首个最小）。 */
  private findWeakestIndex(scores: ResumeVariantScore[]): number {
    let weakest = 0;
    for (let i = 1; i < scores.length; i += 1) {
      if (scores[i].overallScore < scores[weakest].overallScore) {
        weakest = i;
      }
    }
    return weakest;
  }

  /**
   * 若已注入搜索工具，按岗位与必备技能构建查询并返回摘要上下文。
   * 搜索失败或未注入时返回空串，不影响主流程（预留能力）。
   */
  private async collectSearchContext(
    input: GenerateResumeDto,
  ): Promise<string> {
    if (!this.webSearchTool) {
      return '';
    }
    try {
      const query = [
        input.targetJob.title,
        ...input.targetJob.mustHaveSkills.slice(0, 5),
      ]
        .join(' ')
        .trim();
      const results = await this.webSearchTool.search(query);
      return results
        .slice(0, 3)
        .map((item) => `${item.title} | ${item.snippet}`)
        .join('\n');
    } catch (error) {
      this.logger.warn(
        `resume agent web search failed: ${
          error instanceof Error ? error.message : 'unknown_error'
        }`,
      );
      return '';
    }
  }

  private readMaxTurns(): number {
    const raw = Number(process.env.RESUME_AGENT_LOOP_MAX_TURNS);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
  }

  private readTargetScore(): number {
    const raw = Number(process.env.RESUME_AGENT_LOOP_TARGET_SCORE);
    return Number.isFinite(raw) && raw > 0 ? raw : 85;
  }
}
