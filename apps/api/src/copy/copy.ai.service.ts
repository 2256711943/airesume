import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';

export interface CopyGenerationInput {
  productName: string;
  category: string;
  platform: string;
  tone: string;
  targetAudience: string;
  sellingPoints: string[];
  bannedTerms: string[];
  variants: number;
}

export interface AiCopyVariant {
  title: string;
  body: string;
  bullets: string[];
  cta: string;
}

interface AiGenerateResult {
  variants: AiCopyVariant[];
}

@Injectable()
export class CopyAiService implements OnModuleInit {
  private readonly logger = new Logger(CopyAiService.name);
  private readonly apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? '';
  private readonly baseUrl =
    process.env.DASHSCOPE_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  private readonly model = process.env.DASHSCOPE_MODEL?.trim() || 'qwen-plus';
  private readonly timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS ?? 20000);
  private readonly useMock = (process.env.COPY_USE_MOCK ?? 'true').toLowerCase() === 'true';

  onModuleInit(): void {
    const maskedKey = this.apiKey
      ? `${this.apiKey.slice(0, 4)}***${this.apiKey.slice(-4)}`
      : 'not-set';
    this.logger.log(
      `Copy AI mode=${this.useMock ? 'mock' : 'real'}, model=${this.model}, baseUrl=${this.baseUrl}, apiKey=${maskedKey}`,
    );
  }

  async generate(input: CopyGenerationInput): Promise<AiCopyVariant[]> {
    if (this.useMock) {
      return this.buildMockVariants(input.variants);
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException('DASHSCOPE_API_KEY is not configured');
    }

    const payload = {
      model: this.model,
      temperature: 0.7,
      response_format: { type: 'json_object' as const },
      messages: [
        {
          role: 'system',
          content:
            '你是资深电商营销文案策划。只返回严格 JSON，不要返回 Markdown，不要补充解释。',
        },
        {
          role: 'user',
          content: this.buildUserPrompt(input),
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = await response.text();
        throw new BadGatewayException(
          `DashScope request failed: ${response.status} ${message}`,
        );
      }

      const raw = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };

      const content = raw.choices?.[0]?.message?.content;
      if (!content) {
        throw new BadGatewayException('DashScope response has no content');
      }

      return this.parseVariants(content, input.variants);
    } catch (error) {
      if (error instanceof BadGatewayException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new ServiceUnavailableException('DashScope generation failed');
    } finally {
      clearTimeout(timer);
    }
  }

  isMockMode(): boolean {
    return this.useMock;
  }

  private buildUserPrompt(input: CopyGenerationInput): string {
    return [
      '请基于以下商品信息生成营销文案：',
      `商品名：${input.productName}`,
      `品类：${input.category}`,
      `平台：${input.platform}`,
      `语气：${input.tone}`,
      `目标人群：${input.targetAudience}`,
      `卖点：${input.sellingPoints.join('；')}`,
      `禁用词：${input.bannedTerms.join('；') || '无'}`,
      `版本数：${input.variants}`,
      '输出 JSON 格式如下：',
      '{"variants":[{"title":"string","body":"string","bullets":["string"],"cta":"string"}]}',
      '要求：',
      '1) 禁止使用禁用词',
      '2) 文案内容与商品强相关',
      '3) 每个版本风格有差异但语气一致',
    ].join('\n');
  }

  private parseVariants(content: string, expectedCount: number): AiCopyVariant[] {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BadGatewayException('DashScope JSON parse failed');
    }

    const variants = (parsed as AiGenerateResult).variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new BadGatewayException('DashScope output variants is empty');
    }

    const normalized = variants
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title.trim() : '',
        body: typeof item.body === 'string' ? item.body.trim() : '',
        bullets: Array.isArray(item.bullets)
          ? item.bullets.map((bullet) => String(bullet).trim()).filter((bullet) => bullet.length > 0)
          : [],
        cta: typeof item.cta === 'string' ? item.cta.trim() : '',
      }))
      .filter(
        (item) =>
          item.title.length > 0 &&
          item.body.length > 0 &&
          item.bullets.length > 0 &&
          item.cta.length > 0,
      );

    if (normalized.length === 0) {
      throw new BadGatewayException('DashScope output has no valid variant');
    }

    return normalized.slice(0, Math.max(1, expectedCount));
  }

  private buildMockVariants(variants: number): AiCopyVariant[] {
    const count = Math.min(Math.max(variants, 1), 5);
    const results: AiCopyVariant[] = [];

    for (let i = 0; i < count; i += 1) {
      const index = i + 1;
      results.push({
        title: `高保湿精华第 ${index} 版：通勤素颜也能发光`,
        body: `轻薄好吸收，不闷不黏，早晚都能用。第 ${index} 版强调“补水稳肤+上妆更服帖”，连续使用更能感受肌肤状态稳定。`,
        bullets: ['玻尿酸补水', '轻薄不黏腻', '妆前友好'],
        cta: '现在下单，今晚开始你的焕亮计划。',
      });
    }

    return results;
  }
}
