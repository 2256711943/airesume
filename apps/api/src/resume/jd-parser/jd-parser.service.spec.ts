import { GatewayTimeoutException } from '@nestjs/common';
import type { JdLlmParserClient } from '../../common/llm/llm-client.interface';
import { JdParserService } from './jd-parser.service';

const jd = `
  职位名称：高级数据分析师
  工作地点：上海
  薪资：30-45K 14薪
  岗位职责：负责搭建用户增长分析体系，推动自动化报表落地。
  任职要求：本科及以上学历，3-5年数据分析经验，熟悉 SQL / Python / Tableau。
`;

const mockPayload = {
  basic: {
    jobTitleRaw: '高级数据分析师',
    jobTitleNorm: '高级数据分析师',
    industry: '互联网',
    city: '上海',
    educationMin: '本科',
    yearsExpMin: 3,
    yearsExpMax: 5,
    salaryMinK: 30,
    salaryMaxK: 45,
    salaryMonths: 14,
  },
  responsibilities: [
    {
      text: '负责搭建用户增长分析体系',
      action: '负责',
      object: '用户增长分析体系',
      scope: '全公司',
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

describe('JdParserService', () => {
  afterEach(() => {
    delete process.env.OPENAI_STRICT_SCHEMA;
  });

  it('should fall back to a rule-based result when no llm client is injected', async () => {
    const service = new JdParserService();
    const result = await service.parse(jd);

    expect(result).toHaveProperty('basic');
    expect(result).toHaveProperty('responsibilities');
    expect(result).toHaveProperty('requirements.must');
    expect(result).toHaveProperty('requirements.preferred');
    expect(result).toHaveProperty('skills.hardSkills');
    expect(result).toHaveProperty('businessGoals');
    expect(result).toHaveProperty('keywords');
    expect(result).toHaveProperty('seniorityLevel');
    expect(result).toHaveProperty('quality.parseVersion');
    expect(Array.isArray(result.requirements.must)).toBe(true);
    expect(result.quality.parseVersion).toBe(
      'jd-parser-v3-openai-function-calling',
    );
    expect(result.quality.warnings).toEqual(
      expect.arrayContaining(['llm_parse_failed', 'OPENAI_API_KEY is not configured']),
    );
  });

  it('should consume parseJd arguments and keep response shape', async () => {
    const mockClient: JdLlmParserClient = {
      parseJd: jest.fn().mockResolvedValue(mockPayload),
    };
    const service = new JdParserService(mockClient);

    const result = await service.parse(jd);

    expect(mockClient.parseJd).toHaveBeenCalledWith({
      jdText: expect.stringContaining('高级数据分析师'),
    });
    expect(result.basic.jobTitleRaw).toBe('高级数据分析师');
    expect(result.basic.salaryMinK).toBe(30);
    expect(result.requirements.must).toHaveLength(1);
    expect(result.requirements.must[0].type).toBe('学历');
    expect(result.seniorityLevel).toBe('senior');
    expect(result.quality.parseVersion).toBe(
      'jd-parser-v3-openai-function-calling',
    );
    expect(result.quality.missingFields).toEqual([]);
  });

  it('should fall back when the llm client throws', async () => {
    const mockClient: JdLlmParserClient = {
      parseJd: jest
        .fn()
        .mockRejectedValue(new Error('openai_timeout_20000ms')),
    };
    const service = new JdParserService(mockClient);

    const result = await service.parse(jd);

    expect(result.quality.warnings).toEqual(
      expect.arrayContaining(['llm_parse_failed', 'openai_timeout_20000ms']),
    );
    expect(result.quality.parseVersion).toBe(
      'jd-parser-v3-openai-function-calling',
    );
    expect(result.requirements.must).toEqual([]);
  });

  it('should throw gateway exception in strict mode', async () => {
    const mockClient: JdLlmParserClient = {
      parseJd: jest
        .fn()
        .mockRejectedValue(new Error('openai_timeout_20000ms')),
    };
    process.env.OPENAI_STRICT_SCHEMA = 'true';
    const service = new JdParserService(mockClient);

    await expect(service.parse(jd)).rejects.toThrow(GatewayTimeoutException);
  });
});
