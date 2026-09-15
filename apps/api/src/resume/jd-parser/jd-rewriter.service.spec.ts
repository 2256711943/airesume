import { JdRewriterService } from './jd-rewriter.service';
import type { JdJudgeResult } from './jd-judge.service';
import type { JdLlmRewriterClient } from '../../common/llm/llm-client.interface';
import type { ParsedJdResult } from './types';

const RAW_JD_TEXT =
  '职位名称：高级数据分析师\n负责搭建分析体系\n本科及以上学历\n关注转化率与留存率';

const parsed: ParsedJdResult = {
  basic: {
    jobTitleRaw: '高级数据分析师',
    jobTitleNorm: '高级数据分析师',
    industry: '互联网',
    city: '上海',
    yearsExpMin: 3,
    salaryMinK: 20,
    salaryMaxK: 35,
    salaryMonths: 14,
  },
  responsibilities: [
    {
      text: '负责搭建分析体系',
      action: '负责',
      object: '分析体系',
      evidenceSpan: '负责搭建分析体系',
      confidence: 0.9,
    },
  ],
  requirements: {
    must: [
      {
        text: '本科及以上',
        type: '学历',
        evidenceSpan: '本科',
        confidence: 0.95,
      },
    ],
    preferred: [],
  },
  skills: { hardSkills: ['SQL'], softSkills: [], tools: [], certificates: [] },
  businessGoals: [],
  keywords: ['增长'],
  seniorityLevel: 'senior',
  quality: {
    parseVersion: 'test-v1',
    missingFields: [],
    warnings: [],
  },
};

/** specificity 60 < 75, measurability 65 < 70, seniorityFit 80 >= 70（达标）。 */
const lowJudge: JdJudgeResult = {
  overallScore: 70,
  dimensions: {
    roleFit: 80,
    industryFit: 80,
    seniorityFit: 80,
    specificity: 60,
    measurability: 65,
    safety: 90,
  },
  issues: [],
  suggestions: [],
};

/** 全维度达标，targets 应为空。 */
const highJudge: JdJudgeResult = {
  overallScore: 92,
  dimensions: {
    roleFit: 90,
    industryFit: 90,
    seniorityFit: 90,
    specificity: 85,
    measurability: 85,
    safety: 95,
  },
  issues: [],
  suggestions: [],
};

/** LLM 改善后的输出：responsibilities 更具体、补了 businessGoals，basic 只返回必填字段。 */
const llmRewrittenOutput = {
  basic: { jobTitleRaw: '高级数据分析师', jobTitleNorm: '高级数据分析师' },
  responsibilities: [
    {
      text: '负责搭建用户增长分析体系，覆盖拉新-激活-留存全链路业务场景',
      action: '负责',
      object: '用户增长分析体系',
      evidenceSpan: '负责搭建用户增长分析体系',
      confidence: 0.92,
    },
  ],
  requirements: { must: [], preferred: [] },
  skills: { hardSkills: [], softSkills: [], tools: [], certificates: [] },
  businessGoals: [
    {
      goalType: '增长',
      text: '推动自动化报表落地',
      metricHint: '转化率/留存率',
      evidenceSpan: '推动自动化报表落地',
      confidence: 0.85,
    },
  ],
  keywords: [],
  seniorityLevel: 'senior',
};

function makeMockClient(): jest.Mocked<JdLlmRewriterClient> {
  return { rewriteJd: jest.fn() };
}

