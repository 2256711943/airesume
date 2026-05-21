import { Injectable } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { AdoptCopyDto } from './dto/adopt-copy.dto';
import { GenerateCopyDto } from './dto/generate-copy.dto';
import { CopyVariantDto } from './dto/generate-copy-response.dto';
import { GenerateCopyResponseDto } from './dto/generate-copy-response.dto';
import { RewriteCopyResponseDto } from './dto/rewrite-copy-response.dto';
import { ScoreCopyResponseDto } from './dto/score-copy-response.dto';

export interface SsePayload {
  event: 'chunk' | 'done' | 'error';
  data: Record<string, unknown>;
}

@Injectable()
export class CopyService {
  generate(dto: GenerateCopyDto): GenerateCopyResponseDto {
    const variants = this.buildMockVariants(dto.variants);

    return {
      requestId: `req_${Date.now()}`,
      taskId: `task_${Date.now()}`,
      variants,
    };
  }

  generateStream(dto: GenerateCopyDto): Observable<SsePayload> {
    const variantCount = this.normalizeVariantCount(dto.variants);

    return of({
      event: 'done',
      data: {
        requestId: `req_${Date.now()}`,
        taskId: `task_${Date.now()}`,
        variantCount,
        timestamp: new Date().toISOString(),
      },
    });
  }

  score(copyId: string): ScoreCopyResponseDto {
    const seed = this.getScoreSeed(copyId);
    const ruleScore = 70 + (seed % 21);
    const llmScore = 68 + ((seed + 7) % 23);
    const overallScore = Number(((ruleScore * 0.5) + (llmScore * 0.5)).toFixed(1));

    return {
      ruleScore,
      llmScore,
      overallScore,
      dimensions: {
        hook: 65 + ((seed + 1) % 31),
        clarity: 65 + ((seed + 2) % 31),
        specificity: 65 + ((seed + 3) % 31),
        actionability: 65 + ((seed + 4) % 31),
        platform_fit: 65 + ((seed + 5) % 31),
      },
    };
  }

  rewrite(copyId: string): RewriteCopyResponseDto {
    return { variantId: `${copyId}_rewrite` };
  }

  adopt(copyId: string, __: AdoptCopyDto): { feedbackId: string } {
    return { feedbackId: `fb_${copyId}_${Date.now()}` };
  }

  private normalizeVariantCount(variants?: number): number {
    if (!variants || variants < 1) {
      return 3;
    }

    return Math.min(variants, 5);
  }

  private buildMockVariants(variants?: number): CopyVariantDto[] {
    const variantCount = this.normalizeVariantCount(variants);
    const mockVariants: CopyVariantDto[] = [];

    for (let i = 0; i < variantCount; i += 1) {
      const index = i + 1;
      mockVariants.push({
        id: `copy_mock_${index}`,
        title: `熬夜党也能发光的第 ${index} 版`,
        body: `高保湿精华一抹即润，轻薄不黏腻，日夜都能用，${index} 周见证肌肤状态更稳定。`,
        bullets: ['玻尿酸补水', '轻薄好吸收', '适合日常通勤妆前'],
        cta: '现在下单，今晚开始你的肌肤焕亮计划。',
      });
    }

    return mockVariants;
  }

  private getScoreSeed(copyId: string): number {
    return copyId
      .split('')
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
  }
}
