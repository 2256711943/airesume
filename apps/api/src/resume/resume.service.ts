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
import { ParseJdDto } from './dto/parse-jd.dto';
import type { ParseJdResponseDto } from './dto/parse-jd-response.dto';
import { JdParserService } from './jd-parser/jd-parser.service';
import { JudgeJdDto } from './dto/judge-jd.dto';
import type { JudgeJdResponseDto } from './dto/judge-jd-response.dto';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { JdJudgeService } from './jd-parser/jd-judge.service';
import { JdRewriterService } from './jd-parser/jd-rewriter.service';
import { ResumeAiService, type ResumeRewriteMode } from './resume.ai.service';
import { ResumeScorerService, type ResumeVariantScore } from './resume-scorer.service';
import { SelectResumeVariantDto } from './dto/select-resume-variant.dto';
import type { SelectResumeVariantResponseDto } from './dto/select-resume-variant-response.dto';
import { ResumeLearningService } from './resume-learning.service';
import { SseEnvelopeFactory, type SseEnvelopeMessageEvent } from '../common/sse';

export type ResumeSseEventType = 'start' | 'chunk' | 'progress' | 'done' | 'error' | 'canceled';
export type ResumeSsePayload = SseEnvelopeMessageEvent<ResumeSseEventType>;

@Injectable()
export class ResumeService {
  constructor(
    private readonly resumeAiService: ResumeAiService,
    private readonly resumeScorerService: ResumeScorerService,
    private readonly resumeLearningService: ResumeLearningService,
    private readonly jdParserService: JdParserService,
    private readonly jdJudgeService: JdJudgeService,
    private readonly jdRewriterService: JdRewriterService,
    private readonly prisma: PrismaService,
  ) {}

  async generate(dto: GenerateResumeDto, user: AuthenticatedUser): Promise<GenerateResumeResponseDto> {
    const requestId = `req_${Date.now()}`;
    const generationPolicy = await this.resumeLearningService.buildGenerationPolicy(user.id, requestId);
    const variants = await this.resumeAiService.generate(
      dto,
      this.toPromptVersionMap(generationPolicy.modePolicies),
    );
    const withScores = dto.enableScoring
      ? await Promise.all(
          variants.map(async (variant) => ({
            ...variant,
            scores: await this.resumeScorerService.scoreVariant(dto, variant),
          })),
        )
      : variants.map((variant) => ({
          ...variant,
          scores: this.buildDefaultScore(),
        }));

    const rankedByFinalScore = [...withScores]
      .map((variant) => {
        const mode = this.requireMode(variant.mode);
        const learningPolicy = generationPolicy.modePolicies[mode];
        const feedbackBoost = learningPolicy.feedbackBoost;
        const finalScore = Number((variant.scores.overallScore + feedbackBoost).toFixed(1));

        return {
          ...variant,
          promptVersion: variant.promptVersion ?? learningPolicy.promptVersion,
          feedbackBoost,
          finalScore,
        };
      })
      .sort((left, right) => right.finalScore - left.finalScore);
    const rankMap = new Map(
      rankedByFinalScore
        .map((variant, index) => [variant.id, index + 1] as const),
    );
    const stableOutput = rankedByFinalScore
      .sort((left, right) => this.modeOrder(this.requireMode(left.mode)) - this.modeOrder(this.requireMode(right.mode)))
      .map((variant) => ({
        ...variant,
        rank: rankMap.get(variant.id) ?? 999,
        diff: this.buildVariantDiff(dto, variant),
      }));

    return {
      requestId,
      activePromptVersions: this.toPromptVersionMap(generationPolicy.modePolicies),
      variants: stableOutput,
    };
  }

