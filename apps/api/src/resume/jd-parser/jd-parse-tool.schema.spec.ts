import { ToolRegistry } from '../../common/llm/tool-registry';
import {
  PARSE_JD_TOOL_NAME,
  parseJdToolArgumentsSchema,
} from './jd-parse-tool.schema';

/** 通过 ToolRegistry 将真实 schema 转换为 OpenAI tool parameters（strict 可选）。 */
function buildToolParameters(strict: boolean): Record<string, unknown> {
  const registry = new ToolRegistry();
  registry.register({
    name: PARSE_JD_TOOL_NAME,
    description: 'Extract structured fields from a job description.',
    inputSchema: parseJdToolArgumentsSchema,
  });
  const [tool] = registry.toOpenAiTools({ strict });
  return tool.parameters;
}

const validArguments = {
  basic: {
    jobTitleRaw: '高级数据分析师',
    jobTitleNorm: '高级数据分析师',
    industry: '互联网',
    city: '上海',
    yearsExpMin: 3,
  },
  responsibilities: [
    {
      text: '负责搭建用户增长分析体系',
      action: '负责',
      object: '用户增长分析体系',
      evidenceSpan: '负责搭建用户增长分析体系',
      confidence: 0.9,
    },
  ],
  requirements: {
    must: [
      {
        text: '本科及以上学历',
        type: '学历',
        evidenceSpan: '本科及以上学历',
        confidence: 0.95,
      },
    ],
    preferred: [],
  },
  skills: {
    hardSkills: ['SQL', 'Python'],
    softSkills: [],
    tools: ['Tableau'],
    certificates: [],
  },
  businessGoals: [
    {
      goalType: '增长',
      text: '推动自动化报表落地',
      evidenceSpan: '推动自动化报表落地',
      confidence: 0.8,
    },
  ],
  keywords: ['用户增长'],
  seniorityLevel: 'senior',
};

describe('parseJdToolArgumentsSchema', () => {
  it('accepts a valid arguments object', () => {
    const result = parseJdToolArgumentsSchema.safeParse(validArguments);
    expect(result.success).toBe(true);
  });

  it('rejects when a required top-level field is missing', () => {
    const { responsibilities, ...rest } = validArguments;
    const result = parseJdToolArgumentsSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects arrays over the maxItems limit', () => {
    const overLimit = {
      ...validArguments,
      responsibilities: Array.from({ length: 16 }, (_, index) => ({
        ...validArguments.responsibilities[0],
        text: `职责 ${index}`,
      })),
    };
    const result = parseJdToolArgumentsSchema.safeParse(overLimit);
    expect(result.success).toBe(false);
  });

  it('rejects invalid enum values', () => {
    const result = parseJdToolArgumentsSchema.safeParse({
      ...validArguments,
      seniorityLevel: 'boss',
    });
    expect(result.success).toBe(false);
  });

  it('rejects confidence out of range', () => {
    const result = parseJdToolArgumentsSchema.safeParse({
      ...validArguments,
      responsibilities: [
        { ...validArguments.responsibilities[0], confidence: 1.5 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('keeps optional fields optional in the non-strict parameters', () => {
    const params = buildToolParameters(false);
    const topLevelRequired = params.required as string[];
    expect(topLevelRequired).toContain('basic');

    const basic = params.properties as Record<string, { required?: string[] }>;
    expect(basic.basic.required).toEqual(
      expect.arrayContaining(['jobTitleRaw', 'jobTitleNorm']),
    );
    expect(basic.basic.required).not.toContain('industry');
  });

  it('makes every property required and forbids extras in strict parameters', () => {
    const strict = buildToolParameters(true);
    const topLevelRequired = strict.required as string[];
    expect(topLevelRequired).toEqual(
      expect.arrayContaining([
        'basic',
        'responsibilities',
        'requirements',
        'skills',
        'businessGoals',
        'keywords',
        'seniorityLevel',
      ]),
    );

    const properties = strict.properties as Record<
      string,
      { required?: string[]; additionalProperties?: boolean }
    >;
    expect(properties.basic.required).toContain('industry');
    expect(properties.basic.additionalProperties).toBe(false);
    expect(properties.requirements.required).toEqual(
      expect.arrayContaining(['must', 'preferred']),
    );

    const responsibilities = properties.responsibilities as {
      items: { required: string[]; additionalProperties: boolean };
    };
    expect(responsibilities.items.required).toEqual(
      expect.arrayContaining(['text', 'action', 'scope', 'confidence']),
    );
    expect(responsibilities.items.additionalProperties).toBe(false);
  });
});
