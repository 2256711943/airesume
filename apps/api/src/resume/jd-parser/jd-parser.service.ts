import {
  BadGatewayException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { LlmSanitizer } from '../../common/llm/llm-sanitizer.util';
import type {
  ParsedBusinessGoal,
  ParsedJdResult,
  ParsedRequirementItem,
  ParsedResponsibilityItem,
  SeniorityLevel,
} from './types';

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

interface DashscopeParsedJdPayload {
  basic?: Record<string, unknown>;
  responsibilities?: unknown[];
  requirements?: {
    must?: unknown[];
    preferred?: unknown[];
  };
  skills?: Record<string, unknown>;
  businessGoals?: unknown[];
  keywords?: unknown[];
  seniorityLevel?: unknown;
}

const REQUIREMENT_TYPE = {
  EXPERIENCE: '经验' as ParsedRequirementItem['type'],
  SKILL: '技能' as ParsedRequirementItem['type'],
  EDUCATION: '学历' as ParsedRequirementItem['type'],
  CERTIFICATE: '证书' as ParsedRequirementItem['type'],
  LANGUAGE: '语言' as ParsedRequirementItem['type'],
  OTHER: '其他' as ParsedRequirementItem['type'],
};

const BUSINESS_GOAL_TYPE = {
  GROWTH: '增长' as ParsedBusinessGoal['goalType'],
  COST_REDUCTION: '降本' as ParsedBusinessGoal['goalType'],
  EFFICIENCY: '提效' as ParsedBusinessGoal['goalType'],
  QUALITY: '质量' as ParsedBusinessGoal['goalType'],
  COMPLIANCE: '合规' as ParsedBusinessGoal['goalType'],
  RISK_CONTROL: '风控' as ParsedBusinessGoal['goalType'],
  DELIVERY: '交付' as ParsedBusinessGoal['goalType'],
  INNOVATION: '创新' as ParsedBusinessGoal['goalType'],
  CUSTOMER_SUCCESS: '客户成功' as ParsedBusinessGoal['goalType'],
  OTHER: '其他' as ParsedBusinessGoal['goalType'],
};

const EDUCATION_LEVEL = {
  UNLIMITED: '不限' as ParsedJdResult['basic']['educationMin'],
  COLLEGE: '大专' as ParsedJdResult['basic']['educationMin'],
  BACHELOR: '本科' as ParsedJdResult['basic']['educationMin'],
  MASTER: '硕士' as ParsedJdResult['basic']['educationMin'],
  DOCTOR: '博士' as ParsedJdResult['basic']['educationMin'],
};

const SENIORITY_LEVELS: SeniorityLevel[] = [
  'junior',
  'mid',
  'senior',
  'lead',
  'manager',
  'director',
  'unknown',
];

@Injectable()
export class JdParserService {
  private readonly logger = new Logger(JdParserService.name);

  async parse(rawJd: string): Promise<ParsedJdResult> {
    const text = this.normalizeText(rawJd);
    if (!text) {
      return this.buildFallbackResult(rawJd, ['empty_jd_text']);
    }

    try {
      const content = await this.requestJdParseFromLlm(text);
      return this.convertLlmPayloadToParsedResult(content, rawJd);
    } catch (error) {
      const message = this.normalizeErrorMessage(error);
      const fallbackWarnings = ['llm_parse_failed', message];
      if (this.isStrictModeEnabled()) {
        this.logger.error(`JD parse failed in strict mode: ${message}`);
        throw this.toStrictModeException(message);
      }
      this.logger.warn(`JD parse failed, fallback applied: ${message}`);
      return this.buildFallbackResult(rawJd, fallbackWarnings);
    }
  }

  private normalizeText(input: string): string {
    return input
      .replace(/\r\n/g, '\n')
      .replace(/\u3000/g, ' ')
      .trim();
  }

  private async requestJdParseFromLlm(jdText: string): Promise<string> {
    const response = await this.requestDashscope(
      [
        {
          role: 'system',
          content: this.getSystemPrompt(),
        },
        {
          role: 'user',
          content: this.getUserPrompt(jdText),
        },
      ],
      false,
    );

    const content = response.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('dashscope_empty_content');
    }

    return content;
  }

  private getSystemPrompt(): string {
    return [
      'You are a job description parsing engine.',
      'Extract structured fields from the JD text.',
      'Return JSON only. No markdown fence, no explanation.',
      'Keep field names exactly as requested.',
      'Use concise text and preserve important evidence snippets from JD.',
      'Output schema:',
      '{"basic":{"jobTitleRaw":"","jobTitleNorm":"","industry":"","city":"","educationMin":"","yearsExpMin":0,"yearsExpMax":0,"salaryMinK":0,"salaryMaxK":0,"salaryMonths":0,"reportTo":"","teamSize":0},"responsibilities":[{"text":"","action":"","object":"","scope":"","evidenceSpan":"","confidence":0.9}],"requirements":{"must":[{"text":"","type":"经验|技能|学历|证书|语言|其他","evidenceSpan":"","confidence":0.9}],"preferred":[{"text":"","type":"经验|技能|学历|证书|语言|其他","evidenceSpan":"","confidence":0.85}]},"skills":{"hardSkills":[],"softSkills":[],"tools":[],"certificates":[]},"businessGoals":[{"goalType":"增长|降本|提效|质量|合规|风控|交付|创新|客户成功|其他","text":"","metricHint":"","evidenceSpan":"","confidence":0.8}],"keywords":[],"seniorityLevel":"junior|mid|senior|lead|manager|director|unknown"}',
      'Rules:',
      '1) Keep arrays reasonably short: responsibilities <= 15, must <= 20, preferred <= 20, businessGoals <= 10, keywords <= 60.',
      '2) confidence must be between 0 and 1.',
      '3) If missing, use empty string or omit optional fields.',
      '4) seniorityLevel must be one of: junior, mid, senior, lead, manager, director, unknown.',
    ].join(' ');
  }

  private getUserPrompt(jdText: string): string {
    return ['JD_TEXT_START', jdText, 'JD_TEXT_END'].join('\n');
  }

  private convertLlmPayloadToParsedResult(
    content: string,
    rawJd: string,
  ): ParsedJdResult {
    const parsed =
      LlmSanitizer.parseJsonObject<DashscopeParsedJdPayload>(content);

    return {
      basic: this.parseBasic(parsed.basic, rawJd),
      responsibilities: this.parseResponsibilities(parsed.responsibilities),
      requirements: {
        must: this.parseRequirements(parsed.requirements?.must),
        preferred: this.parseRequirements(parsed.requirements?.preferred),
      },
      skills: this.parseSkills(parsed.skills),
      businessGoals: this.parseBusinessGoals(parsed.businessGoals),
      keywords: this.parseKeywords(parsed.keywords),
      seniorityLevel: this.parseSeniority(parsed.seniorityLevel),
      quality: {
        parseVersion: 'jd-parser-v2-llm',
        missingFields: this.collectMissingFields(parsed),
        warnings: [],
      },
    };
  }

  private parseBasic(
    value: Record<string, unknown> | undefined,
    rawJd: string,
  ): ParsedJdResult['basic'] {
    const record = value ?? {};
    const jobTitleRaw =
      this.toText(record.jobTitleRaw) || this.guessJobTitle(rawJd);

    return {
      jobTitleRaw,
      jobTitleNorm: this.toText(record.jobTitleNorm) || jobTitleRaw,
      industry: this.toOptionalText(record.industry),
      city: this.toOptionalText(record.city),
      educationMin: this.toOptionalEducation(record.educationMin),
      yearsExpMin: this.toOptionalNumber(record.yearsExpMin),
      yearsExpMax: this.toOptionalNumber(record.yearsExpMax),
      salaryMinK: this.toOptionalNumber(record.salaryMinK),
      salaryMaxK: this.toOptionalNumber(record.salaryMaxK),
      salaryMonths: this.toOptionalNumber(record.salaryMonths),
      reportTo: this.toOptionalText(record.reportTo),
      teamSize: this.toOptionalNumber(record.teamSize),
    };
  }

  private parseResponsibilities(
    value: unknown[] | undefined,
  ): ParsedResponsibilityItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const results: ParsedResponsibilityItem[] = [];
    for (const item of value) {
      const record = this.toRecord(item);
      const text = this.toText(record.text).slice(0, 200);
      if (!text) {
        continue;
      }

      const action = this.toText(record.action) || '负责';
      const object = this.toText(record.object) || text.slice(0, 120);
      const parsedItem: ParsedResponsibilityItem = {
        text,
        action,
        object,
        scope: this.toOptionalText(record.scope),
        evidenceSpan: this.toText(record.evidenceSpan) || text,
        confidence: this.toConfidence(record.confidence, 0.8),
      };
      results.push(parsedItem);
      if (results.length >= 15) {
        break;
      }
    }
    return results;
  }

  private parseRequirements(
    value: unknown[] | undefined,
  ): ParsedRequirementItem[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const results: ParsedRequirementItem[] = [];
    for (const item of value) {
      const record = this.toRecord(item);
      const text = this.toText(record.text).slice(0, 180);
      if (!text) {
        continue;
      }

      const parsedItem: ParsedRequirementItem = {
        text,
        type: this.toRequirementType(record.type),
        evidenceSpan: this.toText(record.evidenceSpan) || text,
        confidence: this.toConfidence(record.confidence, 0.8),
      };
      results.push(parsedItem);
      if (results.length >= 20) {
        break;
      }
    }
    return results;
  }

  private parseSkills(
    value: Record<string, unknown> | undefined,
  ): ParsedJdResult['skills'] {
    const record = value ?? {};
    return {
      hardSkills: this.toStringArray(record.hardSkills, 40),
      softSkills: this.toStringArray(record.softSkills, 40),
      tools: this.toStringArray(record.tools, 40),
      certificates: this.toStringArray(record.certificates, 40),
    };
  }

  private parseBusinessGoals(
    value: unknown[] | undefined,
  ): ParsedBusinessGoal[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const results: ParsedBusinessGoal[] = [];
    for (const item of value) {
      const record = this.toRecord(item);
      const text = this.toText(record.text).slice(0, 200);
      if (!text) {
        continue;
      }

      const parsedItem: ParsedBusinessGoal = {
        goalType: this.toGoalType(record.goalType),
        text,
        metricHint: this.toOptionalText(record.metricHint),
        evidenceSpan: this.toText(record.evidenceSpan) || text,
        confidence: this.toConfidence(record.confidence, 0.8),
      };
      results.push(parsedItem);
      if (results.length >= 10) {
        break;
      }
    }
    return results;
  }

  private parseKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 60);
    return Array.from(new Set(normalized));
  }

  private parseSeniority(value: unknown): SeniorityLevel {
    return LlmSanitizer.toEnumValue(value, SENIORITY_LEVELS, 'unknown');
  }

  private toRequirementType(value: unknown): ParsedRequirementItem['type'] {
    const text = LlmSanitizer.toText(value);
    const lower = text.toLowerCase();

    if (text === '经验' || lower === 'experience') {
      return REQUIREMENT_TYPE.EXPERIENCE;
    }
    if (text === '技能' || lower === 'skill' || lower === 'skills') {
      return REQUIREMENT_TYPE.SKILL;
    }
    if (text === '学历' || lower === 'education') {
      return REQUIREMENT_TYPE.EDUCATION;
    }
    if (
      text === '证书' ||
      lower === 'certificate' ||
      lower === 'certification'
    ) {
      return REQUIREMENT_TYPE.CERTIFICATE;
    }
    if (text === '语言' || lower === 'language') {
      return REQUIREMENT_TYPE.LANGUAGE;
    }

    return REQUIREMENT_TYPE.OTHER;
  }

  private toGoalType(value: unknown): ParsedBusinessGoal['goalType'] {
    const text = LlmSanitizer.toText(value);
    const lower = text.toLowerCase();

    if (text === '增长' || lower === 'growth') {
      return BUSINESS_GOAL_TYPE.GROWTH;
    }
    if (text === '降本' || lower === 'cost' || lower === 'cost_reduction') {
      return BUSINESS_GOAL_TYPE.COST_REDUCTION;
    }
    if (text === '提效' || lower === 'efficiency') {
      return BUSINESS_GOAL_TYPE.EFFICIENCY;
    }
    if (text === '质量' || lower === 'quality') {
      return BUSINESS_GOAL_TYPE.QUALITY;
    }
    if (text === '合规' || lower === 'compliance') {
      return BUSINESS_GOAL_TYPE.COMPLIANCE;
    }
    if (text === '风控' || lower === 'risk_control' || lower === 'risk') {
      return BUSINESS_GOAL_TYPE.RISK_CONTROL;
    }
    if (text === '交付' || lower === 'delivery') {
      return BUSINESS_GOAL_TYPE.DELIVERY;
    }
    if (text === '创新' || lower === 'innovation') {
      return BUSINESS_GOAL_TYPE.INNOVATION;
    }
    if (text === '客户成功' || lower === 'customer_success') {
      return BUSINESS_GOAL_TYPE.CUSTOMER_SUCCESS;
    }

    return BUSINESS_GOAL_TYPE.OTHER;
  }

  private toOptionalEducation(
    value: unknown,
  ): ParsedJdResult['basic']['educationMin'] {
    const text = this.toOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (text === '不限') {
      return EDUCATION_LEVEL.UNLIMITED;
    }
    if (text === '大专') {
      return EDUCATION_LEVEL.COLLEGE;
    }
    if (text === '本科') {
      return EDUCATION_LEVEL.BACHELOR;
    }
    if (text === '硕士') {
      return EDUCATION_LEVEL.MASTER;
    }
    if (text === '博士') {
      return EDUCATION_LEVEL.DOCTOR;
    }

    return undefined;
  }

  private toConfidence(value: unknown, fallback: number): number {
    return LlmSanitizer.toConfidence(value, fallback);
  }

  private toStringArray(value: unknown, limit: number): string[] {
    return LlmSanitizer.toStringArray(value, limit);
  }

  private toRecord(value: unknown): Record<string, unknown> {
    return LlmSanitizer.toRecord(value);
  }

  private toText(value: unknown): string {
    return LlmSanitizer.toText(value);
  }

  private toOptionalText(value: unknown): string | undefined {
    return LlmSanitizer.toOptionalText(value);
  }

  private toOptionalNumber(value: unknown): number | undefined {
    return LlmSanitizer.toOptionalNumber(value);
  }

  private guessJobTitle(rawJd: string): string {
    const line = rawJd
      .split('\n')
      .map((item) => item.trim())
      .find((item) => item.length >= 2 && item.length <= 40);
    return line ?? '未标注岗位';
  }

  private collectMissingFields(payload: DashscopeParsedJdPayload): string[] {
    const missing: string[] = [];
    if (!payload.basic) {
      missing.push('basic');
    }
    if (
      !Array.isArray(payload.responsibilities) ||
      payload.responsibilities.length === 0
    ) {
      missing.push('responsibilities');
    }
    if (!payload.requirements?.must || payload.requirements.must.length === 0) {
      missing.push('requirements.must');
    }
    return missing;
  }

  private buildFallbackResult(
    rawJd: string,
    warnings: string[],
  ): ParsedJdResult {
    const jobTitle = this.guessJobTitle(rawJd);

    return {
      basic: {
        jobTitleRaw: jobTitle,
        jobTitleNorm: jobTitle,
      },
      responsibilities: [],
      requirements: {
        must: [],
        preferred: [],
      },
      skills: {
        hardSkills: [],
        softSkills: [],
        tools: [],
        certificates: [],
      },
      businessGoals: [],
      keywords: [],
      seniorityLevel: 'unknown',
      quality: {
        parseVersion: 'jd-parser-v2-llm',
        missingFields: ['responsibilities', 'requirements.must'],
        warnings,
      },
    };
  }

  private async requestDashscope(
    messages: ChatMessage[],
    stream: boolean,
    externalSignal?: AbortSignal,
  ): Promise<DashscopeChatResponse> {
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
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
            response_format: { type: 'json_object' },
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const message = await response.text();
        throw new Error(`dashscope_http_${response.status}: ${message}`);
      }

      return (await response.json()) as DashscopeChatResponse;
    } catch (error) {
      if (timedOut) {
        throw new Error(`dashscope_timeout_${timeoutMs}ms`);
      }
      if (externalSignal?.aborted) {
        throw new Error('dashscope_aborted_by_caller');
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('dashscope_request_aborted');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortHandler);
    }
  }

  private isStrictModeEnabled(): boolean {
    const value =
      process.env.JD_PARSER_STRICT_MODE ?? process.env.JD_PARSER_STRICT ?? '';
    return /^(1|true|yes|on)$/i.test(value.trim());
  }

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }
    return 'unknown_error';
  }

  private toStrictModeException(message: string): Error {
    if (message.startsWith('dashscope_timeout_')) {
      return new GatewayTimeoutException(`JD parse timeout: ${message}`);
    }
    if (message.startsWith('dashscope_http_')) {
      return new BadGatewayException(`JD parse upstream error: ${message}`);
    }
    if (message === 'DASHSCOPE_API_KEY is not configured') {
      return new ServiceUnavailableException(
        'JD parse config missing: DASHSCOPE_API_KEY',
      );
    }
    if (
      message === 'dashscope_aborted_by_caller' ||
      message === 'dashscope_request_aborted'
    ) {
      return new ServiceUnavailableException(`JD parse aborted: ${message}`);
    }
    return new BadGatewayException(`JD parse failed: ${message}`);
  }
}