  async parseJd(dto: ParseJdDto): Promise<ParseJdResponseDto> {
    const parsed = await this.jdParserService.parse(dto.jdText);
    if (!dto.enableRewrite) {
      if (!dto.debug) {
        return parsed;
      }

      const judge = this.jdJudgeService.judge(parsed, dto.jdText);
      return {
        ...parsed,
        debugTrace: {
          rewriteEnabled: false,
          rewriteApplied: false,
          rewriteTriggers: [],
          beforeJudge: judge,
        },
      };
    }

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

    const rewritten = this.jdRewriterService.rewrite(parsed, judge, dto.jdText);
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

  async judgeJd(dto: JudgeJdDto): Promise<JudgeJdResponseDto> {
    const parsed = await this.jdParserService.parse(dto.jdText);
    return this.jdJudgeService.judge(parsed, dto.jdText);
  }

  async selectVariant(
    dto: SelectResumeVariantDto,
    user: AuthenticatedUser,
  ): Promise<SelectResumeVariantResponseDto> {
    const variantSnapshot = {
      summary: dto.variant.summary,
      experience: dto.variant.experience,
      projects: dto.variant.projects,
      skills: dto.variant.skills,
    } as unknown as Prisma.InputJsonValue;
    const scoreSnapshot = (dto.scoreSnapshot ?? undefined) as unknown as
      | Prisma.InputJsonValue
      | undefined;

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

    let libraryItemId: string | undefined;
    if (dto.addToLibrary) {
      const item = await this.prisma.resumeLibraryItem.create({
        data: {
          userId: user.id,
          sourceRequestId: dto.requestId.trim(),
          sourceMode: dto.mode,
          title: `${dto.mode} version`,
          summary: dto.variant.summary,
          experience: dto.variant.experience as unknown as Prisma.InputJsonValue,
          projects: dto.variant.projects as unknown as Prisma.InputJsonValue,
          skills: dto.variant.skills as unknown as Prisma.InputJsonValue,
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

  generateStream(dto: GenerateResumeStreamDto): Observable<ResumeSsePayload> {
    return new Observable<ResumeSsePayload>((subscriber) => {
      const requestId = `req_${Date.now()}`;
      const taskId = `task_${Date.now()}`;
      const abortController = new AbortController();
      const envelope = new SseEnvelopeFactory<ResumeSseEventType>(taskId);
      let isClosed = false;

      const emit = (type: ResumeSseEventType, payload: Record<string, unknown>) => {
        if (!isClosed) {
          subscriber.next(envelope.create(type, payload));
        }
      };

      void (async () => {
        try {
          const normalizedDto = this.parseStreamPayload(dto);

          emit('start', {
            requestId,
            taskId,
            variantCount: normalizedDto.variants,
            startedAt: new Date().toISOString(),
            status: 'running',
          });

          emit('progress', {
            requestId,
            taskId,
            progress: 10,
            stage: 'planning',
            timestamp: new Date().toISOString(),
          });

          let chunkCount = 0;
          const variants = await this.resumeAiService.generateWithStream(normalizedDto, {
            signal: abortController.signal,
            onDelta: (text) => {
              chunkCount += 1;
              emit('chunk', {
                requestId,
                taskId,
                variantIndex: 1,
                field: 'summary',
                text,
                timestamp: new Date().toISOString(),
              });

              if (chunkCount % 6 === 0) {
                emit('progress', {
                  requestId,
                  taskId,
                  progress: Math.min(90, 10 + chunkCount),
                  stage: 'generating',
                  timestamp: new Date().toISOString(),
                });
              }
            },
          });

          emit('progress', {
            requestId,
            taskId,
            progress: 100,
            stage: 'post_processing',
            timestamp: new Date().toISOString(),
          });

          emit('done', {
            requestId,
            taskId,
            variantCount: variants.length,
            variants,
            finishedAt: new Date().toISOString(),
            status: 'succeeded',
          });

          subscriber.complete();
        } catch (error) {
          const isCanceled = abortController.signal.aborted;
          if (isCanceled) {
            emit('canceled', {
              requestId,
              taskId,
              reason: 'USER_ABORT',
              timestamp: new Date().toISOString(),
              status: 'canceled',
            });
          } else {
            emit('error', {
              requestId,
              taskId,
              code: 'INTERNAL_ERROR',
              message: error instanceof Error ? error.message : 'Resume stream generation failed',
              timestamp: new Date().toISOString(),
              status: 'failed',
            });
          }
          subscriber.complete();
        }
      })();

      return () => {
        isClosed = true;
        abortController.abort();
      };
    });
  }

  private parseStreamPayload(dto: GenerateResumeStreamDto): GenerateResumeDto {
    let profile: ResumeProfileDto;
    let targetJob: ResumeTargetJobDto;

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

    if (!profile || typeof profile !== 'object') {
      throw new BadRequestException('profile is required');
    }

    if (!targetJob || typeof targetJob !== 'object') {
      throw new BadRequestException('targetJob is required');
    }

    const fullName = String(profile.fullName ?? '').trim();
    const background = String(profile.background ?? '').trim();
    const targetTitle = String(targetJob.title ?? '').trim();
    const skills = Array.isArray(profile.skills) ? profile.skills.map((item) => String(item)) : [];

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
      throw new BadRequestException('profile.skills must contain at least one item');
    }

    return {
      profile: {
        fullName,
        background,
        skills,
        experiences: Array.isArray(profile.experiences) ? profile.experiences : [],
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

  private buildRewriteTriggers(judge: JudgeJdResponseDto): string[] {
    const triggers: string[] = [];
    if (judge.overallScore < 75) {
      triggers.push('low_overall_score');
    }
    if (judge.dimensions.specificity < 75) {
      triggers.push('low_specificity');
    }
    if (judge.dimensions.measurability < 70) {
      triggers.push('low_measurability');
    }
    if (judge.dimensions.seniorityFit < 70) {
      triggers.push('low_seniority_fit');
    }
    return triggers;
  }

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

  private buildVariantDiff(
    dto: GenerateResumeDto,
    variant: {
      experience: Array<{ highlights: string[] }>;
      projects: Array<{ highlights: string[] }>;
    },
  ): {
    experienceHighlights: Array<{ before: string; after: string; changed: boolean }>;
    projectHighlights: Array<{ before: string; after: string; changed: boolean }>;
  } {
    const originalExperience = dto.profile.experiences.flatMap((item) => item.highlights);
    const generatedExperience = variant.experience.flatMap((item) => item.highlights);
    const originalProjects = dto.profile.projects.flatMap((item) => item.highlights);
    const generatedProjects = variant.projects.flatMap((item) => item.highlights);

    return {
      experienceHighlights: this.toDiffRows(originalExperience, generatedExperience),
      projectHighlights: this.toDiffRows(originalProjects, generatedProjects),
    };
  }

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

  private requireMode(mode: ResumeRewriteMode | undefined): ResumeRewriteMode {
    return mode ?? 'hybrid';
  }

  private modeOrder(mode: ResumeRewriteMode): number {
    if (mode === 'technical') {
      return 0;
    }
    if (mode === 'business') {
      return 1;
    }
    return 2;
  }
}
