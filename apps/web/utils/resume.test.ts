import { describe, expect, it } from 'vitest';

import {
  buildAllVariantsMarkdown,
  buildChatTrace,
  buildCurrentChatTitle,
  buildFormSummaryLines,
  buildGenerateQuery,
  buildSystemContextMessage,
  buildVariantFileName,
  buildVariantMarkdown,
  createChatMessageId,
  createResumeFormState,
  defaultRouteDecision,
  getInitialChatMessages,
  getStreamStageLabel,
  getVariantLabel,
  isGenerationReady,
  parseExperienceLines,
  parseProjectLines,
  parseVariants,
  splitEntries,
  type ResumeFormState,
  type ResumeVariant,
} from './resume';

function createForm(overrides: Partial<ResumeFormState> = {}): ResumeFormState {
  return {
    ...createResumeFormState(),
    fullName: '张三',
    background: '5 年后端工程经验',
    targetRole: '高级工程师',
    targetDescription: '负责核心链路',
    skillsText: 'TypeScript, Node.js',
    targetSkillsText: '分布式, 监控',
    experienceText: 'OpenAI|工程师|优化接口;推动重构',
    projectText: 'AI 平台|搭建工作流;接入 SSE',
    ...overrides,
  };
}

const sampleVariant: ResumeVariant = {
  id: 'v1',
  summary: '匹配目标岗位的技术负责人候选人。',
  experience: [{ company: 'OpenAI', role: '工程师', highlights: ['优化接口', '推动重构'] }],
  projects: [{ name: 'AI 平台', highlights: ['搭建工作流'] }],
  skills: ['TypeScript', 'Node.js'],
};

describe('resume utils', () => {
  it('splits comma and newline separated entries', () => {
    expect(splitEntries('A, B\nC')).toEqual(['A', 'B', 'C']);
  });

  it('parses experience lines and fills fallback highlight', () => {
    expect(parseExperienceLines('OpenAI|工程师|\ninvalid')).toEqual([
      {
        company: 'OpenAI',
        role: '工程师',
        highlights: ['负责 工程师 相关工作'],
      },
    ]);
  });

  it('parses project lines and fills fallback highlight', () => {
    expect(parseProjectLines('AI 平台|\n')).toEqual([
      {
        name: 'AI 平台',
        highlights: ['完成了该项目的关键交付'],
      },
    ]);
  });

  it('normalizes API variants and drops invalid records', () => {
    expect(
      parseVariants([
        {
          id: 'v1',
          summary: 'summary',
          experience: [{ company: 'A', role: 'B', highlights: [1, 'x'] }],
          projects: [{ name: 'P', highlights: ['y'] }],
          skills: ['ts', 1],
        },
        { bad: true },
      ]),
    ).toEqual([
      {
        id: 'v1',
        mode: undefined,
        summary: 'summary',
        experience: [{ company: 'A', role: 'B', highlights: ['1', 'x'] }],
        projects: [{ name: 'P', highlights: ['y'] }],
        skills: ['ts', '1'],
      },
    ]);
  });

  it('builds current title and summary lines from the form', () => {
    const form = createForm({ targetRole: '', skillsText: '' });
    expect(buildCurrentChatTitle(form.targetRole)).toBe('UP AI 简历对话');
    expect(buildFormSummaryLines(form)).toEqual([
      '姓名：张三',
      '目标岗位：未填写',
      '背景：5 年后端工程经验',
      '技能：未填写',
    ]);
  });

  it('builds generate query with serialized profile and target job', () => {
    const query = new URLSearchParams(buildGenerateQuery(createForm()));
    expect(JSON.parse(query.get('profile') ?? '')).toMatchObject({
      fullName: '张三',
      background: '5 年后端工程经验',
      skills: ['TypeScript', 'Node.js'],
    });
    expect(JSON.parse(query.get('targetJob') ?? '')).toMatchObject({
      title: '高级工程师',
      mustHaveSkills: ['分布式', '监控'],
    });
    expect(query.get('tone')).toBe('professional');
    expect(query.get('language')).toBe('zh-CN');
    expect(query.get('variants')).toBe('3');
  });

  it('builds system context with counts and defaults', () => {
    const message = buildSystemContextMessage(
      createForm({
        targetSkillsText: '',
        projectText: '',
      }),
    );
    expect(message).toContain('SYSTEM / UP AI 简历上下文');
    expect(message).toContain('- 岗位要求：未填写');
    expect(message).toContain('- 工作经历：1 条');
    expect(message).toContain('- 项目经历：未填写');
  });

  it('builds variant markdown and aggregated markdown', () => {
    expect(buildVariantMarkdown(sampleVariant, '技术版')).toContain('# 技术版');
    expect(buildAllVariantsMarkdown([sampleVariant])).toContain('## 核心技能');
    expect(buildAllVariantsMarkdown([])).toBe('当前还没有生成结果。');
  });

  it('provides variant labels, file names, and stream labels', () => {
    expect(getVariantLabel(0)).toBe('技术版');
    expect(getVariantLabel(9)).toBe('版本 10');
    expect(buildVariantFileName('高级工程师', 1)).toBe('高级工程师-业务版.md');
    expect(getStreamStageLabel('planning')).toBe('规划中');
    expect(getStreamStageLabel('')).toBe('等待生成');
  });

  it('evaluates generation readiness', () => {
    expect(isGenerationReady(createForm())).toBe(true);
    expect(isGenerationReady(createForm({ skillsText: '' }))).toBe(false);
  });

  it('creates deterministic chat defaults and traces', () => {
    expect(getInitialChatMessages()).toHaveLength(1);
    expect(createChatMessageId('assistant', 10, 0.123456)).toBe('assistant_10_4fzyo8');
    const trace = buildChatTrace('run-1', defaultRouteDecision);
    expect(trace).toMatchObject({
      agentRunId: 'run-1',
      routeDecision: defaultRouteDecision,
      toolSpans: [],
      routeDecisionStarted: false,
      done: false,
    });
  });
});
