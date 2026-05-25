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

interface StreamGenerateOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

export interface CopyScoreInput {
  productName: string;
  category: string;
  platform: string;
  tone: string;
  targetAudience: string;
  sellingPoints: string[];
  bannedTerms: string[];
  copy: {
    title: string;
    body: string;
    bullets: string[];
    cta: string;
  };
}

export interface LlmScoreResult {
  llmScore: number;
  dimensions: Record<string, number>;
}

export interface CopyRewriteInput {
  productName: string;
  category: string;
  platform: string;
  tone: string;
  targetAudience: string;
  sellingPoints: string[];
  bannedTerms: string[];
  copy: {
    title: string;
    body: string;
    bullets: string[];
    cta: string;
  };
  score?: {
    overallScore: number;
    dimensions: Record<string, number>;
  };
}

export interface RewriteResult {
  title: string;
  body: string;
  bullets: string[];
  cta: string;
}

@Injectable()
export class CopyAiService implements OnModuleInit {
  private readonly logger = new Logger(CopyAiService.name);
  private readonly apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? '';
  private readonly baseUrl =
    process.env.DASHSCOPE_BASE_URL?.trim() ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  private readonly model = process.env.DASHSCOPE_MODEL?.trim() || 'qwen-plus';
  private readonly timeoutMs = Number(
    process.env.DASHSCOPE_TIMEOUT_MS ?? 20000,
  );
  private readonly useMock =
    (process.env.COPY_USE_MOCK ?? 'true').toLowerCase() === 'true';

  /** 启动时输出当前 AI 配置，便于排查环境与模型参数。 */
  onModuleInit(): void {
    const maskedKey = this.apiKey
      ? `${this.apiKey.slice(0, 4)}***${this.apiKey.slice(-4)}`
      : 'not-set';
    this.logger.log(
      `Copy AI mode=${this.useMock ? 'mock' : 'real'}, model=${this.model}, baseUrl=${this.baseUrl}, apiKey=${maskedKey}`,
    );
  }

