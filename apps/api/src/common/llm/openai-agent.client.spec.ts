import { RateLimitError } from 'openai';
import {
  OpenAiAgentClient,
  type AgentToolCall,
  type AgentToolDefinition,
  type AgentToolTraceEntry,
} from './openai-agent.client';
import type { OpenAiLlmConfig } from './llm-config';

jest.mock('openai', () => {
  // 构造签名与 openai SDK 真实类型对齐，避免运行时 instanceof 判断失真。
  class APIError extends Error {
    readonly status: number | undefined;
    constructor(
      status: number | undefined,
      error: unknown = undefined,
      message: string | undefined = undefined,
      headers: unknown = undefined,
    ) {
      super(message ?? 'API error');
      void error;
      void headers;
      this.status = status;
    }
  }
  class APIConnectionError extends APIError {
    constructor(opts: { message?: string; cause?: Error } = {}) {
      super(undefined, undefined, opts.message);
    }
  }
  class APIConnectionTimeoutError extends APIConnectionError {
    constructor(opts: { message?: string } = {}) {
      super({ message: opts.message });
    }
  }
  class APIUserAbortError extends APIError {
    constructor(opts: { message?: string } = {}) {
      super(undefined, undefined, opts.message ?? 'Request was aborted.');
    }
  }
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}

  class OpenAI {
    responses = { create: jest.fn() };
  }

  return {
    APIError,
    APIConnectionError,
    APIConnectionTimeoutError,
    APIUserAbortError,
    AuthenticationError,
    RateLimitError,
    OpenAI,
  };
});

const baseConfig: OpenAiLlmConfig = {
  apiKey: 'test-key',
  model: 'gpt-4o-mini',
  timeoutMs: 20_000,
  strictSchema: false,
};

const tools: AgentToolDefinition[] = [
  {
    type: 'function',
    name: 'web_search',
    description: 'Search the web for latest knowledge.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'judge_resume',
    description: 'Score a resume variant.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { variantIndex: { type: 'integer' } },
      required: ['variantIndex'],
    },
  },
  {
    type: 'function',
    name: 'parse_jd',
    description: 'Extract structured fields from a job description.',
    strict: false,
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    },
  },
];

function makeClient(config: OpenAiLlmConfig = baseConfig): OpenAiAgentClient {
  return new OpenAiAgentClient(config);
}

function createMock(client: OpenAiAgentClient): jest.Mock {
  return (client as unknown as { client: { responses: { create: jest.Mock } } })
    .client.responses.create;
}

function functionCallItem(
  name: string,
  callId: string,
  argumentsJson: string,
): Record<string, unknown> {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: argumentsJson,
    status: 'completed',
  };
}

function plainResponse(
  id: string,
  output: Array<Record<string, unknown>>,
  outputText = '',
): Record<string, unknown> {
  return { id, output, output_text: outputText };
}

