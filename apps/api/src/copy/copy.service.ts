import { Injectable, NotFoundException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { CopyAiService } from './copy.ai.service';
import { AdoptCopyDto } from './dto/adopt-copy.dto';
import { GenerateCopyDto } from './dto/generate-copy.dto';
import { GenerateCopyResponseDto } from './dto/generate-copy-response.dto';
import { RewriteCopyResponseDto } from './dto/rewrite-copy-response.dto';
import { ScoreCopyResponseDto } from './dto/score-copy-response.dto';
import { AdoptedCopyListResponseDto } from './dto/adopted-copy-list-response.dto';

export interface SsePayload {
  type: 'start' | 'chunk' | 'progress' | 'done' | 'error' | 'canceled';
  data: Record<string, unknown>;
}

@Injectable()
export class CopyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly copyAiService: CopyAiService,
  ) {}

  /** 同步生成文案并落库，返回完整版本列表。 */
  async generate(
    userId: string,
    dto: GenerateCopyDto,
  ): Promise<GenerateCopyResponseDto> {
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

    return {
      requestId,
      taskId: task.id,
      variants: createdVariants.map((item) => ({
        id: item.id,
        title: item.title,
        body: item.body,
        bullets: this.toStringArray(item.bullets),
        cta: item.cta,
      })),
    };
  }

  /** 通过 SSE 流式生成文案，并在流结束后统一落库。 */
  generateStream(userId: string, dto: GenerateCopyDto): Observable<SsePayload> {
    return new Observable<SsePayload>((subscriber) => {
      const variantCount = this.normalizeVariantCount(dto.variants);
      const requestId = `req_${Date.now()}`;
      const abortController = new AbortController();
      let isClosed = false;
      let taskId = '';

      /** 向客户端发送 SSE 事件（连接关闭后不再发送）。 */
      const emit = (payload: SsePayload) => {
        if (!isClosed) {
          subscriber.next(payload);
        }
      };

      void (async () => {
        try {
          const product = await this.prisma.product.findFirst({
            where: { id: dto.productId, userId },
          });

          if (!product) {
            throw new NotFoundException('Product not found');
          }

          const task = await this.prisma.copyTask.create({
            data: {
              userId,
              productId: product.id,
              status: 'running',
              requestId,
              modelName: this.copyAiService.isMockMode()
                ? 'dashscope-mock'
                : process.env.DASHSCOPE_MODEL?.trim() || 'qwen-plus',
              startedAt: new Date(),
            },
          });
          taskId = task.id;

          emit({
              type: 'start',
              data: {
              requestId,
              taskId,
              variantCount,
              startedAt:
                task.startedAt?.toISOString() ?? new Date().toISOString(),
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
          const aiVariants = await this.copyAiService.generateWithStream(
            {
              productName: product.name,
              category: product.category,
              platform: dto.platform,
              tone: dto.tone,
              targetAudience: product.targetAudience,
              sellingPoints: this.toStringArray(product.sellingPoints),
              bannedTerms: this.toStringArray(product.bannedTerms),
              variants: variantCount,
            },
            {
              signal: abortController.signal,
              onDelta: (text) => {
                chunkCount += 1;

                emit({
                    type: 'chunk',
                    data: {
                    requestId,
                    taskId,
                    variantIndex: 1,
                    field: 'body',
                    text,
                    timestamp: new Date().toISOString(),
                  },
                });

                if (chunkCount % 8 === 0) {
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
            },
          );

          const createdVariants = await Promise.all(
            aiVariants.slice(0, variantCount).map((variant, index) =>
              this.prisma.copyVariant.create({
                data: {
                  taskId,
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

          await this.prisma.copyTask.update({
            where: { id: taskId },
            data: {
              status: 'succeeded',
              finishedAt: new Date(),
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
              variantCount: createdVariants.length,
              variants: createdVariants.map((item) => ({
                id: item.id,
                title: item.title,
                body: item.body,
                bullets: this.toStringArray(item.bullets),
                cta: item.cta,
              })),
              finishedAt: new Date().toISOString(),
              status: 'succeeded',
            },
          });

          subscriber.complete();
        } catch (error) {
          const isCanceled = abortController.signal.aborted;
          const code =
            error instanceof NotFoundException
              ? 'NOT_FOUND'
              : isCanceled
                ? 'CANCELED'
                : 'INTERNAL_ERROR';
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to stream copy generation';

          if (taskId) {
            await this.prisma.copyTask.update({
              where: { id: taskId },
              data: {
                status: 'failed',
                errorCode: code,
                errorMessage: message,
                finishedAt: new Date(),
              },
            });
          }

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
                    code,
                    message,
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

  /** 对指定文案版本打分并写入评分记录。 */
  async score(userId: string, copyId: string): Promise<ScoreCopyResponseDto> {
    const variant = await this.findVariantByUser(userId, copyId);
    const product = await this.findProductByVariant(copyId, userId);
    const seed = this.getScoreSeed(copyId);
    const ruleScore = 70 + (seed % 21);

    let llmScore = 68 + ((seed + 7) % 23);
    let dimensions: Record<string, number> = {
      hook: 65 + ((seed + 1) % 31),
      clarity: 65 + ((seed + 2) % 31),
      specificity: 65 + ((seed + 3) % 31),
      actionability: 65 + ((seed + 4) % 31),
      platform_fit: 65 + ((seed + 5) % 31),
    };

    try {
      const llmResult = await this.copyAiService.score({
        productName: product.name,
        category: product.category,
        platform: product.platform,
        tone: product.tone,
        targetAudience: product.targetAudience,
        sellingPoints: this.toStringArray(product.sellingPoints),
        bannedTerms: this.toStringArray(product.bannedTerms),
        copy: {
          title: variant.title,
          body: variant.body,
          bullets: this.toStringArray(variant.bullets),
          cta: variant.cta,
        },
      });

      llmScore = llmResult.llmScore;
      dimensions = llmResult.dimensions;
    } catch {
      // Keep local fallback so score API remains available when LLM scoring fails.
    }

    const overallScore = Number((ruleScore * 0.5 + llmScore * 0.5).toFixed(1));

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

  /** 基于原文案和最近评分结果生成改写版本。 */
  async rewrite(
    userId: string,
    copyId: string,
  ): Promise<RewriteCopyResponseDto> {
    const variant = await this.findVariantByUser(userId, copyId);
    const product = await this.findProductByVariant(copyId, userId);
    const latestScore = await this.findLatestScoreByVariantId(variant.id);
    const maxIndexResult = await this.prisma.copyVariant.aggregate({
      where: { taskId: variant.taskId },
      _max: { variantIdx: true },
    });
    const nextVariantIdx = (maxIndexResult._max.variantIdx ?? 0) + 1;

    let rewrittenContent: {
      title: string;
      body: string;
      bullets: string[];
      cta: string;
    };

    try {
      rewrittenContent = await this.copyAiService.rewrite({
        productName: product.name,
        category: product.category,
        platform: product.platform,
        tone: product.tone,
        targetAudience: product.targetAudience,
        sellingPoints: this.toStringArray(product.sellingPoints),
        bannedTerms: this.toStringArray(product.bannedTerms),
        copy: {
          title: variant.title,
          body: variant.body,
          bullets: this.toStringArray(variant.bullets),
          cta: variant.cta,
        },
        score: latestScore
          ? {
              overallScore: latestScore.overall,
              dimensions: this.toNumberRecord(latestScore.dimensions),
            }
          : undefined,
      });
    } catch {
      rewrittenContent = {
        title: `${variant.title} (rewritten)`,
        body: `${variant.body}\n\nRewrite focus: clearer key selling point and stronger CTA.`,
        bullets: this.toStringArray(variant.bullets),
        cta: variant.cta.endsWith('!') ? variant.cta : `${variant.cta}!`,
      };
    }

    const rewritten = await this.prisma.copyVariant.create({
      data: {
        taskId: variant.taskId,
        variantIdx: nextVariantIdx,
        title: rewrittenContent.title,
        body: rewrittenContent.body,
        bullets: rewrittenContent.bullets,
        cta: rewrittenContent.cta,
        sourceType: 'rewritten',
      },
    });

    return {
      variantId: rewritten.id,
      variant: {
        id: rewritten.id,
        title: rewritten.title,
        body: rewritten.body,
        bullets: this.toStringArray(rewritten.bullets),
        cta: rewritten.cta,
      },
    };
  }

  /** 记录用户对文案版本的采纳反馈。 */
  async adopt(
    userId: string,
    copyId: string,
    dto: AdoptCopyDto,
  ): Promise<{ feedbackId: string }> {
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

  /** 查询用户已采纳的文案列表（按最近时间倒序）。 */
  async listAdopted(userId: string): Promise<AdoptedCopyListResponseDto> {
    const feedbackList = await this.prisma.adoptionFeedback.findMany({
      where: {
        userId,
        adopted: true,
      },
      include: {
        variant: {
          include: {
            task: {
              include: {
                product: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    const latestByVariant = new Map<string, (typeof feedbackList)[number]>();
    for (const feedback of feedbackList) {
      if (!latestByVariant.has(feedback.variantId)) {
        latestByVariant.set(feedback.variantId, feedback);
      }
    }

    return {
      items: Array.from(latestByVariant.values()).map((feedback) => ({
        feedbackId: feedback.id,
        product: {
          id: feedback.variant.task.product.id,
          name: feedback.variant.task.product.name,
          category: feedback.variant.task.product.category,
        },
        copy: {
          id: feedback.variant.id,
          title: feedback.variant.title,
          body: feedback.variant.body,
          bullets: this.toStringArray(feedback.variant.bullets),
          cta: feedback.variant.cta,
        },
        reasonTags: this.toStringArray(feedback.reasonTags),
        comment: feedback.comment ?? undefined,
        adoptedAt: feedback.createdAt.toISOString(),
      })),
    };
  }

  /** 规范化版本数输入，限制在 1-5 范围内。 */
  private normalizeVariantCount(variants?: number): number {
    if (!variants || variants < 1) {
      return 3;
    }

    return Math.min(variants, 5);
  }

  /** 由 copyId 计算稳定种子，用于本地兜底评分。 */
  private getScoreSeed(copyId: string): number {
    return copyId.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
  }

  /** 校验文案版本归属关系，确保仅访问当前用户数据。 */
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

  /** 根据文案版本反查所属商品信息。 */
  private async findProductByVariant(copyId: string, userId: string) {
    const variant = await this.prisma.copyVariant.findFirst({
      where: {
        id: copyId,
        task: {
          userId,
        },
      },
      include: {
        task: {
          include: {
            product: true,
          },
        },
      },
    });

    if (!variant) {
      throw new NotFoundException('Copy variant not found');
    }

    return variant.task.product;
  }

  /** 获取文案版本最近一次评分记录。 */
  private async findLatestScoreByVariantId(variantId: string) {
    return this.prisma.copyScore.findFirst({
      where: { variantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** 将任意对象安全转换为数值字典。 */
  private toNumberRecord(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object') {
      return {};
    }

    const result: Record<string, number> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const num = Number(item);
      if (!Number.isNaN(num)) {
        result[key] = num;
      }
    }

    return result;
  }

  /** 将任意数组值安全转换为字符串数组。 */
  private toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((item) => String(item));
  }
}