  /** 按商品信息生成完整文案版本列表。 */
  async generate(input: CopyGenerationInput): Promise<AiCopyVariant[]> {
    if (this.useMock) {
      return this.buildMockVariants(input.variants);
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'DASHSCOPE_API_KEY is not configured',
      );
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
      if (
        error instanceof BadGatewayException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException('DashScope generation failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 按流式方式生成文案，并在过程中回调增量内容。 */
  async generateWithStream(
    input: CopyGenerationInput,
    options: StreamGenerateOptions = {},
  ): Promise<AiCopyVariant[]> {
    const { signal, onDelta } = options;

    if (this.useMock) {
      const mockVariants = this.buildMockVariants(input.variants);
      const raw = JSON.stringify({ variants: mockVariants });
      for (const chunk of this.chunkText(raw, 24)) {
        onDelta?.(chunk);
      }
      return mockVariants;
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'DASHSCOPE_API_KEY is not configured',
      );
    }

    const payload = {
      model: this.model,
      temperature: 0.7,
      response_format: { type: 'json_object' as const },
      stream: true,
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
    const mergedSignal = this.linkAbortSignals(signal, controller);

    let fullContent = '';

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: mergedSignal,
      });

      if (!response.ok) {
        const message = await response.text();
        throw new BadGatewayException(
          `DashScope stream request failed: ${response.status} ${message}`,
        );
      }

      if (!response.body) {
        throw new BadGatewayException('DashScope stream response has no body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let done = false;

      while (!done) {
        const readResult = await reader.read();
        done = readResult.done;
        if (!readResult.value) {
          continue;
        }

        buffer += decoder.decode(readResult.value, { stream: !done });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const lines = frame
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('data:'));

          for (const line of lines) {
            const payloadText = line.slice(5).trim();
            if (!payloadText) {
              continue;
            }

            if (payloadText === '[DONE]') {
              done = true;
              break;
            }

            let parsed: unknown;
            try {
              parsed = JSON.parse(payloadText);
            } catch {
              continue;
            }

            const delta = this.extractDeltaText(parsed);
            if (!delta) {
              continue;
            }

            fullContent += delta;
            onDelta?.(delta);
          }
        }
      }

      if (fullContent.trim().length === 0) {
        throw new BadGatewayException('DashScope stream content is empty');
      }

      return this.parseVariants(fullContent, input.variants);
    } catch (error) {
      if (
        error instanceof BadGatewayException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException(
        'DashScope stream generation failed',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** 判断当前是否使用 mock 模式。 */
  isMockMode(): boolean {
    return this.useMock;
  }

  /** 对指定文案进行评分并返回维度分。 */
  async score(input: CopyScoreInput): Promise<LlmScoreResult> {
    if (this.useMock) {
      return this.buildMockScore(input.copy.title);
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'DASHSCOPE_API_KEY is not configured',
      );
    }

    const payload = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' as const },
      messages: [
        {
          role: 'system',
          content:
            '你是电商文案评审专家。只返回严格 JSON，不要返回 Markdown，不要补充解释。',
        },
        {
          role: 'user',
          content: this.buildScorePrompt(input),
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
          `DashScope score failed: ${response.status} ${message}`,
        );
      }

      const raw = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) {
        throw new BadGatewayException(
          'DashScope score response has no content',
        );
      }

      return this.parseScore(content);
    } catch (error) {
      if (
        error instanceof BadGatewayException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException('DashScope score failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 基于评分结果与商品信息生成改写版本。 */
  async rewrite(input: CopyRewriteInput): Promise<RewriteResult> {
    if (this.useMock) {
      return this.buildMockRewrite(input.copy);
    }

    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'DASHSCOPE_API_KEY is not configured',
      );
    }

    const payload = {
      model: this.model,
      temperature: 0.5,
      response_format: { type: 'json_object' as const },
      messages: [
        {
          role: 'system',
          content:
            'You are an e-commerce copy editor. Return strict JSON only, no markdown, no explanation.',
        },
        {
          role: 'user',
          content: this.buildRewritePrompt(input),
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
          `DashScope rewrite failed: ${response.status} ${message}`,
        );
      }

      const raw = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) {
        throw new BadGatewayException(
          'DashScope rewrite response has no content',
        );
      }

      return this.parseRewrite(content);
    } catch (error) {
      if (
        error instanceof BadGatewayException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      throw new ServiceUnavailableException('DashScope rewrite failed');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 组装生成文案所需的用户提示词。 */
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

  /** 将模型输出解析为文案版本数组。 */
  private parseVariants(
    content: string,
    expectedCount: number,
  ): AiCopyVariant[] {
    const parsed = this.parseJsonObject(content, 'DashScope JSON parse failed');

    const variants = (parsed as AiGenerateResult).variants;
    if (!Array.isArray(variants) || variants.length === 0) {
      throw new BadGatewayException('DashScope output variants is empty');
    }

    const normalized = variants
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title.trim() : '',
        body: typeof item.body === 'string' ? item.body.trim() : '',
        bullets: Array.isArray(item.bullets)
          ? item.bullets
              .map((bullet) => String(bullet).trim())
              .filter((bullet) => bullet.length > 0)
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

  /** 尝试从文本中解析 JSON，对常见包裹格式做兜底。 */
  private parseJsonObject(content: string, errorMessage: string): unknown {
    const trimmed = content.trim();

    try {
      return JSON.parse(trimmed);
    } catch {
      // Try common fenced-json shape.
    }

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // Continue fallback.
      }
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(sliced);
      } catch {
        // Ignore and throw below.
      }
    }

    throw new BadGatewayException(errorMessage);
  }

  /** 组装评分任务的提示词。 */
  private buildScorePrompt(input: CopyScoreInput): string {
    return [
      '请对下面营销文案进行0-100评分。',
      `商品名：${input.productName}`,
      `品类：${input.category}`,
      `平台：${input.platform}`,
      `语气：${input.tone}`,
      `目标人群：${input.targetAudience}`,
      `卖点：${input.sellingPoints.join('；')}`,
      `禁用词：${input.bannedTerms.join('；') || '无'}`,
      '待评文案：',
      `标题：${input.copy.title}`,
      `正文：${input.copy.body}`,
      `要点：${input.copy.bullets.join('；')}`,
      `CTA：${input.copy.cta}`,
      '只返回 JSON：',
      '{"llmScore":80,"dimensions":{"hook":80,"clarity":80,"specificity":80,"actionability":80,"platform_fit":80}}',
      '要求：所有分数为0到100之间的数字。',
    ].join('\n');
  }

  /** 组装改写任务的提示词。 */
  private buildRewritePrompt(input: CopyRewriteInput): string {
    const scoreLine = input.score
      ? `Current score: ${input.score.overallScore}, dimensions: ${JSON.stringify(input.score.dimensions)}`
      : 'Current score: unavailable';

    return [
      'Rewrite the marketing copy for better clarity, stronger hook, and better platform fit.',
      `Product: ${input.productName}`,
      `Category: ${input.category}`,
      `Platform: ${input.platform}`,
      `Tone: ${input.tone}`,
      `Target audience: ${input.targetAudience}`,
      `Selling points: ${input.sellingPoints.join('; ')}`,
      `Banned terms: ${input.bannedTerms.join('; ') || 'none'}`,
      scoreLine,
      'Original copy:',
      `Title: ${input.copy.title}`,
      `Body: ${input.copy.body}`,
      `Bullets: ${input.copy.bullets.join('; ')}`,
      `CTA: ${input.copy.cta}`,
      'Return JSON only:',
      '{"title":"string","body":"string","bullets":["string"],"cta":"string"}',
      'Rules: keep facts consistent, avoid banned terms, keep action-oriented CTA.',
    ].join('\n');
  }

  /** 将评分模型返回值解析成结构化分数。 */
  private parseScore(content: string): LlmScoreResult {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BadGatewayException('DashScope score JSON parse failed');
    }

    const obj = parsed as {
      llmScore?: unknown;
      dimensions?: Record<string, unknown>;
    };

    const llmScore = this.normalizeScoreValue(obj.llmScore);
    const dimensionsInput = obj.dimensions ?? {};
    const dimensions: Record<string, number> = {
      hook: this.normalizeScoreValue(dimensionsInput.hook),
      clarity: this.normalizeScoreValue(dimensionsInput.clarity),
      specificity: this.normalizeScoreValue(dimensionsInput.specificity),
      actionability: this.normalizeScoreValue(dimensionsInput.actionability),
      platform_fit: this.normalizeScoreValue(dimensionsInput.platform_fit),
    };

    return {
      llmScore,
      dimensions,
    };
  }

  /** 将任意值归一化为 0-100 的整数分数。 */
  private normalizeScoreValue(value: unknown): number {
    const num = Number(value);
    if (Number.isNaN(num)) {
      return 75;
    }

    return Math.max(0, Math.min(100, Math.round(num)));
  }

  /** 将改写模型返回值解析成结构化文案。 */
  private parseRewrite(content: string): RewriteResult {
    let parsed: unknown;

    try {
      parsed = JSON.parse(content);
    } catch {
      throw new BadGatewayException('DashScope rewrite JSON parse failed');
    }

    const obj = parsed as Partial<RewriteResult>;
    const title = typeof obj.title === 'string' ? obj.title.trim() : '';
    const body = typeof obj.body === 'string' ? obj.body.trim() : '';
    const cta = typeof obj.cta === 'string' ? obj.cta.trim() : '';
    const bullets = Array.isArray(obj.bullets)
      ? obj.bullets
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0)
      : [];

    if (!title || !body || !cta || bullets.length === 0) {
      throw new BadGatewayException('DashScope rewrite output is invalid');
    }

    return { title, body, bullets, cta };
  }

  /** 生成 mock 文案版本，供本地联调使用。 */
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

  /** 生成 mock 分数，供本地联调使用。 */
  private buildMockScore(seedText: string): LlmScoreResult {
    const seed = seedText
      .split('')
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);

    return {
      llmScore: 72 + (seed % 21),
      dimensions: {
        hook: 68 + ((seed + 1) % 28),
        clarity: 68 + ((seed + 2) % 28),
        specificity: 68 + ((seed + 3) % 28),
        actionability: 68 + ((seed + 4) % 28),
        platform_fit: 68 + ((seed + 5) % 28),
      },
    };
  }

