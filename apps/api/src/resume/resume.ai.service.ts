import { Injectable } from '@nestjs/common';
import {
  type GenerateResumeDto,
  type ResumeExperienceDto,
  type ResumeProjectDto,
} from './dto/generate-resume.dto';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import { JdParserService } from './jd-parser/jd-parser.service';
import { type ResumeVariantScore } from './resume-scorer.service';

/**
 * 简历 AI 生成服务（ResumeAiService）
 *
 * 负责简历变体的实际生成：
 * - 配置了 DashScope（通义千问）时走 LLM 生成，失败的模式自动降级为本地规则生成；
 * - 未配置 DashScope 时使用本地规则引擎直接产出（离线兜底）；
 * - 支持结构化 JSON 生成（generate）与 Markdown 流式生成（generateWithStream）。
 */

/** AI 生成的简历变体结构。 */
export interface AiResumeVariant {
  id: string;
  /** 生成所采用的重写模式（技术/商务/综合）。 */
  mode?: ResumeRewriteMode;
  /** 使用的 prompt 版本号（便于回溯与 A/B 对比）。 */
  promptVersion?: string;
  /** 个人简介。 */
  summary: string;
  /** 工作经历（公司 + 角色 + 亮点）。 */
  experience: Array<{
    company: string;
    role: string;
    highlights: string[];
  }>;
  /** 项目经历（项目名 + 亮点）。 */
  projects: Array<{
    name: string;
    highlights: string[];
  }>;
  /** 技能清单。 */
  skills: string[];
}

/** 简历重写模式：技术向 / 商务向 / 综合向。 */
export type ResumeRewriteMode = 'technical' | 'business' | 'hybrid';
/** 历史遗留的模式名，需要映射到新模式。 */
type LegacyRewriteMode = 'professional' | 'result_oriented' | 'technical_depth';
/** 各模式对应的 prompt 版本号映射。 */
export interface ResumePromptVersionMap {
  technical: string;
  business: string;
  hybrid: string;
}

/** 流式生成选项：中止信号 + 增量文本回调。 */
interface StreamOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** 通义千问 Chat 接口的消息结构。 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 通义千问非流式响应结构（只取需要字段）。 */
interface DashscopeChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/** 通义千问流式响应单帧结构。 */
interface DashscopeChatStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
}

@Injectable()
export class ResumeAiService {
  constructor(private readonly jdParserService: JdParserService) {}

  /**
   * 按模式批量生成简历变体（结构化 JSON）。
   * - 有 DashScope 配置：各模式并发调用 LLM，失败的降级为本地生成；
   * - 无配置：全部走本地规则生成。
   */
  async generate(
    input: GenerateResumeDto,
    promptVersions?: Partial<ResumePromptVersionMap>,
  ): Promise<AiResumeVariant[]> {
    // 归一化并排序重写模式
    const rewriteModes = this.normalizeRewriteModes(input.rewriteModes);
    return this.generateByModes(input, rewriteModes, promptVersions);
  }

  /** 按模式逐个生成：优先 LLM，缺失/失败时回退本地规则生成。 */
  private async generateByModes(
    input: GenerateResumeDto,
    modes: ResumeRewriteMode[],
    promptVersions?: Partial<ResumePromptVersionMap>,
  ): Promise<AiResumeVariant[]> {
    if (this.hasDashscopeConfig()) {
      // 并发发起各模式的 LLM 生成，容错收集结果
      const candidates = await Promise.allSettled(
        modes.map((mode, index) =>
          this.generateSingleModeWithDashscope(
            input,
            mode,
            index + 1,
            promptVersions?.[mode],
          ),
        ),
      );
      // 仅保留成功且 summary 非空的模式结果
      const byMode = new Map<ResumeRewriteMode, AiResumeVariant>();
      candidates.forEach((result, index) => {
        if (
          result.status === 'fulfilled' &&
          result.value.summary.trim().length > 0
        ) {
          byMode.set(modes[index], result.value);
        }
      });

      // 按模式顺序输出；LLM 结果缺失的模式用本地规则生成兜底
      return modes.map(
        (mode, index) =>
          byMode.get(mode) ??
          this.generateLocalModeVariant(
            input,
            mode,
            index + 1,
            promptVersions?.[mode],
          ),
      );
    }

    // 无 DashScope：全部本地生成
    return modes.map((mode, index) =>
      this.generateLocalModeVariant(
        input,
        mode,
        index + 1,
        promptVersions?.[mode],
      ),
    );
  }

