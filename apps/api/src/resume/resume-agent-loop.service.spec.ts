import type { GenerateResumeDto } from './dto/generate-resume.dto';
import { ResumeAgentLoopService } from './resume-agent-loop.service';
import type { ResumeAiService, AiResumeVariant } from './resume.ai.service';
import type { ResumeScorerService, ResumeVariantScore } from './resume-scorer.service';
import type { WebSearchTool } from './web-search-tool.interface';

function makeVariant(id: string, summary: string): AiResumeVariant {
  return {
    id,
    summary,
    experience: [],
    projects: [],
    skills: ['Node.js'],
  };
}

function makeScore(overall: number): ResumeVariantScore {
  return {
    ruleScore: overall,
    llmScore: overall,
    overallScore: overall,
    dimensions: { readability: 0, measurability: 0, roleRelevance: 0 },
    issues: [],
    suggestions: [],
  };
}

const input = {
  profile: {
    fullName: 'Alex',
    background: '5 years backend',
    skills: ['Node.js'],
    experiences: [],
    projects: [],
  },
  targetJob: {
    title: 'Backend Engineer',
    description: '',
    mustHaveSkills: ['Node.js'],
  },
  tone: 'professional',
  language: 'zh-CN',
  variants: 3,
  topN: 3,
  enableScoring: true,
} as GenerateResumeDto;