  /** 提取流式返回中的增量文本片段。 */
  private extractDeltaText(parsed: unknown): string {
    if (!parsed || typeof parsed !== 'object') {
      return '';
    }

    const obj = parsed as {
      choices?: Array<{
        delta?: { content?: unknown };
        message?: { content?: unknown };
      }>;
    };

    const choice = obj.choices?.[0];
    const deltaContent = choice?.delta?.content;
    if (typeof deltaContent === 'string' && deltaContent.length > 0) {
      return deltaContent;
    }

    const messageContent = choice?.message?.content;
    if (typeof messageContent === 'string' && messageContent.length > 0) {
      return messageContent;
    }

    return '';
  }

  /** 按固定长度切分文本，模拟流式分片。 */
  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /** 将外部 AbortSignal 与内部控制器绑定到一起。 */
  private linkAbortSignals(
    external: AbortSignal | undefined,
    internal: AbortController,
  ): AbortSignal {
    if (!external) {
      return internal.signal;
    }

    if (external.aborted) {
      internal.abort();
      return internal.signal;
    }

    external.addEventListener(
      'abort',
      () => {
        internal.abort();
      },
      { once: true },
    );

    return internal.signal;
  }

  /** 生成 mock 改写结果，供本地联调使用。 */
  private buildMockRewrite(copy: {
    title: string;
    body: string;
    bullets: string[];
    cta: string;
  }): RewriteResult {
    return {
      title: `${copy.title} | Strengthened`,
      body: `${copy.body}\n\nRewrite focus: clearer value proposition and stronger action signal.`,
      bullets:
        copy.bullets.length > 0
          ? copy.bullets
          : ['Clear benefit', 'Platform-friendly phrasing'],
      cta: copy.cta.endsWith('!') ? copy.cta : `${copy.cta}!`,
    };
  }
}
