import { MEMORY_CONSTRAINT_MAX_PER_MESSAGE } from './memory-candidate.types';
import { extractMemoryConstraintCandidates } from './memory-constraint-extractor';

describe('extractMemoryConstraintCandidates', () => {
  it('extracts a prohibition into a self-contained constraint', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '以后都不要用 emoji',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.content).toBe('禁止使用或提及「emoji」');
    expect(candidates[0]?.fragment).toBe('以后都不要用 emoji');
  });

  it('extracts an explicit prohibition keyword', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '请避免使用表格，谢谢',
    });

    expect(candidates.map((item) => item.content)).toEqual([
      '禁止「使用表格」',
    ]);
  });

  it('extracts identity and how the user wants to be addressed', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '我是后端工程师，叫我小李',
    });

    expect(candidates.map((item) => item.content)).toEqual([
      '用户身份：后端工程师',
      '用户身份：小李',
    ]);
  });

  it('extracts a hard requirement', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '必须给出代码示例',
    });

    expect(candidates.map((item) => item.content)).toEqual([
      '硬性要求：给出代码示例',
    ]);
  });

  it('extracts a persistence instruction and stops at clause separators', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '记住：回答要简洁，其它不用管',
    });

    expect(candidates.map((item) => item.content)).toEqual([
      '用户要求：回答要简洁',
    ]);
  });

  it('extracts nothing from ordinary messages', () => {
    expect(
      extractMemoryConstraintCandidates({ content: '帮我看看这份简历' }),
    ).toEqual([]);
    expect(extractMemoryConstraintCandidates({ content: '' })).toEqual([]);
  });

  it('drops dangling references that carry no constraint', () => {
    expect(
      extractMemoryConstraintCandidates({ content: '记住这一点' }),
    ).toEqual([]);
    expect(
      extractMemoryConstraintCandidates({ content: '不要再说这个了' }),
    ).toEqual([]);
    expect(
      extractMemoryConstraintCandidates({ content: '别再说那个了' }),
    ).toEqual([]);
    expect(
      extractMemoryConstraintCandidates({ content: '不要提这个事' }),
    ).toEqual([]);
  });

  it('drops recall and turn-taking expressions that are not durable constraints', () => {
    expect(
      extractMemoryConstraintCandidates({ content: '记得上次我们聊过' }),
    ).toEqual([]);
    expect(
      extractMemoryConstraintCandidates({ content: '我们必须先讨论一下' }),
    ).toEqual([]);
  });

  it('caps the number of constraints extracted per message', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '记住我叫小李，必须给出代码，不要用emoji，务必加上参考链接',
    });

    expect(candidates).toHaveLength(MEMORY_CONSTRAINT_MAX_PER_MESSAGE);
    expect(candidates.map((item) => item.content)).toEqual([
      '用户要求：我叫小李',
      '硬性要求：给出代码',
      '禁止使用或提及「emoji」',
    ]);
  });

  it('deduplicates identical constraints inside one message', () => {
    const candidates = extractMemoryConstraintCandidates({
      content: '不要用emoji。另外请不要用 emoji',
    });

    expect(candidates.map((item) => item.content)).toEqual([
      '禁止使用或提及「emoji」',
    ]);
  });
});
