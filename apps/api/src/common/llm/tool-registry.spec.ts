import { z } from 'zod';
import { ToolRegistry } from './tool-registry';
import type { ToolDefinition } from './tool.definition';

const sampleSchema = z.object({
  jobTitle: z.string(),
  details: z.object({
    level: z.string().optional(),
  }),
  tags: z.array(z.string()),
});

const sampleTool: ToolDefinition = {
  name: 'sample_tool',
  description: 'A sample tool.',
  inputSchema: sampleSchema,
};

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('registers and lists tools', () => {
    registry.register(sampleTool);
    expect(registry.list()).toEqual([sampleTool]);
    expect(registry.get('sample_tool')).toBe(sampleTool);
  });

  it('rejects duplicate registration', () => {
    registry.register(sampleTool);
    expect(() => registry.register(sampleTool)).toThrow(
      'tool_already_registered: sample_tool',
    );
  });

  it('converts zod schema to OpenAI parameters (non-strict)', () => {
    registry.register(sampleTool);
    const [tool] = registry.toOpenAiTools({ strict: false });
    expect(tool).toMatchObject({
      type: 'function',
      name: 'sample_tool',
      description: 'A sample tool.',
      strict: false,
    });
    const params = tool.parameters;
    expect(params).not.toHaveProperty('$schema');
    expect(params.type).toBe('object');
  });

  it('converts to strict parameters with all-required and no additional props', () => {
    registry.register(sampleTool);
    const [tool] = registry.toOpenAiTools({ strict: true });
    expect(tool.strict).toBe(true);

    const params = tool.parameters;
    expect(params.required).toEqual(['jobTitle', 'details', 'tags']);
    expect(params.additionalProperties).toBe(false);

    const properties = params.properties as Record<string, unknown>;
    const details = properties.details as Record<string, unknown>;
    expect(details.required).toEqual(['level']);
    expect(details.additionalProperties).toBe(false);

    const tags = properties.tags as Record<string, unknown>;
    expect(tags.items).toMatchObject({ type: 'string' });
  });

  it('validates arguments against the registered schema', () => {
    registry.register(sampleTool);
    const value = registry.validateArguments('sample_tool', {
      jobTitle: '后端工程师',
      details: { level: 'senior' },
      tags: ['nestjs'],
    });
    expect(value).toEqual({
      jobTitle: '后端工程师',
      details: { level: 'senior' },
      tags: ['nestjs'],
    });
  });

  it('throws openai_invalid_arguments on schema mismatch', () => {
    registry.register(sampleTool);
    expect(() =>
      registry.validateArguments('sample_tool', { jobTitle: 123 }),
    ).toThrow('openai_invalid_arguments');
  });

  it('throws tool_not_registered for unknown tool names', () => {
    expect(() => registry.validateArguments('missing_tool', {})).toThrow(
      'tool_not_registered: missing_tool',
    );
  });

  it('filters tools by names when converting to OpenAI parameters', () => {
    registry.register(sampleTool);
    registry.register({
      name: 'other_tool',
      description: 'Another tool.',
      inputSchema: z.object({ value: z.string() }),
    });

    const tools = registry.toOpenAiTools({
      strict: false,
      names: ['sample_tool'],
    });
    expect(tools.map((tool) => tool.name)).toEqual(['sample_tool']);
  });
});
