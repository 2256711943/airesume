import {
  BadGatewayException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  JD_LLM_PARSER_CLIENT,
  type JdLlmParserClient,
} from '../../common/llm/llm-client.interface';
import { LlmSanitizer } from '../../common/llm/llm-sanitizer.util';
import type {
  ParsedBusinessGoal,
  ParsedJdResult,
  ParsedRequirementItem,
  ParsedResponsibilityItem,
  SeniorityLevel,
} from './types';

/** LLM 返回的 JD 结构化 payload（与 parse_jd/rewrite_jd 工具的 zod schema 对齐）。 */
interface ParsedJdLlmPayload {
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

  constructor(
    @Optional()
    @Inject(JD_LLM_PARSER_CLIENT)
    private readonly jdLlmClient?: JdLlmParserClient,
  ) {}

  async parse(rawJd: string): Promise<ParsedJdResult> {
    const startedAt = Date.now();
    const text = this.normalizeText(rawJd);
    if (!text) {
      return this.buildFallbackResult(
        rawJd,
        ['empty_jd_text'],
        this.getParseVersion(),
      );
    }

    try {
      const payload = await this.requestJdParseFromLlm(text);
      const result = this.convertLlmPayloadToParsedResult(payload, rawJd);
      this.logger.log(
        `jd parse ok: provider=openai version=${result.quality.parseVersion} latency_ms=${Date.now() - startedAt} missing_fields=${result.quality.missingFields.length}`,
      );
      return result;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = this.normalizeErrorMessage(error);
      const fallbackWarnings = ['llm_parse_failed', message];
      if (this.isStrictModeEnabled()) {
        this.logger.error(
          `JD parse failed in strict mode: ${message} latency_ms=${latencyMs}`,
        );
        throw this.toStrictModeException(message);
      }
      this.logger.warn(
        `JD parse failed, fallback applied: ${message} latency_ms=${latencyMs}`,
      );
      return this.buildFallbackResult(
        rawJd,
        fallbackWarnings,
        this.getParseVersion(),
      );
    }
  }

  private normalizeText(input: string): string {
    return input
      .replace(/\r\n/g, '\n')
      .replace(/\u3000/g, ' ')
      .trim();
  }

  private async requestJdParseFromLlm(jdText: string): Promise<unknown> {
    if (!this.jdLlmClient) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    return this.jdLlmClient.parseJd({ jdText });
  }

  private getParseVersion(): string {
    return 'jd-parser-v3-openai-function-calling';
  }

  private convertLlmPayloadToParsedResult(
    payload: unknown,
    rawJd: string,
  ): ParsedJdResult {
    const parsed = this.toPayloadRecord(payload);

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
        parseVersion: this.getParseVersion(),
        missingFields: this.collectMissingFields(parsed),
        warnings: [],
      },
    };
  }

  private toPayloadRecord(payload: unknown): ParsedJdLlmPayload {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      return payload as ParsedJdLlmPayload;
    }
    throw new Error('llm_payload_is_not_object');
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

  private collectMissingFields(payload: ParsedJdLlmPayload): string[] {
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
    parseVersion: string,
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
        parseVersion,
        missingFields: ['responsibilities', 'requirements.must'],
        warnings,
      },
    };
  }

  /** 与 LLM 客户端共用同一个 strict 开关（OPENAI_STRICT_SCHEMA），避免双环境变量。 */
  private isStrictModeEnabled(): boolean {
    const value = process.env.OPENAI_STRICT_SCHEMA ?? '';
    return /^(1|true|yes|on)$/i.test(value.trim());
  }

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }
    return 'unknown_error';
  }

  private toStrictModeException(message: string): Error {
    if (message.startsWith('openai_timeout_')) {
      return new GatewayTimeoutException(`JD parse timeout: ${message}`);
    }
    if (message.startsWith('openai_http_')) {
      return new BadGatewayException(`JD parse upstream error: ${message}`);
    }
    if (message === 'OPENAI_API_KEY is not configured') {
      return new ServiceUnavailableException(
        `JD parse config missing: ${message}`,
      );
    }
    if (
      message === 'openai_aborted_by_caller' ||
      message === 'openai_connection_failed'
    ) {
      return new ServiceUnavailableException(`JD parse aborted: ${message}`);
    }
    if (
      message.startsWith('openai_no_tool_call') ||
      message.startsWith('openai_empty_arguments') ||
      message.startsWith('openai_invalid_arguments')
    ) {
      return new BadGatewayException(`JD parse failed: ${message}`);
    }
    return new BadGatewayException(`JD parse failed: ${message}`);
  }
}
