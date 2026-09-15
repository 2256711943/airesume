import { MEMORY_CONSTRAINT_MAX_PER_MESSAGE } from './memory-candidate.types';

/**
 * 规则抽取出的硬约束候选项。
 */
export interface MemoryConstraintCandidate {
  /** 归一化后的自包含约束陈述，可直接注入提示词。 */
  content: string;
  /** 命中的原始片段，用于溯源。 */
  fragment: string;
}

/**
 * 单条约束抽取规则：把命中片段套进模板，得到可注入的约束陈述。
 */
interface MemoryConstraintExtractionRule {
  /** 归一化模板，`{body}` 会被替换为捕获到的约束主体。 */
  template: string;
  patterns: readonly RegExp[];
  /** 额外的语义校验，返回 false 表示该主体属于误抽。 */
  validateBody?: (body: string) => boolean;
}

/** 约束主体的最小长度（过短多为噪声）。 */
const MIN_BODY_LENGTH = 2;

/** 约束主体的最大长度，超出视为误匹配。 */
const MAX_BODY_LENGTH = 60;

/** 指代不明的主体：脱离原文无法理解，抽取后没有约束力。 */
const DANGLING_BODIES = new Set(['一下', '一会儿', '之类', '等等']);

/**
 * 纯指代式主体（"这个了" / "这些了" / "那个" / "这件事" / "上述"）。
 * 这类主体即使带上了语气助词或量词，也依然无法自包含。
 */
const DANGLING_BODY_PATTERN =
  /^(?:这|那|此|该|上述|以上|前面)(?:一)?(?:个|些|点|件|事|话|次|种|样|方面|问题|话题|东西|时候){0,2}[了吧呢啊呀]?$/;

/** 回忆式表达（"记得上次我们聊过"）只是在回溯，不构成长期约束。 */
const RECALL_BODY_PREFIX_PATTERN = /^(?:上次|上回|之前|先前|刚才|刚刚|前面)/;

/** 话轮衔接式表达（"必须先讨论一下"）指向当前对话，不构成长期约束。 */
const EPHEMERAL_BODY_PATTERN =
  /^(?:先)?(?:讨论|聊|聊聊|说说|看看|看一下|了解|确认|商量)(?:一下|一遍)?$/;

/**
 * 硬约束抽取规则（快通道，零 LLM）。
 *
 * 只覆盖高置信度的显式约束表达，宁可漏抽也不要误抽：
 * 误抽的约束会被每轮注入提示词，代价远高于漏抽。
 */
