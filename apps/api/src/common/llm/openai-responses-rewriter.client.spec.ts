import {
  REWRITE_JD_TOOL_NAME,
  parseJdToolArgumentsSchema,
} from '../../resume/jd-parser/jd-parse-tool.schema';
import type {
  JdLlmRewriteInput,
  JdRewriteImprovementTarget,
} from './llm-client.interface';
import type { OpenAiAgentClient } from './openai-agent.client';
import type { AgentRunResult } from './openai-agent.client';
import { OpenAIJdLlmRewriterClient } from './openai-responses-rewriter.client';
import { ToolRegistry } from './tool-registry';

/** 满足 `parseJdToolArgumentsSchema` 的完整合法 arguments，作为重写输出。 */
const validRewrittenArguments = {
  basic: {
    jobTitleRaw: '高级数据分析师',
    jobTitleNorm: '高级数据分析师',
    industry: '互联网',
    city: '上海',
    yearsExpMin: 3,
  },
  responsibilities: [
    {
      text: '负责搭建用户增长分析体系，覆盖拉新-激活-留存全链路业务场景',
      action: '负责',
      object: '用户增长分析体系',
      evidenceSpan: '负责搭建用户增长分析体系',
      confidence: 0.92,
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
    hardSkills: ['SQL'],
    softSkills: [],
    tools: [],
    certificates: [],
  },
  businessGoals: [
    {
      goalType: '增长',
      text: '推动自动化报表落地',
      metricHint: '转化率/留存率',
      evidenceSpan: '推动自动化报表落地',
      confidence: 0.85,
    },
  ],
  keywords: ['用户增长'],
  seniorityLevel: 'senior',
};

const parsedJdInput = {
  basic: { jobTitleRaw: '高级数据分析师', jobTitleNorm: '高级数据分析师' },
  responsibilities: [
    {
      text: '负责搭建用户增长分析体系',
      action: '负责',
      object: '用户增长分析体系',
      evidenceSpan: '负责搭建用户增长分析体系',
      confidence: 0.9,
    },
  ],
  requirements: { must: [], preferred: [] },
  skills: { hardSkills: [], softSkills: [], tools: [], certificates: [] },
  businessGoals: [],
  keywords: [],
  seniorityLevel: 'senior',
};

const rewriteTargets: JdRewriteImprovementTarget[] = [
  {
    dimension: 'specificity',
    currentScore: 65,
    threshold: 75,
    hint: 'improve responsibilities concreteness with business scenes',
  },
  {
    dimension: 'measurability',
    currentScore: 68,
    threshold: 70,
    hint: 'strengthen businessGoals metricHint',
  },
];

const rawJdText = '职位名称：高级数据分析师\n负责搭建用户增长分析体系';

function buildInput(
  overrides: Partial<JdLlmRewriteInput> = {},
): JdLlmRewriteInput {
  return {
    parsedJd: parsedJdInput,
    rawJdText,
    targets: rewriteTargets,
    ...overrides,
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: REWRITE_JD_TOOL_NAME,
    description:
      'Rewrite a parsed job description to improve low-scoring dimensions.',
    inputSchema: parseJdToolArgumentsSchema,
  });
  return registry;
}

function makeAgent(options: { strict?: boolean } = {}): {
  runWithTools: jest.Mock;
  strictSchema: boolean;
} {
  return {
    runWithTools: jest.fn(),
    strictSchema: options.strict ?? false,
  };
}

/** 构造一个命中 rewrite_jd 的 agent 返回结果。 */
function toolCallResult(argumentsValue: unknown): AgentRunResult {
  return {
    outputText: '',
    toolTrace: [
      {
        step: 0,
        name: REWRITE_JD_TOOL_NAME,
        arguments: argumentsValue,
        latencyMs: 0,
      },
    ],
  };
}

describe('OpenAIJdLlmRewriterClient', () => {
  it('returns validated arguments on a successful tool call', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(
      toolCallResult(validRewrittenArguments),
    );
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    const result = await client.rewriteJd(buildInput());

    expect(result).toEqual(validRewrittenArguments);
    expect(agent.runWithTools).toHaveBeenCalledWith(
      expect.objectContaining({ stopOnToolCall: true }),
    );
  });

  it('uses strict tools when the agent strictSchema is enabled', async () => {
    const agent = makeAgent({ strict: true });
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(
      toolCallResult(validRewrittenArguments),
    );
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await client.rewriteJd(buildInput());

    const call = agent.runWithTools.mock.calls[0][0] as unknown as {
      tools: Array<{ name: string; strict: boolean }>;
    };
    expect(call.tools).toEqual([
      expect.objectContaining({ name: REWRITE_JD_TOOL_NAME, strict: true }),
    ]);
  });

  it('serializes parsedJd, targets and rawJdText into the prompt input', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(
      toolCallResult(validRewrittenArguments),
    );
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await client.rewriteJd(buildInput());

    const call = agent.runWithTools.mock.calls[0][0] as unknown as {
      input: string;
    };
    expect(call.input).toContain('CURRENT_PARSED_JD:');
    expect(call.input).toContain(JSON.stringify(parsedJdInput));
    expect(call.input).toContain('IMPROVEMENT_TARGETS:');
    expect(call.input).toContain('specificity: current=65, threshold=75');
    expect(call.input).toContain('measurability: current=68, threshold=70');
    expect(call.input).toContain(
      'improve responsibilities concreteness with business scenes',
    );
    expect(call.input).toContain('ORIGINAL_JD_TEXT:');
    expect(call.input).toContain(rawJdText);
  });

  it('rejects when improvement targets list is empty before calling the agent', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.rewriteJd(buildInput({ targets: [] }))).rejects.toThrow(
      'rewrite_targets_empty',
    );
    expect(agent.runWithTools).not.toHaveBeenCalled();
  });

  it('throws openai_no_tool_call when the model did not call the tool', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue({
      outputText: 'no tool',
      toolTrace: [],
    });
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.rewriteJd(buildInput())).rejects.toThrow(
      'openai_no_tool_call',
    );
  });

  it('throws openai_invalid_arguments on schema mismatch', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(
      toolCallResult({ basic: { jobTitleRaw: 'x' } }),
    );
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.rewriteJd(buildInput())).rejects.toThrow(
      'openai_invalid_arguments',
    );
  });

  it('propagates agent errors (e.g. mapped timeouts) untouched', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockRejectedValue(new Error('openai_timeout_20000ms'));
    const client = new OpenAIJdLlmRewriterClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.rewriteJd(buildInput())).rejects.toThrow(
      'openai_timeout_20000ms',
    );
  });
});