  /**
   * 流式生成简历。
   * - 无 DashScope：本地生成后按块模拟输出（打字机效果）；
   * - 有 DashScope：结构化变体与 Markdown 流并行，一边流式输出一边完成解析。
   */
  async generateWithStream(
    input: GenerateResumeDto,
    options: StreamOptions = {},
  ): Promise<AiResumeVariant[]> {
    // 离线兜底：本地生成 + 切块模拟流式
    if (!this.hasDashscopeConfig()) {
      const variants = this.generateLocalVariants(input);
      const markdown = this.renderMarkdownResume(
        variants[0],
        input.profile.fullName.trim(),
        input.targetJob.title.trim(),
      );
      const chunks = this.chunkText(markdown, 32);

      // 逐块回调，并支持中止
      for (const chunk of chunks) {
        if (options.signal?.aborted) {
          break;
        }
        options.onDelta?.(chunk);
        await this.sleep(20);
      }

      return variants;
    }

    // LLM 模式：结构化结果与 Markdown 流并行执行
    const variantsPromise = this.generate(input);
    const markdownPromise = this.streamMarkdownResume(input, options);
    const [variants] = await Promise.all([variantsPromise, markdownPromise]);

    return variants;
  }

  /**
   * 基于评分反馈与可选外部上下文（如联网搜索摘要），对单个变体做定向重写。
   * 供 `ResumeAgentLoopService` 每轮迭代使用：
   * - 无 LLM 配置时原样返回（loop 无进展，由上层停止条件兜底）；
   * - LLM 输出为空/非法时同样回退到原变体，保证不丢结果。
   */
  async rewriteVariantWithFeedback(
    input: GenerateResumeDto,
    variant: AiResumeVariant,
    feedback: ResumeVariantScore,
    externalContext = '',
  ): Promise<AiResumeVariant> {
    if (!this.hasDashscopeConfig()) {
      return variant;
    }

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are an expert resume writer.',
          'Return valid JSON only.',
          'Do not wrap JSON in markdown fences.',
          'Output schema:',
          '{"variants":[{"id":"v1","summary":"...","experience":[{"company":"...","role":"...","highlights":["..."]}],"projects":[{"name":"...","highlights":["..."]}],"skills":["..."]}]}',
          'Generate exactly 1 variant.',
          'Improve the given variant to address the judge feedback.',
          'Never fabricate facts beyond user-provided experiences and projects.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          await this.buildStructuredPrompt(input),
          '',
          'Variant to improve (JSON):',
          JSON.stringify({
            summary: variant.summary,
            experience: variant.experience,
            projects: variant.projects,
            skills: variant.skills,
          }),
          '',
          'Judge feedback:',
          `overall score: ${feedback.overallScore}`,
          `dimensions: ${JSON.stringify(feedback.dimensions)}`,
          `issues: ${feedback.issues.join('; ') || 'none'}`,
          `suggestions: ${feedback.suggestions.join('; ') || 'none'}`,
          externalContext
            ? `Latest technical knowledge context:\n${externalContext}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ];

    const response = (await this.requestDashscope(
      messages,
      false,
    )) as DashscopeChatResponse;
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return variant;
    }

    const parsed = this.parseDashscopeVariants(content);
    if (parsed.length === 0) {
      return variant;
    }

    return {
      ...parsed[0],
      id: variant.id,
      mode: variant.mode,
      promptVersion: variant.promptVersion,
    };
  }

  /**
   * 归一化重写模式列表：
   * - 未传/空数组时使用默认三模式；
   * - 兼容旧模式名映射；去重后按默认顺序重排。
   */
  private normalizeRewriteModes(
    modes: GenerateResumeDto['rewriteModes'] | undefined,
  ): ResumeRewriteMode[] {
    const defaults: ResumeRewriteMode[] = ['technical', 'business', 'hybrid'];
    if (!Array.isArray(modes) || modes.length === 0) {
      return defaults;
    }

    const mapped = modes
      .map((mode) => this.mapLegacyMode(mode))
      .filter((mode): mode is ResumeRewriteMode => Boolean(mode));
    const unique = Array.from(new Set(mapped));
    if (unique.length === 0) {
      return defaults;
    }

    const ordered = defaults.filter((mode) => unique.includes(mode));
    return ordered.length > 0 ? ordered : defaults;
  }

  /** 模式 -> 本地生成风格映射（business=impact, technical=technical, 其余 focused）。 */
  private modeToLocalStyle(
    mode: ResumeRewriteMode,
  ): 'focused' | 'impact' | 'leadership' | 'technical' {
    if (mode === 'business') {
      return 'impact';
    }
    if (mode === 'technical') {
      return 'technical';
    }
    return 'focused';
  }

  /** 使用本地规则生成单个模式的变体。 */
  private generateLocalModeVariant(
    input: GenerateResumeDto,
    mode: ResumeRewriteMode,
    index: number,
    promptVersion?: string,
  ): AiResumeVariant {
    const variant = this.buildVariant(
      input,
      index,
      this.modeToLocalStyle(mode),
      promptVersion,
    );
    return {
      ...variant,
      id: `${mode}_v${index}`,
      mode,
      promptVersion: promptVersion ?? this.defaultPromptVersion(mode),
    };
  }

  /** 新模式名直接返回；旧模式名转交内部映射。 */
  private mapLegacyMode(mode: string): ResumeRewriteMode | undefined {
    if (mode === 'technical' || mode === 'business' || mode === 'hybrid') {
      return mode;
    }
    return this.mapLegacyModeInternal(mode as LegacyRewriteMode);
  }

  /** 旧模式名到新模式的映射（technical_depth->technical 等）。 */
  private mapLegacyModeInternal(mode: LegacyRewriteMode): ResumeRewriteMode {
    if (mode === 'technical_depth') {
      return 'technical';
    }
    if (mode === 'result_oriented') {
      return 'business';
    }
    return 'hybrid';
  }

  /** 本地生成 N 个变体（按 focused/impact/leadership 三种风格轮换）。 */
  private generateLocalVariants(input: GenerateResumeDto): AiResumeVariant[] {
    const count = this.normalizeVariantCount(input.variants);
    const results: AiResumeVariant[] = [];

    for (let i = 0; i < count; i += 1) {
      const variantNo = i + 1;
      const style = i === 0 ? 'focused' : i === 1 ? 'impact' : 'leadership';
      results.push(this.buildVariant(input, variantNo, style));
    }

    return results;
  }

  /** 把单个变体渲染为 Markdown 简历文本（本地模拟流式时使用）。 */
  private renderMarkdownResume(
    variant: AiResumeVariant | undefined,
    fullName: string,
    targetRole: string,
  ): string {
    if (!variant) {
      return `# ${fullName || '候选人'} - ${targetRole || '目标岗位'}\n\n暂未生成可展示的简历内容。`;
    }

