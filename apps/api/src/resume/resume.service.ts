import { BadRequestException, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Prisma } from '@prisma/client';
import {
  GenerateResumeDto,
  type ResumeProfileDto,
  type ResumeTargetJobDto,
} from './dto/generate-resume.dto';
import { GenerateResumeStreamDto } from './dto/generate-resume-stream.dto';
import { type GenerateResumeResponseDto } from './dto/generate-resume-response.dto';
import { RewriteJdDto } from './dto/rewrite-jd.dto';
import type { RewriteJdResponseDto } from './dto/rewrite-jd-response.dto';
import { JdParserService } from './jd-parser/jd-parser.service';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import {
  JdJudgeService,
  type JdJudgeResult,
} from './jd-parser/jd-judge.service';
import {
  JdRewriterService,
  REWRITE_THRESHOLDS,
} from './jd-parser/jd-rewriter.service';
import { ResumeAgentLoopService } from './resume-agent-loop.service';
import {
  ResumeAiService,
  type AiResumeVariant,
  type ResumePromptVersionMap,
  type ResumeRewriteMode,
} from './resume.ai.service';
import {
  ResumeScorerService,
  type ResumeVariantScore,
} from './resume-scorer.service';
import { SelectResumeVariantDto } from './dto/select-resume-variant.dto';
import type { SelectResumeVariantResponseDto } from './dto/select-resume-variant-response.dto';
import {
  ResumeLearningService,
  type ResumeGenerationPolicy,
} from './resume-learning.service';
import type { SseEnvelopeMessageEvent } from '../common/sse';
import {
  ReplayableSseSession,
  ReplayableSseSessionStore,
} from '../common/sse-session';

/**
 * 简历模块核心服务（ResumeService）
 *
 * 聚合以下能力：
 * 1. generate：按重写模式（技术/商务/综合）批量生成简历变体，并基于评分与
 *    学习策略反馈（feedbackBoost）计算最终分与排名；
 * 2. rewriteJd：JD 定向重写（内部完成解析与打分，对用户只暴露重写能力）；
 * 3. selectVariant：记录用户选择的变体（含快照与评分），可选写入简历库；
 * 4. generateStream：基于可回放 SSE 会话的流式生成（支持断线续传/取消）。
 */

/** 流式生成过程中下发的 SSE 事件类型。 */
export type ResumeSseEventType =
  | 'start'
  | 'chunk'
  | 'progress'
  | 'done'
  | 'error'
  | 'canceled';
/** 简历流式 SSE 负载：事件信封 + 事件类型。 */
export type ResumeSsePayload = SseEnvelopeMessageEvent<ResumeSseEventType>;
/**
 * 简历流式会话存储：以 streamKey 为键的可回放 SSE 会话，
 * 支持客户端携带 sinceSeq 断线重连、空闲超时自动中止。
 */
const resumeStreamSessions =
  new ReplayableSseSessionStore<ResumeSseEventType>();

