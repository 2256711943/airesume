import { BadRequestException, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  GenerateResumeDto,
  type ResumeProfileDto,
  type ResumeTargetJobDto,
} from './dto/generate-resume.dto';
import { GenerateResumeStreamDto } from './dto/generate-resume-stream.dto';
import { type GenerateResumeResponseDto } from './dto/generate-resume-response.dto';
import { ResumeAiService } from './resume.ai.service';

export interface ResumeSsePayload {
  type: 'start' | 'chunk' | 'progress' | 'done' | 'error' | 'canceled';
  data: Record<string, unknown>;
}

@Injectable()
export class ResumeService {
  constructor(private readonly resumeAiService: ResumeAiService) {}

  async generate(dto: GenerateResumeDto): Promise<GenerateResumeResponseDto> {
    const requestId = `req_${Date.now()}`;
    const variants = await this.resumeAiService.generate(dto);

    return {
      requestId,
      variants,
    };
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
}
