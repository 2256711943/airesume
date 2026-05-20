import { Injectable } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { AdoptCopyDto } from './dto/adopt-copy.dto';
import { GenerateCopyDto } from './dto/generate-copy.dto';
import { GenerateCopyResponseDto } from './dto/generate-copy-response.dto';
import { RewriteCopyResponseDto } from './dto/rewrite-copy-response.dto';
import { ScoreCopyResponseDto } from './dto/score-copy-response.dto';

export interface SsePayload {
  event: 'chunk' | 'done' | 'error';
  data: Record<string, unknown>;
}

@Injectable()
export class CopyService {
  generate(_: GenerateCopyDto): GenerateCopyResponseDto {
    return {
      requestId: 'req_001',
      taskId: 'task_001',
      variants: [],
    };
  }

  generateStream(_: GenerateCopyDto): Observable<SsePayload> {
    return of({
      event: 'done',
      data: {
        requestId: 'req_001',
        taskId: 'task_001',
        variantCount: 0,
        timestamp: new Date().toISOString(),
      },
    });
  }

  score(_: string): ScoreCopyResponseDto {
    return {
      ruleScore: 0,
      llmScore: 0,
      overallScore: 0,
      dimensions: {},
    };
  }

  rewrite(_: string): RewriteCopyResponseDto {
    return { variantId: 'var_002' };
  }

  adopt(_: string, __: AdoptCopyDto): { feedbackId: string } {
    return { feedbackId: 'fb_001' };
  }
}