@Injectable()
export class ResumeService {
  constructor(
    private readonly resumeAiService: ResumeAiService,
    private readonly resumeScorerService: ResumeScorerService,
    private readonly resumeLearningService: ResumeLearningService,
    private readonly jdParserService: JdParserService,
    private readonly jdJudgeService: JdJudgeService,
    private readonly jdRewriterService: JdRewriterService,
    private readonly resumeAgentLoopService: ResumeAgentLoopService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 批量生成简历变体并完成评分、排序、排名。
   *
   * 流程：
   * 1. 根据用户历史行为构建生成策略（各模式的 prompt 版本 + feedbackBoost）；
   * 2. 按模式并行生成（可选启用评分）；
   * 3. 计算 finalScore = overallScore + feedbackBoost，按分数生成排名；
   * 4. 输出仍按固定模式顺序排列，同时携带 rank 与 diff（改动对照）。
   */
  async generate(
    dto: GenerateResumeDto,
    user: AuthenticatedUser,
  ): Promise<GenerateResumeResponseDto> {
    const requestId = `req_${Date.now()}`;
    // 生成策略：包含各模式当前的 prompt 版本与学习反馈加成
    const generationPolicy =
      await this.resumeLearningService.buildGenerationPolicy(
        user.id,
        requestId,
      );
    const promptVersionMap = this.toPromptVersionMap(
      generationPolicy.modePolicies,
    );

    // agent loop 开启时由 loop 内部完成生成与评分（复用 Scorer），避免重复 LLM 评分；
    // 否则沿用原有 enableScoring 开关决定是否评分。
    const withScores = this.isAgentLoopEnabled()
      ? await this.generateWithAgentLoop(dto, promptVersionMap)
      : dto.enableScoring
        ? await this.generateWithScoring(dto, promptVersionMap)
        : await this.generateWithoutScoring(dto, promptVersionMap);

    return this.buildGenerateResponse(
      dto,
      generationPolicy,
      withScores,
      requestId,
    );
  }

  /** agent loop 分支：loop 内部产出变体与分数，直接复用，不再二次评分。 */
  private async generateWithAgentLoop(
    dto: GenerateResumeDto,
    promptVersions: ResumePromptVersionMap,
  ): Promise<Array<AiResumeVariant & { scores: ResumeVariantScore }>> {
    const { variants, scores } = await this.resumeAgentLoopService.run(
      dto,
      promptVersions,
    );
    return variants.map((variant, index) => ({
      ...variant,
      scores: scores[index],
    }));
  }

  /** 开启评分：对每个变体执行评分。 */
  private async generateWithScoring(
    dto: GenerateResumeDto,
    promptVersions: ResumePromptVersionMap,
  ): Promise<Array<AiResumeVariant & { scores: ResumeVariantScore }>> {
    const variants = await this.resumeAiService.generate(dto, promptVersions);
    return Promise.all(
      variants.map(async (variant) => ({
        ...variant,
        scores: await this.resumeScorerService.scoreVariant(dto, variant),
      })),
    );
  }

  /** 未开启评分：使用全 0 的默认分。 */
  private async generateWithoutScoring(
    dto: GenerateResumeDto,
    promptVersions: ResumePromptVersionMap,
  ): Promise<Array<AiResumeVariant & { scores: ResumeVariantScore }>> {
    const variants = await this.resumeAiService.generate(dto, promptVersions);
    return variants.map((variant) => ({
      ...variant,
      scores: this.buildDefaultScore(),
    }));
  }

  /** 依据生成策略计算最终分与排名，输出固定模式顺序（technical -> business -> hybrid）。 */
  private buildGenerateResponse(
    dto: GenerateResumeDto,
    generationPolicy: ResumeGenerationPolicy,
    withScores: Array<AiResumeVariant & { scores: ResumeVariantScore }>,
    requestId: string,
  ): GenerateResumeResponseDto {
    // 计算综合最终分（学习反馈加成 + 客观评分）并按分数降序排名
    const rankedByFinalScore = [...withScores]
      .map((variant) => {
        const mode = this.requireMode(variant.mode);
        const learningPolicy = generationPolicy.modePolicies[mode];
        const feedbackBoost = learningPolicy.feedbackBoost;
        const finalScore = Number(
          (variant.scores.overallScore + feedbackBoost).toFixed(1),
        );

        return {
          ...variant,
          promptVersion: variant.promptVersion ?? learningPolicy.promptVersion,
          feedbackBoost,
          finalScore,
        };
      })
      .sort((left, right) => right.finalScore - left.finalScore);
    // 记录各变体在分数排序中的名次
    const rankMap = new Map(
      rankedByFinalScore.map(
        (variant, index) => [variant.id, index + 1] as const,
      ),
    );
    // 输出按固定模式顺序排列（technical -> business -> hybrid），保留 rank 与 diff
    const stableOutput = rankedByFinalScore
      .sort(
        (left, right) =>
          this.modeOrder(this.requireMode(left.mode)) -
          this.modeOrder(this.requireMode(right.mode)),
      )
      .map((variant) => ({
        ...variant,
        rank: rankMap.get(variant.id) ?? 999,
        diff: this.buildVariantDiff(dto, variant),
      }));

    return {
      requestId,
      activePromptVersions: this.toPromptVersionMap(
        generationPolicy.modePolicies,
      ),
      variants: stableOutput,
    };
  }

  /** 是否启用简历重写 agent loop（默认关闭）。 */
  private isAgentLoopEnabled(): boolean {
    return /^(1|true|yes|on)$/i.test(
      (process.env.RESUME_AGENT_LOOP_ENABLED ?? '').trim(),
    );
  }

  /**
   * JD 定向重写（对外暴露的重写入口）。
   *
   * 内部流程：解析 JD → 质量打分 → 依据低分维度触发定向重写。
   * JD 解析与打分不直接暴露给用户，仅作为重写链路的内部步骤。
   * debug 模式下返回完整的调试轨迹（beforeJudge/afterJudge/rewriteTriggers）。
   */
  async rewriteJd(dto: RewriteJdDto): Promise<RewriteJdResponseDto> {
    const parsed = await this.jdParserService.parse(dto.jdText);
    const judge = this.jdJudgeService.judge(parsed, dto.jdText);
    const rewriteTriggers = this.buildRewriteTriggers(judge);
    const shouldRewrite = rewriteTriggers.length > 0;

    if (!shouldRewrite) {
      if (!dto.debug) {
        return parsed;
      }

      return {
        ...parsed,
        debugTrace: {
          rewriteEnabled: true,
          rewriteApplied: false,
          rewriteTriggers,
          beforeJudge: judge,
        },
      };
    }

    const rewritten = await this.jdRewriterService.rewrite(
      parsed,
      judge,
      dto.jdText,
    );
    if (!dto.debug) {
      return rewritten;
    }

    const afterJudge = this.jdJudgeService.judge(rewritten, dto.jdText);
    return {
      ...rewritten,
      debugTrace: {
        rewriteEnabled: true,
        rewriteApplied: true,
        rewriteTriggers,
        beforeJudge: judge,
        afterJudge,
      },
    };
  }

  /**
   * 记录用户对某个变体的选择（事件落库），
   * 并可选地将该变体快照写入简历库（addToLibrary）。
   */
  async selectVariant(
    dto: SelectResumeVariantDto,
    user: AuthenticatedUser,
  ): Promise<SelectResumeVariantResponseDto> {
    // 变体内容与评分快照转为 Prisma 可存储的 JSON 值
    const variantSnapshot = {
      summary: dto.variant.summary,
      experience: dto.variant.experience,
      projects: dto.variant.projects,
      skills: dto.variant.skills,
    } as unknown as Prisma.InputJsonValue;
    const scoreSnapshot = (dto.scoreSnapshot ?? undefined) as unknown as
      | Prisma.InputJsonValue
      | undefined;

    // 写入选择事件，用于后续学习策略（反馈加成）的统计
    const event = await this.prisma.resumeVariantSelectionEvent.create({
      data: {
        userId: user.id,
        requestId: dto.requestId.trim(),
        mode: dto.mode,
        addToLibrary: dto.addToLibrary,
        promptVersion: dto.promptVersion?.trim() || 'resume-rewrite-v1',
        variantSnapshot,
        scoreSnapshot,
      },
      select: {
        id: true,
      },
    });

    // 可选：写入简历库，作为长期保存的版本
    let libraryItemId: string | undefined;
    if (dto.addToLibrary) {
      const item = await this.prisma.resumeLibraryItem.create({
        data: {
          userId: user.id,
          sourceRequestId: dto.requestId.trim(),
          sourceMode: dto.mode,
          title: `${dto.mode} version`,
          summary: dto.variant.summary,
          experience: dto.variant
            .experience as unknown as Prisma.InputJsonValue,
          projects: dto.variant.projects as unknown as Prisma.InputJsonValue,
          skills: dto.variant.skills,
          metadata: scoreSnapshot,
        },
        select: {
          id: true,
        },
      });
      libraryItemId = item.id;
    }

    return {
      eventId: event.id,
      addToLibrary: dto.addToLibrary,
      libraryItemId,
    };
  }

  /**
   * 简历流式生成（SSE）。
   *
   * 行为：
   * - 若 streamKey 已存在会话，则直接订阅回放（支持 sinceSeq 续传）；
   * - 否则创建新会话并启动后台生成任务，边生成边下发 start/chunk/progress/done；
   * - 空闲超时（idleAbortMs）会自动中止；客户端可携带 streamKey 重连恢复。
   */
  generateStream(dto: GenerateResumeStreamDto): Observable<ResumeSsePayload> {
    // 解析/兜底 streamKey，作为会话唯一标识
    const streamKey = this.resolveStreamKey(
      dto.streamKey,
      `resume_stream_${Date.now()}`,
    );
    const sinceSeq = this.normalizeSinceSeq(dto.sinceSeq);
    const existingSession = resumeStreamSessions.get(streamKey);

    // 已存在会话：按 sinceSeq 从断点续传
    if (existingSession) {
      return this.observeSession(existingSession, sinceSeq);
    }

    const requestId = `req_${Date.now()}`;
    const taskId = `task_${Date.now()}`;
    const abortController = new AbortController();
    // 新建会话：空闲 10s 自动中止底层生成任务
    const session = resumeStreamSessions.create(streamKey, taskId, {
      idleAbortMs: 10_000,
      onIdleAbort: () => {
        abortController.abort();
      },
    });

    // 后台异步任务：解析入参 -> 流式生成 -> 下发事件
    void (async () => {
      try {
        const normalizedDto = this.parseStreamPayload(dto);

        session.emit('start', {
          requestId,
          taskId,
          variantCount: normalizedDto.variants,
          startedAt: new Date().toISOString(),
          status: 'running',
        });

        session.emit('progress', {
          requestId,
          taskId,
          progress: 10,
          stage: 'planning',
          timestamp: new Date().toISOString(),
        });

        let chunkCount = 0;
        // 调用 AI 服务流式生成，通过 onDelta 逐段下发 chunk 事件
        const variants = await this.resumeAiService.generateWithStream(
          normalizedDto,
          {
            signal: abortController.signal,
            onDelta: (text) => {
              chunkCount += 1;
              session.emit('chunk', {
                requestId,
                taskId,
                variantIndex: 1,
                field: 'summary',
                text,
                timestamp: new Date().toISOString(),
              });

              // 每 6 个 chunk 上报一次进度（不超过 90）
              if (chunkCount % 6 === 0) {
                session.emit('progress', {
                  requestId,
                  taskId,
                  progress: Math.min(90, 10 + chunkCount),
                  stage: 'generating',
                  timestamp: new Date().toISOString(),
                });
              }
            },
          },
        );

        session.emit('progress', {
          requestId,
          taskId,
          progress: 100,
          stage: 'post_processing',
          timestamp: new Date().toISOString(),
        });

        session.emit('done', {
          requestId,
          taskId,
          variantCount: variants.length,
          variants,
          finishedAt: new Date().toISOString(),
          status: 'succeeded',
        });
      } catch (error) {
        // 被中止则下发 canceled，否则下发 error
        if (abortController.signal.aborted) {
          session.emit('canceled', {
            requestId,
            taskId,
            reason: 'USER_ABORT',
            timestamp: new Date().toISOString(),
            status: 'canceled',
          });
        } else {
          session.emit('error', {
            requestId,
            taskId,
            code: 'INTERNAL_ERROR',
            message:
              error instanceof Error
                ? error.message
                : 'Resume stream generation failed',
            timestamp: new Date().toISOString(),
            status: 'failed',
          });
        }
      } finally {
        // 无论成功/失败/取消，最终都关闭会话
        session.complete();
      }
    })();

    // 立即返回对新会话的订阅（可回放历史事件）
    return this.observeSession(session, sinceSeq);
  }

  /**
   * 把查询串中 JSON 化的 profile / targetJob 解析为 GenerateResumeDto，
   * 并对必填字段做校验，缺失时抛出 400。
   */
  private parseStreamPayload(dto: GenerateResumeStreamDto): GenerateResumeDto {
    let profile: ResumeProfileDto;
    let targetJob: ResumeTargetJobDto;

    // 查询串中的 profile / targetJob 均为 JSON 字符串，需解析
    try {
      profile = JSON.parse(dto.profile) as ResumeProfileDto;
    } catch {
      throw new BadRequestException('Invalid profile JSON in query');
    }

    try {
      targetJob = JSON.parse(dto.targetJob) as ResumeTargetJobDto;
    } catch {
      throw new BadRequestException('Invalid targetJob JSON in query');
    }

    // 类型与结构校验
    if (!profile || typeof profile !== 'object') {
      throw new BadRequestException('profile is required');
    }

    if (!targetJob || typeof targetJob !== 'object') {
      throw new BadRequestException('targetJob is required');
    }

    // 必填字段归一化
    const fullName = String(profile.fullName ?? '').trim();
    const background = String(profile.background ?? '').trim();
    const targetTitle = String(targetJob.title ?? '').trim();
    const skills = Array.isArray(profile.skills)
      ? profile.skills.map((item) => String(item))
      : [];

    // 必填校验：姓名、背景、目标岗位、至少一项技能
    if (!fullName) {
      throw new BadRequestException('profile.fullName is required');
    }

    if (!background) {
      throw new BadRequestException('profile.background is required');
    }

    if (!targetTitle) {
      throw new BadRequestException('targetJob.title is required');
    }

    if (skills.length === 0) {
      throw new BadRequestException(
        'profile.skills must contain at least one item',
      );
    }

    // 组装为规范化 DTO（数组字段统一兜底为空数组）
    return {
      profile: {
        fullName,
        background,
        skills,
        experiences: Array.isArray(profile.experiences)
          ? profile.experiences
          : [],
        projects: Array.isArray(profile.projects) ? profile.projects : [],
      },
      targetJob: {
        title: targetTitle,
        description: String(targetJob.description ?? ''),
        mustHaveSkills: Array.isArray(targetJob.mustHaveSkills)
          ? targetJob.mustHaveSkills.map((item) => String(item))
          : [],
      },
      tone: dto.tone,
      language: dto.language,
      variants: dto.variants,
      topN: 3,
      enableScoring: true,
    };
  }

  /**
   * 依据 JD 质量判断结果，生成重写触发原因列表。
   * 任一维度低于阈值都会加入对应 trigger；阈值与重写服务共用单一常量。
   */
  private buildRewriteTriggers(judge: JdJudgeResult): string[] {
    const triggers: string[] = [];
    // 总分低于阈值触发重写
    if (judge.overallScore < REWRITE_THRESHOLDS.overallScore) {
      triggers.push('low_overall_score');
    }
    // 具体性低于阈值触发重写
    if (judge.dimensions.specificity < REWRITE_THRESHOLDS.specificity) {
      triggers.push('low_specificity');
    }
    // 可量化性低于阈值触发重写
    if (judge.dimensions.measurability < REWRITE_THRESHOLDS.measurability) {
      triggers.push('low_measurability');
    }
    // 职级匹配度低于阈值触发重写
    if (judge.dimensions.seniorityFit < REWRITE_THRESHOLDS.seniorityFit) {
      triggers.push('low_seniority_fit');
    }
    return triggers;
  }

  /** 未启用评分时的默认空评分（全 0，无问题与建议）。 */
  private buildDefaultScore(): ResumeVariantScore {
    return {
      ruleScore: 0,
      llmScore: 0,
      overallScore: 0,
      dimensions: {
        readability: 0,
        measurability: 0,
        roleRelevance: 0,
      },
      issues: [],
      suggestions: [],
    };
  }

  /**
   * 构建生成变体与原始简历的改动对照（diff）：
   * 分别对比工作经历与项目经历的 highlights 逐行 before/after。
   */
  private buildVariantDiff(
    dto: GenerateResumeDto,
    variant: {
      experience: Array<{ highlights: string[] }>;
      projects: Array<{ highlights: string[] }>;
    },
  ): {
    experienceHighlights: Array<{
      before: string;
      after: string;
      changed: boolean;
    }>;
    projectHighlights: Array<{
      before: string;
      after: string;
      changed: boolean;
    }>;
  } {
    // 原始经验/项目亮点（展平为字符串列表）
    const originalExperience = dto.profile.experiences.flatMap(
      (item) => item.highlights,
    );
    const generatedExperience = variant.experience.flatMap(
      (item) => item.highlights,
    );
    const originalProjects = dto.profile.projects.flatMap(
      (item) => item.highlights,
    );
    const generatedProjects = variant.projects.flatMap(
      (item) => item.highlights,
    );

    return {
      experienceHighlights: this.toDiffRows(
        originalExperience,
        generatedExperience,
      ),
      projectHighlights: this.toDiffRows(originalProjects, generatedProjects),
    };
  }

  /** 按行对齐 before/after 两个列表，标记每行是否发生变化。 */
  private toDiffRows(
    beforeList: string[],
    afterList: string[],
  ): Array<{ before: string; after: string; changed: boolean }> {
    const max = Math.max(beforeList.length, afterList.length);
    const rows: Array<{ before: string; after: string; changed: boolean }> = [];
    for (let i = 0; i < max; i += 1) {
      const before = beforeList[i] ?? '';
      const after = afterList[i] ?? '';
      rows.push({
        before,
        after,
        changed: before.trim() !== after.trim(),
      });
    }
    return rows;
  }

  /** 将各模式策略映射为「模式 -> prompt 版本号」的简化映射。 */
  private toPromptVersionMap(
    modePolicies: Record<
      ResumeRewriteMode,
      {
        promptVersion: string;
      }
    >,
  ): Record<ResumeRewriteMode, string> {
    return {
      technical: modePolicies.technical.promptVersion,
      business: modePolicies.business.promptVersion,
      hybrid: modePolicies.hybrid.promptVersion,
    };
  }

  /** 兜底模式：缺省时视为 hybrid。 */
  private requireMode(mode: ResumeRewriteMode | undefined): ResumeRewriteMode {
    return mode ?? 'hybrid';
  }

  /** 固定输出顺序：technical(0) -> business(1) -> hybrid(2)。 */
  private modeOrder(mode: ResumeRewriteMode): number {
    if (mode === 'technical') {
      return 0;
    }
    if (mode === 'business') {
      return 1;
    }
    return 2;
  }

  /** 订阅 SSE 会话：将事件流包装为 Observable，支持从 sinceSeq 起回放。 */
  private observeSession(
    session: ReplayableSseSession<ResumeSseEventType>,
    sinceSeq: number,
  ): Observable<ResumeSsePayload> {
    return new Observable<ResumeSsePayload>((subscriber) =>
      session.subscribe(
        {
          next: (event) => subscriber.next(event),
          complete: () => subscriber.complete(),
        },
        sinceSeq,
      ),
    );
  }

  /** 解析 streamKey：空白/缺失时使用调用方传入的兜底值。 */
  private resolveStreamKey(
    streamKey: string | undefined,
    fallback: string,
  ): string {
    const normalized = streamKey?.trim();
    return normalized && normalized.length > 0 ? normalized : fallback;
  }

  /** 归一化 sinceSeq：非法值回退到 0，负数取 0。 */
  private normalizeSinceSeq(sinceSeq: number | undefined): number {
    if (!Number.isFinite(sinceSeq)) {
      return 0;
    }

    return Math.max(0, Math.floor(sinceSeq ?? 0));
  }
}
