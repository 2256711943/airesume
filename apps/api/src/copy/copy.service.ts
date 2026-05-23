import { Injectable, NotFoundException } from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { CopyAiService } from './copy.ai.service';
import { AdoptCopyDto } from './dto/adopt-copy.dto';
import { GenerateCopyDto } from './dto/generate-copy.dto';
import { CopyVariantDto, GenerateCopyResponseDto } from './dto/generate-copy-response.dto';
import { RewriteCopyResponseDto } from './dto/rewrite-copy-response.dto';
import { ScoreCopyResponseDto } from './dto/score-copy-response.dto';

export interface SsePayload {
  event: 'chunk' | 'done' | 'error';
  data: Record<string, unknown>;
}

@Injectable()
export class CopyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly copyAiService: CopyAiService,
  ) {}

  async generate(userId: string, dto: GenerateCopyDto): Promise<GenerateCopyResponseDto> {
    const product = await this.prisma.product.findFirst({
      where: {
        id: dto.productId,
        userId,
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const variantsCount = this.normalizeVariantCount(dto.variants);
    const aiVariants = await this.copyAiService.generate({
      productName: product.name,
      category: product.category,
      platform: dto.platform,
      tone: dto.tone,
      targetAudience: product.targetAudience,
      sellingPoints: this.toStringArray(product.sellingPoints),
      bannedTerms: this.toStringArray(product.bannedTerms),
      variants: variantsCount,
    });

    const requestId = `req_${Date.now()}`;
    const task = await this.prisma.copyTask.create({
      data: {
        userId,
        productId: product.id,
        status: 'succeeded',
        requestId,
        modelName: this.copyAiService.isMockMode()
          ? 'dashscope-mock'
          : process.env.DASHSCOPE_MODEL?.trim() || 'qwen-plus',
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    const createdVariants = await Promise.all(
      aiVariants.slice(0, variantsCount).map((variant, index) =>
        this.prisma.copyVariant.create({
          data: {
            taskId: task.id,
            variantIdx: index + 1,
            title: variant.title,
            body: variant.body,
            bullets: variant.bullets,
            cta: variant.cta,
            sourceType: 'generated',
          },
        }),
      ),
    );

    const variants: CopyVariantDto[] = createdVariants.map((item) => ({
      id: item.id,
      title: item.title,
      body: item.body,
      bullets: this.toStringArray(item.bullets),
      cta: item.cta,
    }));

    return {
      requestId,
      taskId: task.id,
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

  async score(userId: string, copyId: string): Promise<ScoreCopyResponseDto> {
    const variant = await this.findVariantByUser(userId, copyId);
    const seed = this.getScoreSeed(copyId);
    const ruleScore = 70 + (seed % 21);
    const llmScore = 68 + ((seed + 7) % 23);
    const overallScore = Number(((ruleScore * 0.5) + llmScore * 0.5).toFixed(1));
    const dimensions = {
      hook: 65 + ((seed + 1) % 31),
      clarity: 65 + ((seed + 2) % 31),
      specificity: 65 + ((seed + 3) % 31),
      actionability: 65 + ((seed + 4) % 31),
      platform_fit: 65 + ((seed + 5) % 31),
    };

    await this.prisma.copyScore.create({
      data: {
        variantId: variant.id,
        ruleScore,
        llmScore,
        overall: overallScore,
        dimensions,
      },
    });

    return {
      ruleScore,
      llmScore,
      overallScore,
      dimensions,
    };
  }

  async rewrite(userId: string, copyId: string): Promise<RewriteCopyResponseDto> {
    const variant = await this.findVariantByUser(userId, copyId);
    const maxIndexResult = await this.prisma.copyVariant.aggregate({
      where: { taskId: variant.taskId },
      _max: { variantIdx: true },
    });
    const nextVariantIdx = (maxIndexResult._max.variantIdx ?? 0) + 1;

    const rewritten = await this.prisma.copyVariant.create({
      data: {
        taskId: variant.taskId,
        variantIdx: nextVariantIdx,
        title: `${variant.title}（改写）`,
        body: `${variant.body}\n\n改写建议已吸收：突出核心卖点并强化行动引导。`,
        bullets: this.toStringArray(variant.bullets),
        cta: `${variant.cta}（限时）`,
        sourceType: 'rewritten',
      },
    });

    return { variantId: rewritten.id };
  }

  async adopt(userId: string, copyId: string, dto: AdoptCopyDto): Promise<{ feedbackId: string }> {
    const variant = await this.findVariantByUser(userId, copyId);

    const feedback = await this.prisma.adoptionFeedback.create({
      data: {
        variantId: variant.id,
        userId,
        adopted: dto.adopted,
        reasonTags: dto.reasonTags,
        comment: dto.comment?.trim() ? dto.comment.trim() : null,
      },
    });

    return { feedbackId: feedback.id };
  }

  private normalizeVariantCount(variants?: number): number {
    if (!variants || variants < 1) {
      return 3;
    }

    return Math.min(variants, 5);
  }

  private getScoreSeed(copyId: string): number {
    return copyId
      .split('')
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
  }

  private async findVariantByUser(userId: string, copyId: string) {
    const variant = await this.prisma.copyVariant.findFirst({
      where: {
        id: copyId,
        task: {
          userId,
        },
      },
    });

    if (!variant) {
      throw new NotFoundException('Copy variant not found');
    }

    return variant;
  }

  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item) => String(item));
  }
}
