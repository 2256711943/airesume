import { BadRequestException, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
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
import { JdJudgeService } from './jd-parser/jd-judge.service';
import { JdRewriterService } from './jd-parser/jd-rewriter.service';
import { ResumeAiService } from './resume.ai.service';

export interface ResumeSsePayload {
  type: 'start' | 'chunk' | 'progress' | 'done' | 'error' | 'canceled';
  data: Record<string, unknown>;
}

@Injectable()
export class ResumeService {
  constructor(
    private readonly resumeAiService: ResumeAiService,
    private readonly jdParserService: JdParserService,
    private readonly jdJudgeService: JdJudgeService,
    private readonly jdRewriterService: JdRewriterService,
  ) {}

  async generate(dto: GenerateResumeDto): Promise<GenerateResumeResponseDto> {
    const requestId = `req_${Date.now()}`;
    const variants = await this.resumeAiService.generate(dto);

    return {
      requestId,
      variants,
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

  generateStream(dto: GenerateResumeStreamDto): Observable<ResumeSsePayload> {
    return new Observable<ResumeSsePayload>((subscriber) => {
      const requestId = `req_${Date.now()}`;
      const taskId = `task_${Date.now()}`;
      const abortController = new AbortController();
      let isClosed = false;

      const emit = (payload: ResumeSsePayload) => {
        if (!isClosed) {
          subscriber.next(payload);
        }
      };

      void (async () => {
        try {
          const normalizedDto = this.parseStreamPayload(dto);

          emit({
            type: 'start',
            data: {
              requestId,
              taskId,
              variantCount: normalizedDto.variants,
              startedAt: new Date().toISOString(),
              status: 'running',
            },
          });

          emit({
            type: 'progress',
            data: {
              requestId,
              taskId,
              progress: 10,
              stage: 'planning',
              timestamp: new Date().toISOString(),
            },
          });

          let chunkCount = 0;
          const variants = await this.resumeAiService.generateWithStream(normalizedDto, {
            signal: abortController.signal,
            onDelta: (text) => {
              chunkCount += 1;
              emit({
                type: 'chunk',
                data: {
                  requestId,
                  taskId,
                  variantIndex: 1,
                  field: 'summary',
                  text,
                  timestamp: new Date().toISOString(),
                },
              });

              if (chunkCount % 6 === 0) {
                emit({
                  type: 'progress',
                  data: {
                    requestId,
                    taskId,
                    progress: Math.min(90, 10 + chunkCount),
                    stage: 'generating',
                    timestamp: new Date().toISOString(),
                  },
                });
              }
            },
          });

          emit({
            type: 'progress',
            data: {
              requestId,
              taskId,
              progress: 100,
              stage: 'post_processing',
              timestamp: new Date().toISOString(),
            },
          });

          emit({
            type: 'done',
            data: {
              requestId,
              taskId,
              variantCount: variants.length,
              variants,
              finishedAt: new Date().toISOString(),
              status: 'succeeded',
            },
          });

          subscriber.complete();
        } catch (error) {
          const isCanceled = abortController.signal.aborted;
          emit(
            isCanceled
              ? {
                  type: 'canceled',
                  data: {
                    requestId,
                    taskId,
                    reason: 'USER_ABORT',
                    timestamp: new Date().toISOString(),
                    status: 'canceled',
                  },
                }
              : {
                  type: 'error',
                  data: {
                    requestId,
                    taskId,
                    code: 'INTERNAL_ERROR',
                    message: error instanceof Error ? error.message : 'Resume stream generation failed',
                    timestamp: new Date().toISOString(),
                    status: 'failed',
                  },
                },
          );
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
}
