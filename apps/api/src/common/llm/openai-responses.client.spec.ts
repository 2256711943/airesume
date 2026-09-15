import {
  PARSE_JD_TOOL_NAME,
  parseJdToolArgumentsSchema,
} from '../../resume/jd-parser/jd-parse-tool.schema';
import type { OpenAiAgentClient } from './openai-agent.client';
import type { AgentRunResult } from './openai-agent.client';
import { OpenAIJdLlmParserClient } from './openai-responses.client';
import { ToolRegistry } from './tool-registry';

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
    hardSkills: ['SQL'],
    softSkills: [],
    tools: [],
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

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: PARSE_JD_TOOL_NAME,
    description: 'Extract structured fields from a job description.',
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

/** 构造一个命中 parse_jd 的 agent 返回结果。 */
function toolCallResult(argumentsValue: unknown): AgentRunResult {
  return {
    outputText: '',
    toolTrace: [
      {
        step: 0,
        name: PARSE_JD_TOOL_NAME,
        arguments: argumentsValue,
        latencyMs: 0,
      },
    ],
  };
}

describe('OpenAIJdLlmParserClient', () => {
  it('returns validated arguments on a successful tool call', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(toolCallResult(validArguments));
    const client = new OpenAIJdLlmParserClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    const result = await client.parseJd({ jdText: '职位名称：高级数据分析师' });

    expect(result).toEqual(validArguments);
    expect(agent.runWithTools).toHaveBeenCalledWith(
      expect.objectContaining({
        input: '职位名称：高级数据分析师',
        stopOnToolCall: true,
      }),
    );
  });

  it('converts registered tools with strict flag from the agent config', async () => {
    const agent = makeAgent({ strict: true });
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(toolCallResult(validArguments));
    const client = new OpenAIJdLlmParserClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await client.parseJd({ jdText: 'jd' });

    const call = (agent.runWithTools.mock.calls[0] as unknown[])[0] as {
      tools: Array<{ name: string; strict: boolean }>;
    };
    expect(call.tools).toEqual([
      expect.objectContaining({ name: PARSE_JD_TOOL_NAME, strict: true }),
    ]);
  });

  it('throws openai_no_tool_call when the model did not call the tool', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue({
      outputText: 'no tool',
      toolTrace: [],
    });
    const client = new OpenAIJdLlmParserClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.parseJd({ jdText: 'jd' })).rejects.toThrow(
      'openai_no_tool_call',
    );
  });

  it('throws openai_no_tool_call when the model called a different tool', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue({
      outputText: '',
      toolTrace: [{ step: 0, name: 'other_tool', arguments: {} }],
    });
    const client = new OpenAIJdLlmParserClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.parseJd({ jdText: 'jd' })).rejects.toThrow(
      'openai_no_tool_call',
    );
  });

  it('throws openai_invalid_arguments on schema mismatch', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockResolvedValue(
      toolCallResult({ basic: { jobTitleRaw: 'x' } }),
    );
    const client = new OpenAIJdLlmParserClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.parseJd({ jdText: 'jd' })).rejects.toThrow(
      'openai_invalid_arguments',
    );
  });

  it('propagates agent errors (e.g. mapped timeouts) untouched', async () => {
    const agent = makeAgent();
    const registry = makeRegistry();
    agent.runWithTools.mockRejectedValue(new Error('openai_timeout_20000ms'));
    const client = new OpenAIJdLlmParserClient(
      agent as unknown as OpenAiAgentClient,
      registry,
    );

    await expect(client.parseJd({ jdText: 'jd' })).rejects.toThrow(
      'openai_timeout_20000ms',
    );
  });
});