describe('OpenAiAgentClient', () => {
  it('returns text immediately when the model makes no tool call', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(plainResponse('resp_1', [], 'final answer'));
    const execute: jest.Mock = jest.fn();

    const result = await client.runWithTools({
      instructions: 'You are an assistant.',
      input: 'hello',
      tools,
      execute,
    });

    expect(result.outputText).toBe('final answer');
    expect(result.toolTrace).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const params = (create.mock.calls[0] as unknown[])[0] as {
      tool_choice: string;
      previous_response_id?: unknown;
      input?: unknown;
    };
    expect(params.tool_choice).toBe('auto');
    expect(params.previous_response_id).toBeUndefined();
    expect(params.input).toBe('hello');
  });

  it('executes tool calls and keeps looping until the model stops', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('web_search', 'call_1', '{"query":"NestJS"}'),
      ]),
    );
    create.mockResolvedValueOnce(plainResponse('resp_2', [], 'done'));
    const execute: jest.Mock = jest.fn().mockResolvedValue([
      {
        title: 'NestJS Docs',
        url: 'https://nest.dev',
        snippet: 'DI patterns',
      },
    ]);

    const result = await client.runWithTools({
      instructions: 'You are a resume assistant.',
      input: 'improve my resume',
      tools,
      execute,
      maxSteps: 4,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const call = (execute.mock.calls[0] as unknown[])[0] as AgentToolCall;
    expect(call.callId).toBe('call_1');
    expect(call.name).toBe('web_search');
    expect(call.arguments).toEqual({ query: 'NestJS' });

    // 续接请求：previous_response_id + function_call_output 回填
    expect(create).toHaveBeenCalledTimes(2);
    const secondParams = (create.mock.calls[1] as unknown[])[0] as {
      previous_response_id: string;
      input: Array<{ call_id: string }>;
    };
    expect(secondParams.previous_response_id).toBe('resp_1');
    expect(secondParams.input).toEqual([
      {
        type: 'function_call_output',
        id: 'tool_output_0_0',
        call_id: 'call_1',
        output: JSON.stringify({
          ok: true,
          data: [
            {
              title: 'NestJS Docs',
              url: 'https://nest.dev',
              snippet: 'DI patterns',
            },
          ],
        }),
        status: 'completed',
      },
    ]);

    expect(result.outputText).toBe('done');
    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]).toMatchObject({ step: 0, name: 'web_search' });
    expect(typeof result.toolTrace[0].latencyMs).toBe('number');
  });

  it('invokes onToolStart/onToolDone around each executed tool call', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('web_search', 'call_1', '{"query":"NestJS"}'),
      ]),
    );
    create.mockResolvedValueOnce(plainResponse('resp_2', [], 'done'));
    const execute: jest.Mock = jest.fn().mockResolvedValue(['result']);
    const onToolStart = jest.fn();
    const onToolDone = jest.fn();

    const result = await client.runWithTools({
      instructions: 'You are an assistant.',
      input: 'hello',
      tools,
      execute,
      onToolStart,
      onToolDone,
    });

    expect(onToolStart).toHaveBeenCalledTimes(1);
    expect(
      (onToolStart.mock.calls[0] as unknown[])[0] as AgentToolCall,
    ).toMatchObject({
      callId: 'call_1',
      name: 'web_search',
    });
    expect(onToolDone).toHaveBeenCalledTimes(1);
    expect(
      (onToolDone.mock.calls[0] as unknown[])[0] as AgentToolTraceEntry,
    ).toMatchObject({
      step: 0,
      name: 'web_search',
      result: { ok: true, data: ['result'] },
    });
    expect(result.toolTrace).toHaveLength(1);
  });

  it('executes multiple parallel tool calls in a single step', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('web_search', 'call_1', '{"query":"Rust"}'),
        functionCallItem('judge_resume', 'call_2', '{"variantIndex":0}'),
      ]),
    );
    create.mockResolvedValueOnce(plainResponse('resp_2', [], 'ok'));
    const execute: jest.Mock = jest
      .fn()
      .mockImplementation((call: AgentToolCall) =>
        Promise.resolve(
          call.name === 'judge_resume' ? { overallScore: 80 } : ['result'],
        ),
      );

    const result = await client.runWithTools({
      instructions: 'Work on it.',
      input: 'context',
      tools,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolTrace).toHaveLength(2);
    const outputs = (
      ((create.mock.calls[1] as unknown[])[0] as { input: unknown })
        .input as unknown[]
    ).map((item) => (item as { call_id: string }).call_id);
    expect(outputs).toEqual(['call_1', 'call_2']);
  });

  it('reports tool failures back to the model without breaking the loop', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('web_search', 'call_1', '{"query":"x"}'),
      ]),
    );
    create.mockResolvedValueOnce(plainResponse('resp_2', [], 'retry done'));
    const execute: jest.Mock = jest
      .fn()
      .mockRejectedValue(new Error('tool boom'));

    const result = await client.runWithTools({
      instructions: 'Go.',
      input: 'ctx',
      tools,
      execute,
    });

    expect(result.outputText).toBe('retry done');
    expect(create).toHaveBeenCalledTimes(2);
    const fedBack = (
      (create.mock.calls[1] as unknown[])[0] as { input: unknown[] }
    ).input[0] as {
      output: string;
    };
    expect(JSON.parse(fedBack.output)).toEqual({
      ok: false,
      error: 'tool boom',
    });
  });

  it('reports invalid JSON arguments without invoking the executor', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('web_search', 'call_1', 'not-json'),
      ]),
    );
    create.mockResolvedValueOnce(plainResponse('resp_2', [], 'done'));
    const execute: jest.Mock = jest.fn();

    await client.runWithTools({
      instructions: 'Go.',
      input: 'ctx',
      tools,
      execute,
    });

    expect(execute).not.toHaveBeenCalled();
    const fedBack = (
      (create.mock.calls[1] as unknown[])[0] as { input: unknown[] }
    ).input[0] as {
      output: string;
    };
    expect(JSON.parse(fedBack.output)).toEqual({
      ok: false,
      error: 'invalid_json_arguments',
    });
  });

  it('stops with openai_agent_max_steps error when maxSteps is exhausted', async () => {
    const client = makeClient();
    const create = createMock(client);
    // 每一轮模型都继续请求工具，直到用尽 maxSteps=2（初始 + 2 次续接后抛出）
    create.mockResolvedValue(
      plainResponse('resp_x', [
        functionCallItem('web_search', 'call_x', '{"query":"q"}'),
      ]),
    );
    const execute: jest.Mock = jest.fn().mockResolvedValue(['hit']);

    await expect(
      client.runWithTools({
        instructions: 'Go.',
        input: 'ctx',
        tools,
        execute,
        maxSteps: 2,
      }),
    ).rejects.toThrow('openai_agent_max_steps_2');
    expect(create).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('throws OPENAI_API_KEY is not configured without calling the SDK', async () => {
    const client = makeClient({ ...baseConfig, apiKey: '' });
    const create = createMock(client);
    const execute: jest.Mock = jest.fn();

    await expect(
      client.runWithTools({
        instructions: 'Go.',
        input: 'ctx',
        tools,
        execute,
      }),
    ).rejects.toThrow('OPENAI_API_KEY is not configured');
    expect(create).not.toHaveBeenCalled();
  });

  it('maps SDK API errors to openai_* prefixed errors', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockRejectedValueOnce(
      new RateLimitError(429, undefined, undefined, {} as Headers),
    );
    const execute: jest.Mock = jest.fn();

    await expect(
      client.runWithTools({
        instructions: 'Go.',
        input: 'ctx',
        tools,
        execute,
      }),
    ).rejects.toThrow('openai_http_429: rate_limit');
  });

  it('returns the tool call immediately with stopOnToolCall without executing', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('parse_jd', 'call_1', '{"title":"后端工程师"}'),
      ]),
    );
    const execute: jest.Mock = jest.fn();

    const result = await client.runWithTools({
      instructions: 'Extract structured fields.',
      input: 'jd text',
      tools,
      execute,
      stopOnToolCall: true,
    });

    expect(result.toolTrace).toHaveLength(1);
    expect(result.toolTrace[0]).toMatchObject({
      step: 0,
      name: 'parse_jd',
      arguments: { title: '后端工程师' },
    });
    // 不执行工具、不续接模型，只发起一次请求。
    expect(execute).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    const params = (create.mock.calls[0] as unknown[])[0] as {
      tool_choice: string;
      previous_response_id?: unknown;
      input?: unknown;
    };
    expect(params.tool_choice).toBe('auto');
  });

  it('throws openai_empty_arguments for empty tool arguments in stopOnToolCall mode', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [functionCallItem('parse_jd', 'call_1', '')]),
    );
    const execute: jest.Mock = jest.fn();

    await expect(
      client.runWithTools({
        instructions: 'Extract.',
        input: 'jd text',
        tools,
        execute,
        stopOnToolCall: true,
      }),
    ).rejects.toThrow('openai_empty_arguments');
  });

  it('throws openai_invalid_arguments for malformed JSON in stopOnToolCall mode', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('parse_jd', 'call_1', 'not-json'),
      ]),
    );
    const execute: jest.Mock = jest.fn();

    await expect(
      client.runWithTools({
        instructions: 'Extract.',
        input: 'jd text',
        tools,
        execute,
        stopOnToolCall: true,
      }),
    ).rejects.toThrow('openai_invalid_arguments');
  });

  it('records parsed arguments and result in the multi-step trace', async () => {
    const client = makeClient();
    const create = createMock(client);
    create.mockResolvedValueOnce(
      plainResponse('resp_1', [
        functionCallItem('web_search', 'call_1', '{"query":"NestJS"}'),
      ]),
    );
    create.mockResolvedValueOnce(plainResponse('resp_2', [], 'done'));
    const execute: jest.Mock = jest.fn().mockResolvedValue(['hit']);

    const result = await client.runWithTools({
      instructions: 'Go.',
      input: 'ctx',
      tools,
      execute,
    });

    expect(result.toolTrace[0]).toMatchObject({
      step: 0,
      name: 'web_search',
      arguments: { query: 'NestJS' },
    });
    expect(result.toolTrace[0].result).toEqual({ ok: true, data: ['hit'] });
  });
});