describe('ResumeAgentLoopService', () => {
  let aiService: {
    generate: jest.Mock;
    rewriteVariantWithFeedback: jest.Mock;
  };
  let scorer: { scoreVariant: jest.Mock };
  let searchTool: { search: jest.Mock };

  beforeEach(() => {
    aiService = {
      generate: jest.fn(),
      rewriteVariantWithFeedback: jest.fn(),
    };
    scorer = { scoreVariant: jest.fn() };
    searchTool = { search: jest.fn() };
  });

  it('stops immediately when the weakest variant already reaches the target score', async () => {
    aiService.generate.mockResolvedValue([
      makeVariant('v1', 'a'),
      makeVariant('v2', 'b'),
      makeVariant('v3', 'c'),
    ]);
    scorer.scoreVariant.mockResolvedValue(makeScore(90));
    const service = new ResumeAgentLoopService(
      aiService as unknown as ResumeAiService,
      scorer as unknown as ResumeScorerService,
    );

    const { variants, scores } = await service.run(input);

    expect(aiService.rewriteVariantWithFeedback).not.toHaveBeenCalled();
    expect(variants).toHaveLength(3);
    expect(scores).toHaveLength(3);
  });

  it('rewrites only the weakest variant and replaces it with the improved one', async () => {
    aiService.generate.mockResolvedValue([
      makeVariant('technical_v1', 'a'),
      makeVariant('business_v2', 'b'),
      makeVariant('hybrid_v3', 'c'),
    ]);
    scorer.scoreVariant.mockImplementation(async (_, variant: AiResumeVariant) =>
      Promise.resolve(
        variant.id === 'business_v2' && variant.summary !== 'improved'
          ? makeScore(60)
          : makeScore(90),
      ),
    );
    aiService.rewriteVariantWithFeedback.mockImplementation(
      async (_input, variant: AiResumeVariant) => ({
        ...variant,
        summary: 'improved',
      }),
    );
    const service = new ResumeAgentLoopService(
      aiService as unknown as ResumeAiService,
      scorer as unknown as ResumeScorerService,
    );

    const { variants } = await service.run(input);

    expect(aiService.rewriteVariantWithFeedback).toHaveBeenCalledTimes(1);
    expect(variants[1].id).toBe('business_v2');
    expect(variants[1].summary).toBe('improved');
    // 重写反馈应包含低分问题（供 LLM 定向改进）
    const rewriteArgs = aiService.rewriteVariantWithFeedback.mock.calls[0];
    expect((rewriteArgs[2] as ResumeVariantScore).overallScore).toBe(60);
  });

  it('stops after maxTurns when the score never reaches the target', async () => {
    aiService.generate.mockResolvedValue([
      makeVariant('v1', 'a'),
      makeVariant('v2', 'b'),
      makeVariant('v3', 'c'),
    ]);
    scorer.scoreVariant.mockImplementation(async (_, variant: AiResumeVariant) =>
      Promise.resolve(makeScore(variant.summary === 'low' ? 50 : 45)),
    );
    aiService.rewriteVariantWithFeedback.mockImplementation(
      async (_input, variant: AiResumeVariant) => ({ ...variant, summary: 'low' }),
    );
    const service = new ResumeAgentLoopService(
      aiService as unknown as ResumeAiService,
      scorer as unknown as ResumeScorerService,
    );

    await service.run(input);

    expect(aiService.rewriteVariantWithFeedback).toHaveBeenCalledTimes(3);
  });

  it('stops after two rounds without meaningful improvement', async () => {
    aiService.generate.mockResolvedValue([
      makeVariant('v1', 'a'),
      makeVariant('v2', 'b'),
      makeVariant('v3', 'c'),
    ]);
    // 初始最弱为 60，重写后仍是 60（无提升）
    scorer.scoreVariant.mockImplementation(async (_, variant: AiResumeVariant) =>
      Promise.resolve(
        variant.id === 'v2' && variant.summary === 'b' ? makeScore(60) : makeScore(90),
      ),
    );
    aiService.rewriteVariantWithFeedback.mockImplementation(
      async (_input, variant: AiResumeVariant) => variant,
    );
    const service = new ResumeAgentLoopService(
      aiService as unknown as ResumeAiService,
      scorer as unknown as ResumeScorerService,
    );

    await service.run(input);

    // NO_IMPROVEMENT_LIMIT=2：两轮无提升后停止
    expect(aiService.rewriteVariantWithFeedback).toHaveBeenCalledTimes(2);
  });

  it('injects search context when a web search tool is provided', async () => {
    aiService.generate.mockResolvedValue([
      makeVariant('v1', 'a'),
      makeVariant('v2', 'b'),
      makeVariant('v3', 'c'),
    ]);
    scorer.scoreVariant.mockImplementation(async (_, variant: AiResumeVariant) =>
      Promise.resolve(
        variant.id === 'v2' && variant.summary === 'b' ? makeScore(50) : makeScore(90),
      ),
    );
    aiService.rewriteVariantWithFeedback.mockImplementation(
      async (_input, variant: AiResumeVariant) => ({ ...variant, summary: 'improved' }),
    );
    searchTool.search.mockResolvedValue([
      { title: 'NestJS Best Practices', url: 'https://example.com', snippet: 'Dependency injection patterns' },
    ]);
    const service = new ResumeAgentLoopService(
      aiService as unknown as ResumeAiService,
      scorer as unknown as ResumeScorerService,
      searchTool as unknown as WebSearchTool,
    );

    await service.run(input);

    expect(searchTool.search).toHaveBeenCalledTimes(1);
    expect(searchTool.search.mock.calls[0][0]).toContain('Backend Engineer');
    const rewriteArgs = aiService.rewriteVariantWithFeedback.mock.calls[0];
    expect(rewriteArgs[3]).toContain('Dependency injection patterns');
  });

  it('tolerates web search failures without breaking the loop', async () => {
    aiService.generate.mockResolvedValue([
      makeVariant('v1', 'a'),
      makeVariant('v2', 'b'),
      makeVariant('v3', 'c'),
    ]);
    scorer.scoreVariant.mockImplementation(async (_, variant: AiResumeVariant) =>
      Promise.resolve(
        variant.id === 'v2' && variant.summary === 'b' ? makeScore(50) : makeScore(90),
      ),
    );
    aiService.rewriteVariantWithFeedback.mockImplementation(
      async (_input, variant: AiResumeVariant) => ({ ...variant, summary: 'improved' }),
    );
    searchTool.search.mockRejectedValue(new Error('search provider down'));
    const service = new ResumeAgentLoopService(
      aiService as unknown as ResumeAiService,
      scorer as unknown as ResumeScorerService,
      searchTool as unknown as WebSearchTool,
    );

    const { variants } = await service.run(input);

    expect(variants).toHaveLength(3);
    expect(aiService.rewriteVariantWithFeedback).toHaveBeenCalledTimes(1);
  });
});
