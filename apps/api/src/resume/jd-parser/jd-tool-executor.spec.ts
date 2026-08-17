import type { AgentToolCall } from '../../common/llm/openai-agent.client';
import { ToolRegistry } from '../../common/llm/tool-registry';
import {
  JD_PARSE_TOOL_NAME,
  JD_SCORE_TOOL_NAME,
  registerJdDiagnosisTools,
} from './jd-parse-tool.schema';
import type { JdJudgeService } from './jd-judge.service';
import type { JdParserService } from './jd-parser.service';
import { JdToolExecutor } from './jd-tool-executor';
import type { ParsedJdResult } from './types';

const call = (
  name: string,
  args: unknown,
  callId = 'call_1',
): AgentToolCall => ({ callId, name, arguments: args });

const parsedJd: ParsedJdResult = {
  basic: { jobTitleRaw: '高级数据分析师', jobTitleNorm: '高级数据分析师' },
  responsibilities: [],
  requirements: { must: [], preferred: [] },
  skills: { hardSkills: [], softSkills: [], tools: [], certificates: [] },
  businessGoals: [],
  keywords: [],
  seniorityLevel: 'senior',
  quality: { parseVersion: 'test', missingFields: [], warnings: [] },
};

const judge = {
  overallScore: 82,
  dimensions: {
    roleFit: 80,
    industryFit: 80,
    seniorityFit: 80,
    specificity: 80,
    measurability: 80,
    safety: 80,
  },
  issues: [],
  suggestions: [],
};

describe('JdToolExecutor', () => {
  let registry: ToolRegistry;
  let jdParserService: jest.Mocked<Pick<JdParserService, 'parse'>>;
  let jdJudgeService: jest.Mocked<Pick<JdJudgeService, 'judge'>>;
  let executor: JdToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerJdDiagnosisTools(registry);
    jdParserService = {
      parse: jest.fn().mockResolvedValue(parsedJd),
    };
    jdJudgeService = {
      judge: jest.fn().mockReturnValue(judge),
    };
    executor = new JdToolExecutor(
      registry,
      jdParserService as unknown as JdParserService,
      jdJudgeService as unknown as JdJudgeService,
    );
  });

  it('routes jd_parse to the parser service', async () => {
    const output = await executor.execute(
      call(JD_PARSE_TOOL_NAME, { jdText: '岗位描述文本' }),
    );
    expect(output).toEqual({ parsedJd });
    expect(jdParserService.parse).toHaveBeenCalledWith('岗位描述文本');
  });

  it('routes jd_score to the judge service with parsed result', async () => {
    const output = await executor.execute(
      call(JD_SCORE_TOOL_NAME, { jdText: '岗位描述文本', parsedJd }),
    );
    expect(output).toEqual({ judge });
    expect(jdJudgeService.judge).toHaveBeenCalledWith(
      parsedJd,
      '岗位描述文本',
    );
  });

  it('rejects missing jdText with openai_invalid_arguments', async () => {
    await expect(
      executor.execute(call(JD_PARSE_TOOL_NAME, { jdText: '' })),
    ).rejects.toThrow('openai_invalid_arguments');
    expect(jdParserService.parse).not.toHaveBeenCalled();
  });

  it('rejects jd_score without parsedJd with openai_invalid_arguments', async () => {
    await expect(
      executor.execute(call(JD_SCORE_TOOL_NAME, { jdText: '文本' })),
    ).rejects.toThrow('openai_invalid_arguments');
    expect(jdJudgeService.judge).not.toHaveBeenCalled();
  });

  it('throws tool_not_registered for unknown tools', async () => {
    await expect(executor.execute(call('unknown_tool', {}))).rejects.toThrow(
      'tool_not_registered: unknown_tool',
    );
  });
});
