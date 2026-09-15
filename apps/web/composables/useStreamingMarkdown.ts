import { computed, type ComputedRef, type Ref } from "vue";

import {
  finalizeTruncatedMarkdown,
  MarkdownStreamFsm,
  renderMarkdown,
  type StableMarkdownDiagnostics,
} from "../utils/markdown-stream";

/**
 * 流式 Markdown 的 Vue 派生层。
 *
 * 每个聊天消息对应一个组合式函数实例：在实例内维护该消息的 buffer、FSM 与渲染结果，
 * 通过 computed 派生 `safe` / `tail`。始终只读取 `markdown` 源，绝不回写，避免污染
 * `message.content`（复制按钮与持久化仍使用原始内容）。
 */

/** 派生出的流式 Markdown 渲染结果 */
export interface StreamingMarkdownRender {
  /**
   * 实际交给 markdown-it 渲染的 Markdown 源码。
   * 流式阶段为已确认结构稳定的前缀；终态为整段原文；真截断降级后为降级文本。
   */
  safe: string;
  /** 未稳定尾巴，由上层以纯文本插值渲染；终态恒为空 */
  tail: string;
  /** `safe` 经 markdown-it 渲染后的 HTML */
  html: string;
  /** 诊断信息，供埋点与单测断言 */
  diagnostics: StableMarkdownDiagnostics;
  /** 是否命中了真截断降级（终态且内容存在未闭合结构时为真） */
  truncated: boolean;
}

/** markdown 数据源：响应式 ref 或普通 getter */
export type StreamingMarkdownSource = Ref<string> | (() => string);

/** 流式状态数据源：ref / getter / 原始布尔值，缺省按终态处理 */
export type StreamingMarkdownFlagSource =
  | Ref<boolean | undefined>
  | (() => boolean | undefined)
  | boolean
  | undefined;

export interface UseStreamingMarkdownOptions {
  /** 消息内容来源，仅读取，不回写 */
  markdown: StreamingMarkdownSource;
  /** 是否处于流式输出中，缺省 `false` */
  streaming?: StreamingMarkdownFlagSource;
  /** 是否已被判定为真截断（流异常终止且内容不完整），缺省 `false` */
  incomplete?: StreamingMarkdownFlagSource;
  /** 长度增量阈值（字符）：增量不足且未超时则复用上次渲染的 HTML */
  minCharDelta?: number;
  /** 时间阈值（毫秒）：距上次渲染不足且增量不足则复用上次渲染的 HTML */
  minIntervalMs?: number;
  /** 当前时间来源，便于测试注入 */
  now?: () => number;
}

export interface UseStreamingMarkdownReturn {
  /**
   * 派生渲染结果；`streaming` 为假时 `tail` 恒为空，整段一次性渲染；
   * `incomplete` 为真时改用安全降级文本渲染，避免未闭合结构吞掉后续内容。
   */
  rendered: ComputedRef<StreamingMarkdownRender>;
}

/** 长度增量阈值默认值（字符） */
const DEFAULT_MIN_CHAR_DELTA = 24;
/** 时间阈值默认值（毫秒） */
const DEFAULT_MIN_INTERVAL_MS = 48;

/** 单条消息的派生层缓存，随组合式函数实例生命周期存在 */
interface MessageRenderEntry {
  /** 该消息的流式 FSM（持有 buffer 与块级状态） */
  fsm: MarkdownStreamFsm;
  /** 上次成功渲染对应（按 safe 重新渲染）的原始 markdown，用作前缀一致性与增量基准 */
  buffer: string;
  /** 上次成功渲染时的流式状态 */
  streaming: boolean;
  /** 上次成功渲染时的真截断标记 */
  incomplete: boolean;
  /** 上次渲染出的稳定前缀 */
  safe: string;
  /** 上次渲染出的 HTML */
  html: string;
  /** 上次渲染的诊断信息 */
  diagnostics: StableMarkdownDiagnostics;
  /** 上次渲染是否命中真截断降级 */
  truncated: boolean;
  /** 上次渲染时刻 */
  renderedAt: number;
}

interface BlockRenderResult {
  safe: string;
  html: string;
  diagnostics: StableMarkdownDiagnostics;
  truncated: boolean;
}

function createMarkdownReader(source: StreamingMarkdownSource): () => string {
  return typeof source === "function" ? source : () => source.value;
}

function createStreamingReader(
  source: StreamingMarkdownFlagSource,
): () => boolean {
  if (source === undefined) {
    return () => false;
  }

  if (typeof source === "boolean") {
    return () => source;
  }

  return typeof source === "function"
    ? () => Boolean(source())
    : () => Boolean(source.value);
}

