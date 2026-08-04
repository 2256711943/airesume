import {
  getDisplayPreferenceCategoryByKey,
  type DisplayPreferenceCandidate,
  type DisplayPreferenceKey,
  type DisplayPreferenceValue,
} from '../memory/display-preference.types';

/**
 * 显式显示偏好提取规则。
 */
interface DisplayPreferenceExtractionRule<
  Key extends DisplayPreferenceKey = DisplayPreferenceKey,
> {
  key: Key;
  value: DisplayPreferenceValue<Key>;
  patterns: readonly RegExp[];
}

/**
 * 单条命中的偏好匹配结果。
 */
interface DisplayPreferenceExtractionMatch<
  Key extends DisplayPreferenceKey = DisplayPreferenceKey,
> {
  key: Key;
  value: DisplayPreferenceValue<Key>;
  fragment: string;
  index: number;
}

const DISPLAY_PREFERENCE_EXTRACTION_RULES = [
  {
    key: 'response_language',
    value: 'bilingual',
    patterns: [/中英双语/gi, /\bbilingual\b/gi],
  },
  {
    key: 'response_language',
    value: 'zh-CN',
    patterns: [
      /用中文回答/gi,
      /请用中文/gi,
      /中文回复/gi,
      /中文就行/gi,
      /\bin chinese\b/gi,
    ],
  },
  {
    key: 'response_language',
    value: 'en-US',
    patterns: [
      /用英文回答/gi,
      /请用英文/gi,
      /英文回复/gi,
      /\bin english\b/gi,
      /respond in english/gi,
    ],
  },
  {
    key: 'response_tone',
    value: 'professional',
    patterns: [/专业一点/gi, /语气专业/gi, /\bprofessional\b/gi],
  },
  {
    key: 'response_tone',
    value: 'friendly',
    patterns: [/友好一点/gi, /语气友好/gi, /\bfriendly\b/gi],
  },
  {
    key: 'response_tone',
    value: 'direct',
    patterns: [/直接一点/gi, /别太客套/gi, /\bdirect\b/gi],
  },
  {
    key: 'response_tone',
    value: 'formal',
    patterns: [/正式一点/gi, /语气正式/gi, /\bformal\b/gi],
  },
  {
    key: 'response_tone',
    value: 'concise',
    patterns: [/简洁一点/gi, /精简一点/gi, /\bconcise\b/gi],
  },
  {
    key: 'response_length',
    value: 'short',
    patterns: [/简短回答/gi, /短一点/gi, /别写太长/gi, /\bshort answer\b/gi],
  },
  {
    key: 'response_length',
    value: 'medium',
    patterns: [/长度适中/gi, /中等长度/gi, /\bmedium length\b/gi],
  },
  {
    key: 'response_length',
    value: 'long',
    patterns: [/详细一点/gi, /展开一点/gi, /写长一点/gi, /\bdetailed\b/gi],
  },
  {
    key: 'output_format',
    value: 'table',
    patterns: [/用表格/gi, /表格给我/gi, /\btable\b/gi],
  },
  {
    key: 'output_format',
    value: 'bullet_list',
    patterns: [/用列表/gi, /项目符号/gi, /\bbullet list\b/gi],
  },
  {
    key: 'output_format',
    value: 'numbered_list',
    patterns: [/编号列表/gi, /用序号/gi, /\bnumbered list\b/gi],
  },
  {
    key: 'markdown_preference',
    value: 'markdown',
    patterns: [/用markdown/gi, /\bmarkdown\b/gi],
  },
  {
    key: 'markdown_preference',
    value: 'plain_text',
    patterns: [/纯文本就行/gi, /直接纯文本/gi, /\bplain text\b/gi],
  },
  {
    key: 'response_structure',
    value: 'answer_first',
    patterns: [/先给结论/gi, /先说结论/gi, /\banswer first\b/gi],
  },
  {
    key: 'response_structure',
    value: 'summary_then_detail',
    patterns: [
      /先总结再展开/gi,
      /先总结再给细节/gi,
      /\bsummary then detail\b/gi,
    ],
  },
  {
    key: 'response_structure',
    value: 'steps_first',
    patterns: [/按步骤写/gi, /分步骤/gi, /\bstep by step\b/gi],
  },
  {
    key: 'section_policy',
    value: 'sections_required',
    patterns: [/分小节/gi, /加小标题/gi, /\buse sections\b/gi],
  },
  {
    key: 'example_policy',
    value: 'with_examples',
    patterns: [/给我带例子/gi, /举个例子/gi, /\bwith examples\b/gi],
  },
  {
    key: 'example_policy',
    value: 'without_examples',
    patterns: [/不要例子/gi, /别举例/gi, /\bwithout examples\b/gi],
  },
  {
    key: 'example_policy',
    value: 'minimal_examples',
    patterns: [/最小示例/gi, /简单例子/gi, /\bminimal example\b/gi],
  },
  {
    key: 'code_example_policy',
    value: 'with_code',
    patterns: [/给代码示例/gi, /带代码/gi, /\bwith code\b/gi],
  },
  {
    key: 'code_example_policy',
    value: 'without_code',
    patterns: [/不要代码示例/gi, /别给代码/gi, /\bwithout code\b/gi],
  },
  {
    key: 'content_order',
    value: 'issues_then_fix',
    patterns: [/先说问题再说怎么改/gi, /先问题后方案/gi],
  },
  {
    key: 'content_order',
    value: 'plan_then_details',
    patterns: [/先给方案再补细节/gi, /先方案后细节/gi],
  },
  {
    key: 'content_order',
    value: 'result_then_reason',
    patterns: [/先给结果后面再解释/gi, /先结果后原因/gi],
  },
  {
    key: 'content_order',
    value: 'code_then_explanation',
    patterns: [/先给代码再解释/gi, /代码放前面/gi],
  },
] as const satisfies readonly DisplayPreferenceExtractionRule[];