    // 工作经历段落
    const experienceSection = variant.experience
      .map((item) => {
        const highlights = item.highlights
          .map((highlight) => `- ${highlight}`)
          .join('\n');
        return `### ${item.company} | ${item.role}\n${highlights}`;
      })
      .join('\n\n');

    // 项目经历段落
    const projectSection = variant.projects
      .map((item) => {
        const highlights = item.highlights
          .map((highlight) => `- ${highlight}`)
          .join('\n');
        return `### ${item.name}\n${highlights}`;
      })
      .join('\n\n');

    const skillsSection = variant.skills.join(' / ');

    return [
      `# ${fullName || '候选人'} - ${targetRole || '目标岗位'}`,
      '',
      '## 个人简介',
      variant.summary,
      '',
      '## 工作经历',
      experienceSection || '- 暂无工作经历',
      '',
      '## 项目经历',
      projectSection || '- 暂无项目经历',
      '',
      '## 技能清单',
      skillsSection || '暂无技能信息',
    ].join('\n');
  }

  /** 构建单个本地变体（含 summary / experience / projects / skills）。 */
  private buildVariant(
    input: GenerateResumeDto,
    variantNo: number,
    style: 'focused' | 'impact' | 'leadership' | 'technical',
    promptVersion?: string,
  ): AiResumeVariant {
    const role = input.targetJob.title.trim();
    const name = input.profile.fullName.trim();
    // 个人技能与岗位必须技能合并去重
    const skills = this.mergeSkills(
      input.profile.skills,
      input.targetJob.mustHaveSkills,
    );
    const summary = this.buildSummary(
      name,
      role,
      input.profile.background,
      style,
    );

    return {
      id: `v${variantNo}`,
      promptVersion,
      summary,
      experience: this.normalizeExperience(
        input.profile.experiences,
        role,
        style,
      ),
      projects: this.normalizeProjects(input.profile.projects, role, style),
      skills,
    };
  }

  /** 按风格生成个人简介模板文案。 */
  private buildSummary(
    fullName: string,
    role: string,
    background: string,
    style: 'focused' | 'impact' | 'leadership' | 'technical',
  ): string {
    // 结果导向（商务向）
    if (style === 'impact') {
      return `${fullName} is a results-oriented candidate targeting ${role}. ${background} Focuses on measurable delivery, reliability, and execution quality.`;
    }

    // 协作领导力
    if (style === 'leadership') {
      return `${fullName} is a collaborative ${role} candidate. ${background} Brings cross-team communication and ownership in ambiguous projects.`;
    }

    // 技术深度
    if (style === 'technical') {
      return `${fullName} is a technically deep ${role} candidate. ${background} Focuses on architecture quality, performance tradeoffs, and engineering reliability.`;
    }

    // 综合/聚焦默认
    return `${fullName} is a ${role} candidate. ${background} Strong in system thinking, delivery speed, and practical problem solving.`;
  }

  /** 归一化工作经历；为空时提供占位信息。 */
  private normalizeExperience(
    experiences: ResumeExperienceDto[],
    role: string,
    style: 'focused' | 'impact' | 'leadership' | 'technical',
  ): AiResumeVariant['experience'] {
    if (!Array.isArray(experiences) || experiences.length === 0) {
      return [
        {
          company: 'N/A',
          role,
          highlights: [
            'No structured experience provided. Add one or more experiences for stronger output.',
          ],
        },
      ];
    }

    return experiences.map((item) => ({
      company: item.company,
      role: item.role,
      highlights: this.rewriteHighlights(item.highlights, style),
    }));
  }

  /** 归一化项目经历；为空时提供占位信息。 */
  private normalizeProjects(
    projects: ResumeProjectDto[],
    role: string,
    style: 'focused' | 'impact' | 'leadership' | 'technical',
  ): AiResumeVariant['projects'] {
    if (!Array.isArray(projects) || projects.length === 0) {
      return [
        {
          name: `${role} Relevant Project`,
          highlights: [
            'No project details provided. Add project highlights to improve role matching.',
          ],
        },
      ];
    }

    return projects.map((item) => ({
      name: item.name,
      highlights: this.rewriteHighlights(item.highlights, style),
    }));
  }

  /** 按风格给每条亮点追加改写提示后缀。 */
  private rewriteHighlights(
    highlights: string[],
    style: 'focused' | 'impact' | 'leadership' | 'technical',
  ): string[] {
    return highlights.map((text) => {
      const clean = text.trim();
      if (clean.length === 0) {
        return clean;
      }

      if (style === 'impact') {
        return `${clean} (emphasize measurable impact)`;
      }

      if (style === 'leadership') {
        return `${clean} (highlight collaboration and ownership)`;
      }

      if (style === 'technical') {
        return `${clean} (highlight architecture choices, tradeoffs, and technical depth)`;
      }

      return `${clean} (highlight role relevance)`;
    });
  }

  /** 合并个人技能与岗位技能，去重后最多保留 20 项。 */
  private mergeSkills(profileSkills: string[], jobSkills: string[]): string[] {
    const merged = [...profileSkills, ...jobSkills]
      .map((item) => item.trim())
      .filter(Boolean);
    return Array.from(new Set(merged)).slice(0, 20);
  }

  /** 归一化变体数量：下限 1，上限 3。 */
  private normalizeVariantCount(value: number): number {
    if (!value || value < 1) {
      return 1;
    }
    return Math.min(value, 3);
  }

  /** 将长文本按固定长度切块（用于本地模拟流式输出）。 */
  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /** 简易延时工具。 */
  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 是否已配置 DashScope（API Key + 模型名均存在）。 */
  private hasDashscopeConfig(): boolean {
    return Boolean(
      process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_MODEL,
    );
  }

  /**
   * 使用 DashScope 生成单个模式的简历变体（结构化 JSON）。
   * 系统提示词要求仅输出 JSON；解析失败会抛出错误交由上层降级。
   */
  private async generateSingleModeWithDashscope(
    input: GenerateResumeDto,
    mode: ResumeRewriteMode,
    index: number,
    promptVersion?: string,
  ): Promise<AiResumeVariant> {
    const resolvedPromptVersion =
      promptVersion ?? this.defaultPromptVersion(mode);
    const modeInstruction = this.getModeInstruction(
      mode,
      resolvedPromptVersion,
    );
    // 组装对话消息：系统指令 + 用户输入
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are an expert resume writer.',
          'Return valid JSON only.',
          'Do not wrap JSON in markdown fences.',
          'Output schema:',
          '{"variants":[{"id":"v1","summary":"...","experience":[{"company":"...","role":"...","highlights":["..."]}],"projects":[{"name":"...","highlights":["..."]}],"skills":["..."]}]}',
          'Generate exactly 1 variant.',
          'Never fabricate facts beyond user-provided experiences and projects.',
          modeInstruction,
        ].join(' '),
      },
      {
        role: 'user',
        content: await this.buildStructuredPrompt(input),
      },
    ];

    const response = (await this.requestDashscope(
      messages,
      false,
    )) as DashscopeChatResponse;
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('DashScope returned empty content');
    }

    // 解析并返回第一个变体
    const parsed = this.parseDashscopeVariants(content);
    if (parsed.length === 0) {
      throw new Error('DashScope returned invalid structured resume JSON');
    }

    return {
      ...parsed[0],
      id: `${mode}_v${index}`,
      mode,
      promptVersion: resolvedPromptVersion,
    };
  }

  /** 根据模式与 prompt 版本，生成对应的风格指令文本（支持 -v2 增强版）。 */
  private getModeInstruction(
    mode: ResumeRewriteMode,
    promptVersion: string,
  ): string {
    if (mode === 'business') {
      if (promptVersion.endsWith('-v2')) {
        return 'Style target: business-focused. Prioritize business outcomes, customer impact, ROI framing, and concise executive-ready wording.';
      }
      return 'Style target: business-focused. Prioritize outcomes, metrics, ROI, and business impact statements.';
    }
    if (mode === 'technical') {
      if (promptVersion.endsWith('-v2')) {
        return 'Style target: technical depth. Prioritize architecture decisions, system constraints, tradeoffs, performance tuning, and reliability engineering details.';
      }
      return 'Style target: technical depth. Prioritize architecture decisions, tradeoffs, and engineering complexity.';
    }
    if (promptVersion.endsWith('-v2')) {
      return 'Style target: hybrid. Balance professionalism, role relevance, measurable impact, and technical credibility in each bullet.';
    }
    return 'Style target: hybrid. Balance professional clarity, role relevance, and measurable impact.';
  }

  /** 各模式默认 prompt 版本号。 */
  private defaultPromptVersion(mode: ResumeRewriteMode): string {
    if (mode === 'technical') {
      return 'resume-rewrite-technical-v1';
    }
    if (mode === 'business') {
      return 'resume-rewrite-business-v1';
    }
    return 'resume-rewrite-hybrid-v1';
  }

  /** 一次性生成多个变体（非流式，供内部/兼容使用）。 */
  private async generateWithDashscope(
    input: GenerateResumeDto,
  ): Promise<AiResumeVariant[]> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are an expert resume writer.',
          'Return valid JSON only.',
          'Do not wrap JSON in markdown fences.',
          'The JSON shape must be:',
          '{"variants":[{"id":"v1","summary":"...","experience":[{"company":"...","role":"...","highlights":["..."]}],"projects":[{"name":"...","highlights":["..."]}],"skills":["..."]}]}',
          `Generate exactly ${this.normalizeVariantCount(input.variants)} variant(s).`,
          'Each highlight must be concise, professional, and resume-ready.',
        ].join(' '),
      },
      {
        role: 'user',
        content: await this.buildStructuredPrompt(input),
      },
    ];

    const response = (await this.requestDashscope(
      messages,
      false,
    )) as DashscopeChatResponse;
    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('DashScope returned empty content');
    }

    const parsed = this.parseDashscopeVariants(content);
    if (parsed.length === 0) {
      throw new Error('DashScope returned invalid structured resume JSON');
    }

    return parsed;
  }

  /** 以流式方式生成 Markdown 简历并逐段回调（供前端打字机展示）。 */
  private async streamMarkdownResume(
    input: GenerateResumeDto,
    options: StreamOptions,
  ): Promise<void> {
    await this.requestDashscope(
      [
        {
          role: 'system',
          content: [
            'You are an expert resume writer.',
            'Write the final resume directly in Markdown.',
            'Do not output JSON.',
            'Do not explain your process.',
            'Use headings, bullet lists, and concise professional language.',
          ].join(' '),
        },
        {
          role: 'user',
          content: await this.buildMarkdownPrompt(input),
        },
      ],
      true,
      options.signal,
      (text) => options.onDelta?.(text),
    );
  }

  /** 组装结构化生成所需的用户提示词（含解析后的 JD 上下文）。 */
  private async buildStructuredPrompt(
    input: GenerateResumeDto,
  ): Promise<string> {
    const jdContext = await this.buildParsedJdContext(input);
    return [
      `Language: ${input.language}`,
      `Tone: ${input.tone}`,
      `Full name: ${input.profile.fullName}`,
      `Target role: ${input.targetJob.title}`,
      `Background: ${input.profile.background}`,
      `Profile skills: ${input.profile.skills.join(', ')}`,
      `Target job description: ${input.targetJob.description || 'N/A'}`,
      `Target required skills: ${input.targetJob.mustHaveSkills.join(', ') || 'N/A'}`,
      `Parsed JD context: ${jdContext}`,
      `Experiences: ${JSON.stringify(input.profile.experiences)}`,
      `Projects: ${JSON.stringify(input.profile.projects)}`,
    ].join('\n');
  }

  /** 组装 Markdown 流式生成所需的用户提示词（中文指令）。 */
  private async buildMarkdownPrompt(input: GenerateResumeDto): Promise<string> {
    const jdContext = await this.buildParsedJdContext(input);
    return [
      `请使用 ${input.language} 输出最终简历内容。`,
      `目标岗位：${input.targetJob.title}`,
      `姓名：${input.profile.fullName}`,
      `背景简介：${input.profile.background}`,
      `技能清单：${input.profile.skills.join(' / ')}`,
      `岗位要求：${input.targetJob.mustHaveSkills.join(' / ') || '无'}`,
      `岗位描述：${input.targetJob.description || '无'}`,
      `结构化岗位上下文：${jdContext}`,
      `工作经历原始信息：${JSON.stringify(input.profile.experiences)}`,
      `项目经历原始信息：${JSON.stringify(input.profile.projects)}`,
      '请直接输出 Markdown，结构包含：一级标题（姓名+岗位）、个人简介、工作经历、项目经历、技能清单。',
      '不要输出 JSON，不要输出额外说明。',
    ].join('\n');
  }

  /**
   * 解析岗位描述，提取结构化的 JD 上下文供提示词使用。
   * 无岗位描述时返回 'N/A'；返回字段做数量截断以防提示词过长。
   */
  private async buildParsedJdContext(
    input: GenerateResumeDto,
  ): Promise<string> {
    const jobDescription = input.targetJob.description?.trim();
    if (!jobDescription) {
      return 'N/A';
    }

    const parsed = await this.jdParserService.parse(jobDescription);
    return JSON.stringify({
      basic: {
        jobTitleNorm: parsed.basic.jobTitleNorm,
        yearsExpMin: parsed.basic.yearsExpMin,
        yearsExpMax: parsed.basic.yearsExpMax,
        educationMin: parsed.basic.educationMin,
        city: parsed.basic.city,
      },
      responsibilities: parsed.responsibilities
        .slice(0, 6)
        .map((item) => item.text),
      mustRequirements: parsed.requirements.must
        .slice(0, 8)
        .map((item) => item.text),
      preferredRequirements: parsed.requirements.preferred
        .slice(0, 5)
        .map((item) => item.text),
      hardSkills: parsed.skills.hardSkills,
      tools: parsed.skills.tools,
      businessGoals: parsed.businessGoals.map((item) => item.goalType),
      seniorityLevel: parsed.seniorityLevel,
      qualityWarnings: parsed.quality.warnings,
    });
  }

  /** 解析 LLM 返回的 JSON（经 LlmSanitizer 清洗），提取变体列表。 */
  private parseDashscopeVariants(raw: string): AiResumeVariant[] {
    const parsed = LlmSanitizer.parseJsonObject<{ variants?: unknown }>(raw);
    return this.parseVariantsPayload(parsed.variants);
  }

  /** 将「variants」字段的原始数据规整为 AiResumeVariant[]（逐字段清洗 + 过滤空 summary）。 */
  private parseVariantsPayload(value: unknown): AiResumeVariant[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item, index) => {
        const record = item as Record<string, unknown>;
        const variantId = LlmSanitizer.toText(record.id) || `v${index + 1}`;
        return {
          id: variantId,
          summary: LlmSanitizer.toText(record.summary),
          experience: Array.isArray(record.experience)
            ? record.experience.map((experience) => {
                const exp = experience as Record<string, unknown>;
                return {
                  company: LlmSanitizer.toText(exp.company),
                  role: LlmSanitizer.toText(exp.role),
                  highlights: Array.isArray(exp.highlights)
                    ? exp.highlights.map((highlight) =>
                        LlmSanitizer.toText(highlight),
                      )
                    : [],
                };
              })
            : [],
          projects: Array.isArray(record.projects)
            ? record.projects.map((project) => {
                const itemProject = project as Record<string, unknown>;
                return {
                  name: LlmSanitizer.toText(itemProject.name),
                  highlights: Array.isArray(itemProject.highlights)
                    ? itemProject.highlights.map((highlight) =>
                        LlmSanitizer.toText(highlight),
                      )
                    : [],
                };
              })
            : [],
          skills: Array.isArray(record.skills)
            ? record.skills.map((skill) => String(skill))
            : [],
        };
      })
      .filter((variant) => variant.summary.length > 0);
  }

  /**
   * 发起 DashScope Chat 请求。
   * - 支持流式/非流式；流式时通过 onStreamText 逐段回调；
   * - 内部使用超时 + 外部 signal 双重中止控制。
   */
  private async requestDashscope(
    messages: ChatMessage[],
    stream: boolean,
    externalSignal?: AbortSignal,
    onStreamText?: (text: string) => void,
  ): Promise<DashscopeChatResponse | void> {
    // 环境变量读取（含默认值）
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const model = process.env.DASHSCOPE_MODEL ?? 'qwen-plus';
    const timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS ?? 20000);
    const baseUrl =
      process.env.DASHSCOPE_BASE_URL ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1';

    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY is not configured');
    }

    // 组合内部超时与外部取消信号
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortHandler = () => controller.abort();
    externalSignal?.addEventListener('abort', abortHandler);

    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            stream,
            ...(stream ? { stream_options: { include_usage: true } } : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `DashScope request failed: ${response.status} ${message}`,
        );
      }

      // 非流式：直接返回 JSON
      if (!stream) {
        return (await response.json()) as DashscopeChatResponse;
      }

      if (!response.body) {
        throw new Error('DashScope stream response body is empty');
      }

      // 流式：逐帧消费并回调
      await this.consumeDashscopeStream(response.body, onStreamText);
      return;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortHandler);
    }
  }

  /** 消费 DashScope 流式响应体，按 SSE 帧提取文本并回调。 */
  private async consumeDashscopeStream(
    body: ReadableStream<Uint8Array>,
    onStreamText?: (text: string) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      // 追加解码片段并按空行拆分 SSE 帧（保留可能不完整的末尾）
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const text = this.extractTextFromDashscopeFrame(frame);
        if (text) {
          onStreamText?.(text);
        }
      }
    }

    // 处理缓冲中残留的最后一帧
    if (buffer.trim().length > 0) {
      const text = this.extractTextFromDashscopeFrame(buffer);
      if (text) {
        onStreamText?.(text);
      }
    }
  }

  /** 从单个 SSE 帧中提取 delta 文本（跳过 [DONE] 结束标记）。 */
  private extractTextFromDashscopeFrame(frame: string): string {
    const dataLine = frame
      .split('\n')
      .find(
        (line) => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]',
      );

    if (!dataLine) {
      return '';
    }

    const payload = JSON.parse(
      dataLine.slice(5).trim(),
    ) as DashscopeChatStreamChunk;
    return payload.choices?.[0]?.delta?.content ?? '';
  }
}