describe('JdRewriterService', () => {
  const originalProvider = process.env.JD_REWRITE_PROVIDER;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.JD_REWRITE_PROVIDER;
  });

  afterAll(() => {
    if (originalProvider === undefined) {
      delete process.env.JD_REWRITE_PROVIDER;
    } else {
      process.env.JD_REWRITE_PROVIDER = originalProvider;
    }
  });

  describe('rule-based path (default)', () => {
    it('applies rule rewrite and marks rewrite_applied when JD_REWRITE_PROVIDER unset', async () => {
      const service = new JdRewriterService();

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.quality.warnings).not.toContain('llm_rewrite_applied');
      // specificity 低分 → 规则版会给 responsibilities 追加业务场景后缀
      expect(result.responsibilities[0].text).toContain('覆盖具体业务场景');
    });

    it('applies rule rewrite when JD_REWRITE_PROVIDER=rule', async () => {
      process.env.JD_REWRITE_PROVIDER = 'rule';
      const service = new JdRewriterService();

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.responsibilities[0].text).toContain('覆盖具体业务场景');
    });

    it('only marks rewrite_applied without changing content when all dimensions pass', async () => {
      const service = new JdRewriterService();

      const result = await service.rewrite(parsed, highJudge, RAW_JD_TEXT);

      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.responsibilities[0].text).toBe('负责搭建分析体系');
      expect(result.businessGoals).toEqual([]);
    });

    it('preserves basic optional fields (salaryMinK etc.) through rule rewrite', async () => {
      const service = new JdRewriterService();

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.basic.salaryMinK).toBe(20);
      expect(result.basic.salaryMaxK).toBe(35);
      expect(result.basic.salaryMonths).toBe(14);
    });
  });

  describe('llm path', () => {
    it('falls back to rule rewrite when JD_REWRITE_PROVIDER=llm but no client registered', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const service = new JdRewriterService();

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.quality.warnings).not.toContain('llm_rewrite_applied');
      expect(result.responsibilities[0].text).toContain('覆盖具体业务场景');
    });

    it('skips LLM call and marks rewrite_applied when all dimensions pass', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, highJudge, RAW_JD_TEXT);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(client.rewriteJd).not.toHaveBeenCalled();
      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.quality.warnings).not.toContain('llm_rewrite_applied');
      expect(result.responsibilities[0].text).toBe('负责搭建分析体系');
    });

    it('calls rewriter client with targeted dimensions and merges LLM output', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      client.rewriteJd.mockResolvedValue(llmRewrittenOutput);
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(client.rewriteJd).toHaveBeenCalledTimes(1);
      const callInput = client.rewriteJd.mock.calls[0][0];
      expect(callInput.rawJdText).toBe(RAW_JD_TEXT);
      expect(callInput.parsedJd).toBe(parsed);
      // specificity 60<75 与 measurability 65<70 命中，seniorityFit 80 达标不命中
      expect(callInput.targets.map((t) => t.dimension)).toEqual([
        'specificity',
        'measurability',
      ]);

      // responsibilities 用 LLM 改善后的版本
      expect(result.responsibilities[0].text).toBe(
        '负责搭建用户增长分析体系，覆盖拉新-激活-留存全链路业务场景',
      );
      // businessGoals 用 LLM 补充的版本
      expect(result.businessGoals).toHaveLength(1);
      expect(result.businessGoals[0].metricHint).toBe('转化率/留存率');
      // basic 可选字段从原 parsed 保留（LLM 输出未返回）
      expect(result.basic.salaryMinK).toBe(20);
      expect(result.basic.salaryMonths).toBe(14);
      expect(result.basic.industry).toBe('互联网');
      // 标记 llm_rewrite_applied
      expect(result.quality.warnings).toContain('llm_rewrite_applied');
      expect(result.quality.warnings).not.toContain('rewrite_applied');
    });

    it('falls back to rule rewrite when rewriter client throws', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      client.rewriteJd.mockRejectedValue(new Error('openai_timeout_20000ms'));
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(client.rewriteJd).toHaveBeenCalledTimes(1);
      // fallback 到规则版：rewrite_applied 而非 llm_rewrite_applied
      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.quality.warnings).not.toContain('llm_rewrite_applied');
      expect(result.responsibilities[0].text).toContain('覆盖具体业务场景');
    });

    it('falls back to rule rewrite when LLM output is not an object', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      client.rewriteJd.mockResolvedValue('not-an-object');
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.quality.warnings).toContain('rewrite_applied');
      expect(result.quality.warnings).not.toContain('llm_rewrite_applied');
    });

    it('keeps original arrays when LLM returns empty arrays', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      client.rewriteJd.mockResolvedValue({
        ...llmRewrittenOutput,
        responsibilities: [],
        businessGoals: [],
      });
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      // responsibilities 为空时回退到原 parsed 的值
      expect(result.responsibilities[0].text).toBe('负责搭建分析体系');
      expect(result.businessGoals).toEqual([]);
    });

    it('ignores invalid seniorityLevel from LLM and keeps original', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      client.rewriteJd.mockResolvedValue({
        ...llmRewrittenOutput,
        seniorityLevel: 'boss',
      });
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.seniorityLevel).toBe('senior');
    });

    it('clamps out-of-range confidence from LLM output', async () => {
      process.env.JD_REWRITE_PROVIDER = 'llm';
      const client = makeMockClient();
      client.rewriteJd.mockResolvedValue({
        ...llmRewrittenOutput,
        responsibilities: [
          {
            text: '负责搭建全链路分析体系',
            action: '负责',
            object: '分析体系',
            evidenceSpan: '负责搭建分析体系',
            confidence: 1.5,
          },
        ],
      });
      const service = new JdRewriterService(client);

      const result = await service.rewrite(parsed, lowJudge, RAW_JD_TEXT);

      expect(result.responsibilities[0].confidence).toBe(1);
    });
  });
});