/**
 * 从用户消息中提取显式显示偏好候选项。
 *
 * @param input 提取输入，包含消息 ID 与原始内容
 * @returns 当前消息中识别出的显式显示偏好列表
 */
export function extractDisplayPreferenceCandidates(input: {
  messageId: string;
  content: string;
}): DisplayPreferenceCandidate[] {
  const text = input.content.trim();
  if (!text) {
    return [];
  }

  const matchesByKey = new Map<
    DisplayPreferenceKey,
    DisplayPreferenceExtractionMatch
  >();

  for (const rule of DISPLAY_PREFERENCE_EXTRACTION_RULES) {
    const match = findLatestRuleMatch(text, rule);
    if (!match) {
      continue;
    }

    const previous = matchesByKey.get(rule.key);
    if (!previous || previous.index <= match.index) {
      matchesByKey.set(rule.key, match);
    }
  }

  return Array.from(matchesByKey.values())
    .sort((left, right) => left.index - right.index)
    .map((match) => ({
      category: getDisplayPreferenceCategoryByKey(match.key),
      key: match.key,
      value: match.value,
      sourceKind: 'user_text',
      sourceRef: {
        kind: 'conversation_message',
        sourceId: input.messageId,
        fragment: match.fragment,
        metadata: {
          key: match.key,
          value: match.value,
        },
      },
      rawContent: match.fragment,
    }));
}

/**
 * 查找某条规则在文本中的最后一次命中。
 *
 * @param text 待提取的原始文本
 * @param rule 偏好提取规则
 * @returns 若命中则返回最后一次匹配结果，否则返回 null
 */
function findLatestRuleMatch<Key extends DisplayPreferenceKey>(
  text: string,
  rule: DisplayPreferenceExtractionRule<Key>,
): DisplayPreferenceExtractionMatch<Key> | null {
  let latestMatch: DisplayPreferenceExtractionMatch<Key> | null = null;

  for (const pattern of rule.patterns) {
    const patternMatch = findLatestPatternMatch(text, pattern);
    if (!patternMatch) {
      continue;
    }

    if (!latestMatch || latestMatch.index <= patternMatch.index) {
      latestMatch = {
        key: rule.key,
        value: rule.value,
        fragment: patternMatch.fragment,
        index: patternMatch.index,
      };
    }
  }

  return latestMatch;
}

/**
 * 查找单个正则在文本中的最后一次命中位置。
 *
 * @param text 待提取的原始文本
 * @param pattern 提取使用的正则表达式
 * @returns 若命中则返回命中片段与位置，否则返回 null
 */
function findLatestPatternMatch(
  text: string,
  pattern: RegExp,
): { fragment: string; index: number } | null {
  const normalizedFlags = pattern.flags.includes('g')
    ? pattern.flags
    : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, normalizedFlags);

  let latest: { fragment: string; index: number } | null = null;
  for (const match of text.matchAll(globalPattern)) {
    const fragment = match[0]?.trim();
    const index = match.index ?? -1;
    if (!fragment || index < 0) {
      continue;
    }

    latest = { fragment, index };
  }

  return latest;
}