/**
 * 依据当前 markdown、流式状态与截断标记生成新的缓存条目。
 *
 * - 前缀一致（`markdown` 以 `previous.buffer` 开头）：走增量 `push`，只追加新增片段；
 * - 前缀不一致（内容被整体替换）：`rebuild` 全量重建，不拼接旧缓存。
 */
function createEntry(
  previous: MessageRenderEntry | null,
  markdown: string,
  streaming: boolean,
  incomplete: boolean,
  now: () => number,
): MessageRenderEntry {
  const canAppend = previous !== null && markdown.startsWith(previous.buffer);
  const fsm = canAppend ? previous.fsm : new MarkdownStreamFsm();

  if (!canAppend) {
    fsm.rebuild(markdown);
  } else if (markdown.length > previous.buffer.length) {
    fsm.push(markdown.slice(previous.buffer.length));
  }

  const rendered = buildRender(fsm, streaming, incomplete);

  return {
    fsm,
    buffer: markdown,
    streaming,
    incomplete,
    safe: rendered.safe,
    html: rendered.html,
    diagnostics: rendered.diagnostics,
    truncated: rendered.truncated,
    renderedAt: now(),
  };
}

function buildRender(
  fsm: MarkdownStreamFsm,
  streaming: boolean,
  incomplete: boolean,
): BlockRenderResult {
  const slice = fsm.slice;

  if (!streaming) {
    // 终态：不做 safe/tail 切分，整段交给 markdown-it，保证结构正确
    if (incomplete) {
      // 真截断：补齐顶层围栏并丢弃未完成块，避免半截结构吞掉后续 UI 文案
      const finalized = finalizeTruncatedMarkdown(fsm.raw);
      return {
        safe: finalized.text,
        html: renderMarkdown(finalized.text),
        diagnostics: slice.diagnostics,
        truncated: finalized.truncated,
      };
    }

    return {
      safe: fsm.raw,
      html: renderMarkdown(fsm.raw),
      diagnostics: slice.diagnostics,
      truncated: false,
    };
  }

  return {
    safe: slice.safe,
    html: renderMarkdown(slice.safe),
    diagnostics: slice.diagnostics,
    truncated: false,
  };
}

/**
 * 创建流式 Markdown 派生层。
 *
 * @param options - 数据源与节流配置
 * @returns `rendered`：派生渲染结果
 */
export function useStreamingMarkdown(
  options: UseStreamingMarkdownOptions,
): UseStreamingMarkdownReturn {
  const minCharDelta = Math.max(
    0,
    options.minCharDelta ?? DEFAULT_MIN_CHAR_DELTA,
  );
  const minIntervalMs = Math.max(
    0,
    options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
  );
  const now = options.now ?? (() => Date.now());
  const readMarkdown = createMarkdownReader(options.markdown);
  const readStreaming = createStreamingReader(options.streaming);
  const readIncomplete = createStreamingReader(options.incomplete);

  let entry: MessageRenderEntry | null = null;

  /** 双闸判断：增量不足且时间未到则复用上次 HTML */
  const shouldReuseHtml = (
    current: MessageRenderEntry,
    markdown: string,
    streaming: boolean,
  ): boolean => {
    if (!streaming) {
      return markdown === current.buffer;
    }

    const delta = markdown.length - current.buffer.length;
    if (delta === 0) {
      return true;
    }

    return delta < minCharDelta && now() - current.renderedAt < minIntervalMs;
  };

  const rendered = computed<StreamingMarkdownRender>(() => {
    const markdown = readMarkdown();
    const streaming = readStreaming();
    const incomplete = readIncomplete();
    const current = entry;

    const canReuseHtml =
      current !== null &&
      current.streaming === streaming &&
      current.incomplete === incomplete &&
      markdown.startsWith(current.buffer) &&
      shouldReuseHtml(current, markdown, streaming);

    let active: MessageRenderEntry;
    if (canReuseHtml && current) {
      active = current;
    } else {
      active = createEntry(current, markdown, streaming, incomplete, now);
      entry = active;
    }

    // tail 只在流式阶段派生，保证打字机中间态连续；终态恒为空（整段已交给 markdown-it）
    return {
      safe: active.safe,
      tail: streaming ? markdown.slice(active.safe.length) : "",
      html: active.html,
      diagnostics: active.diagnostics,
      truncated: active.truncated,
    };
  });

  return { rendered };
}
