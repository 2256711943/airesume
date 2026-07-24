import { Injectable } from '@nestjs/common';
import {
  type GenerateResumeDto,
  type ResumeExperienceDto,
  type ResumeProjectDto,
} from './dto/generate-resume.dto';
import { LlmSanitizer } from '../common/llm/llm-sanitizer.util';
import { JdParserService } from './jd-parser/jd-parser.service';

export interface AiResumeVariant {
  id: string;
  mode?: ResumeRewriteMode;
  promptVersion?: string;
  summary: string;
  experience: Array<{
    company: string;
    role: string;
    highlights: string[];
  }>;
  projects: Array<{
    name: string;
    highlights: string[];
  }>;
  skills: string[];
}

export type ResumeRewriteMode = 'technical' | 'business' | 'hybrid';
type LegacyRewriteMode = 'professional' | 'result_oriented' | 'technical_depth';
export interface ResumePromptVersionMap {
  technical: string;
  business: string;
  hybrid: string;
}

interface StreamOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DashscopeChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

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

  async generate(
    input: GenerateResumeDto,
    promptVersions?: Partial<ResumePromptVersionMap>,
  ): Promise<AiResumeVariant[]> {
    const rewriteModes = this.normalizeRewriteModes(input.rewriteModes);
    return this.generateByModes(input, rewriteModes, promptVersions);
  }

  private async generateByModes(
    input: GenerateResumeDto,
    modes: ResumeRewriteMode[],
    promptVersions?: Partial<ResumePromptVersionMap>,
  ): Promise<AiResumeVariant[]> {
    if (this.hasDashscopeConfig()) {
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
      const byMode = new Map<ResumeRewriteMode, AiResumeVariant>();
      candidates.forEach((result, index) => {
        if (
          result.status === 'fulfilled' &&
          result.value.summary.trim().length > 0
        ) {
          byMode.set(modes[index], result.value);
        }
      });

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

    return modes.map((mode, index) =>
      this.generateLocalModeVariant(
        input,
        mode,
        index + 1,
        promptVersions?.[mode],
      ),
    );
  }

  async generateWithStream(
    input: GenerateResumeDto,
    options: StreamOptions = {},
  ): Promise<AiResumeVariant[]> {
    if (!this.hasDashscopeConfig()) {
      const variants = this.generateLocalVariants(input);
      const markdown = this.renderMarkdownResume(
        variants[0],
        input.profile.fullName.trim(),
        input.targetJob.title.trim(),
      );
      const chunks = this.chunkText(markdown, 32);

      for (const chunk of chunks) {
        if (options.signal?.aborted) {
          break;
        }
        options.onDelta?.(chunk);
        await this.sleep(20);
      }

      return variants;
    }

    const variantsPromise = this.generate(input);
    const markdownPromise = this.streamMarkdownResume(input, options);
    const [variants] = await Promise.all([variantsPromise, markdownPromise]);

    return variants;
  }

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

  private mapLegacyMode(mode: string): ResumeRewriteMode | undefined {
    if (mode === 'technical' || mode === 'business' || mode === 'hybrid') {
      return mode;
    }
    return this.mapLegacyModeInternal(mode as LegacyRewriteMode);
  }

  private mapLegacyModeInternal(mode: LegacyRewriteMode): ResumeRewriteMode {
    if (mode === 'technical_depth') {
      return 'technical';
    }
    if (mode === 'result_oriented') {
      return 'business';
    }
    return 'hybrid';
  }

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

  private renderMarkdownResume(
    variant: AiResumeVariant | undefined,
    fullName: string,
    targetRole: string,
  ): string {
    if (!variant) {
      return `# ${fullName || '候选人'} - ${targetRole || '目标岗位'}\n\n暂未生成可展示的简历内容。`;
    }

    const experienceSection = variant.experience
      .map((item) => {
        const highlights = item.highlights
          .map((highlight) => `- ${highlight}`)
          .join('\n');
        return `### ${item.company} | ${item.role}\n${highlights}`;
      })
      .join('\n\n');

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

  private buildVariant(
    input: GenerateResumeDto,
    variantNo: number,
    style: 'focused' | 'impact' | 'leadership' | 'technical',
    promptVersion?: string,
  ): AiResumeVariant {
    const role = input.targetJob.title.trim();
    const name = input.profile.fullName.trim();
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

  private buildSummary(
    fullName: string,
    role: string,
    background: string,
    style: 'focused' | 'impact' | 'leadership' | 'technical',
  ): string {
    if (style === 'impact') {
      return `${fullName} is a results-oriented candidate targeting ${role}. ${background} Focuses on measurable delivery, reliability, and execution quality.`;
    }

    if (style === 'leadership') {
      return `${fullName} is a collaborative ${role} candidate. ${background} Brings cross-team communication and ownership in ambiguous projects.`;
    }

    if (style === 'technical') {
      return `${fullName} is a technically deep ${role} candidate. ${background} Focuses on architecture quality, performance tradeoffs, and engineering reliability.`;
    }

    return `${fullName} is a ${role} candidate. ${background} Strong in system thinking, delivery speed, and practical problem solving.`;
  }

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

  private mergeSkills(profileSkills: string[], jobSkills: string[]): string[] {
    const merged = [...profileSkills, ...jobSkills]
      .map((item) => item.trim())
      .filter(Boolean);
    return Array.from(new Set(merged)).slice(0, 20);
  }

  private normalizeVariantCount(value: number): number {
    if (!value || value < 1) {
      return 1;
    }
    return Math.min(value, 3);
  }

  private chunkText(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private hasDashscopeConfig(): boolean {
    return Boolean(
      process.env.DASHSCOPE_API_KEY && process.env.DASHSCOPE_MODEL,
    );
  }

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

  private defaultPromptVersion(mode: ResumeRewriteMode): string {
    if (mode === 'technical') {
      return 'resume-rewrite-technical-v1';
    }
    if (mode === 'business') {
      return 'resume-rewrite-business-v1';
    }
    return 'resume-rewrite-hybrid-v1';
  }

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

  private parseDashscopeVariants(raw: string): AiResumeVariant[] {
    const parsed = LlmSanitizer.parseJsonObject<{ variants?: unknown }>(raw);
    return this.parseVariantsPayload(parsed.variants);
  }

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

  private async requestDashscope(
    messages: ChatMessage[],
    stream: boolean,
    externalSignal?: AbortSignal,
    onStreamText?: (text: string) => void,
  ): Promise<DashscopeChatResponse | void> {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    const model = process.env.DASHSCOPE_MODEL ?? 'qwen-plus';
    const timeoutMs = Number(process.env.DASHSCOPE_TIMEOUT_MS ?? 20000);
    const baseUrl =
      process.env.DASHSCOPE_BASE_URL ??
      'https://dashscope.aliyuncs.com/compatible-mode/v1';

    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY is not configured');
    }

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

      if (!stream) {
        return (await response.json()) as DashscopeChatResponse;
      }

      if (!response.body) {
        throw new Error('DashScope stream response body is empty');
      }

      await this.consumeDashscopeStream(response.body, onStreamText);
      return;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortHandler);
    }
  }

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

    if (buffer.trim().length > 0) {
      const text = this.extractTextFromDashscopeFrame(buffer);
      if (text) {
        onStreamText?.(text);
      }
    }
  }

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