const MEMORY_CONSTRAINT_EXTRACTION_RULES: readonly MemoryConstraintExtractionRule[] =
  [
    {
      // 禁止项："不要用 emoji" / "以后别再说这个" / "do not use bullet points"
      template: '禁止使用或提及「{body}」',
      patterns: [
        /(?:以后|下次|之后|从现在起|今后)?\s*(?:都)?(?:不要|别)(?:再)?(?:给我)?(?:用|使用|写|输出|提|说|加)\s*([^\s,，。.;；!！?？\n]{2,24})/g,
        /\b(?:do not|don't|never)\s+(?:use|write|mention|output)\s+([a-z][a-z0-9\s-]{1,40})/gi,
      ],
    },
    {
      // 显式禁止："避免 emoji" / "禁止使用表格"
      template: '禁止「{body}」',
      patterns: [
        /(?:请)?(?:避免|禁止|不许|严禁)\s*([^\s,，。.;；!！?？\n]{2,24})/g,
      ],
    },
    {
      // 显式记忆指令："记住：我叫小李" / "remember to use STAR"
      template: '用户要求：{body}',
      patterns: [
        /(?:请)?(?:记住|记一下|牢记|记得)[：:,，]?\s*([^\n。，,；;!！?？]{2,40})/g,
        /\b(?:remember|note)\b[：:\s]+([^\n.,;!?]{2,60})/gi,
      ],
      validateBody: (body) => !RECALL_BODY_PREFIX_PATTERN.test(body),
    },
    {
      // 持续性要求："以后都叫我小李" / "from now on always answer in Chinese"
      template: '用户要求：{body}',
      patterns: [
        /(?:以后|今后)(?:都|要|请|一律|必须|就)\s*([^\n。，,；;!！?？]{2,60})/g,
        /从现在(?:起|开始)[，,]?\s*([^\n。，,；;!！?？]{2,60})/g,
        /\bfrom now on\b[,:\s]+([^\n.,;!?]{2,60})/gi,
      ],
    },
    {
      // 身份与称呼："我是后端工程师" / "叫我小李" / "我的名字是 ..."
      template: '用户身份：{body}',
      patterns: [
        /我是(?:一名|一个|个)?\s*([^\s,，。.;；]{2,20}?(?:工程师|开发者|开发|程序员|设计师|产品经理|项目经理|测试|运营|分析师|架构师|研究员|学生|老师|创始人|负责人|后端|前端|全栈))/g,
        /(?:可以)?叫我\s*([^\s,，。.;；]{1,20})/g,
        /我的名字(?:是|叫)\s*([^\s,，。.;；]{1,20})/g,
      ],
    },
    {
      // 硬性要求："必须给出代码" / "you must cite sources"
      template: '硬性要求：{body}',
      patterns: [
        /(?:必须|务必|一定要)\s*([^\n。，,；;!！?？]{2,40})/g,
        /\b(?:must|required to)\s+([a-z][^\n.,;!?]{1,40})/gi,
      ],
      validateBody: (body) => !EPHEMERAL_BODY_PATTERN.test(body),
    },
  ];

/**
 * 从用户消息中规则抽取硬约束（Constraint 快通道）。
 *
 * 纯同步、零网络调用，可安全地 await 在请求主链路上，保证约束当轮生效。
 *
 * @param input 抽取输入，包含本轮用户消息原文
 * @returns 归一化后的约束候选，按出现顺序去重，最多 {@link MEMORY_CONSTRAINT_MAX_PER_MESSAGE} 条
 */
export function extractMemoryConstraintCandidates(input: {
  content: string;
}): MemoryConstraintCandidate[] {
  const text = input.content.trim();
  if (!text) {
    return [];
  }

  const matches: Array<{
    candidate: MemoryConstraintCandidate;
    index: number;
    end: number;
  }> = [];

  for (const rule of MEMORY_CONSTRAINT_EXTRACTION_RULES) {
    for (const pattern of rule.patterns) {
      // 每次都新建正则，避免跨调用共享 lastIndex 状态。
      const globalPattern = new RegExp(
        pattern.source,
        pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
      );

      for (const match of text.matchAll(globalPattern)) {
        const body = normalizeBody(match[1]);
        const index = match.index ?? -1;
        if (index < 0 || !isValidBody(body)) {
          continue;
        }

        if (rule.validateBody && !rule.validateBody(body)) {
          continue;
        }

        matches.push({
          candidate: {
            content: rule.template.replace('{body}', body),
            fragment: match[0].trim(),
          },
          index,
          end: index + match[0].length,
        });
      }
    }
  }

  // 按出现位置排序（同位置时保持规则声明顺序），再做去重与重叠抑制：
  // 同一条原文可能同时命中多条规则（如"以后都不要用 emoji"同时命中禁止项与持续性要求），
  // 只保留最先命中的那条，避免同一句话被注入成多条重复约束。
  const seen = new Set<string>();
  const accepted: typeof matches = [];

  for (const match of matches.sort((left, right) => left.index - right.index)) {
    if (seen.has(match.candidate.content)) {
      continue;
    }

    const overlaps = accepted.some(
      (item) => match.index < item.end && match.end > item.index,
    );
    if (overlaps) {
      continue;
    }

    seen.add(match.candidate.content);
    accepted.push(match);
    if (accepted.length >= MEMORY_CONSTRAINT_MAX_PER_MESSAGE) {
      break;
    }
  }

  return accepted.map(({ candidate }) => candidate);
}

/** 归一化约束主体：去掉首尾标点并压缩空白。 */
function normalizeBody(value: string | undefined): string {
  return (value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,，。.;；:：、!！?？"'「」【】]+/, '')
    .replace(/[\s,，。.;；:：、"'「」【】]+$/, '')
    .trim();
}

/** 判断约束主体是否具备可注入的语义。 */
function isValidBody(body: string): boolean {
  if (body.length < MIN_BODY_LENGTH || body.length > MAX_BODY_LENGTH) {
    return false;
  }

  if (DANGLING_BODIES.has(body)) {
    return false;
  }

  return !DANGLING_BODY_PATTERN.test(body);
}
