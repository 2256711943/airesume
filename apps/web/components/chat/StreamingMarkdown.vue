<script setup lang="ts">
/**
 * 流式 Markdown 渲染组件。
 *
 * `safe` 前缀交给 markdown-it 渲染为 HTML；`tail` 未稳定部分以纯文本插值并附带光标，
 * 呈现打字机的真实中间态。`streaming` 为假时整段一次性渲染，退化为单块 v-html。
 *
 * `incomplete` 为真表示本次回复被中断（真截断）：渲染侧会补齐未闭合围栏并丢弃未完成块，
 * 避免半截结构吞掉后续内容，同时在末尾明确标注"本次回复未完成"。
 */
import { useStreamingMarkdown } from "../../composables/useStreamingMarkdown";

const props = defineProps<{
  /** 消息原文，仅读取，不回写 */
  markdown: string;
  /** 是否处于流式输出中，缺省按终态处理 */
  streaming?: boolean;
  /** 本次回复是否被中断（内容不完整），缺省 `false` */
  incomplete?: boolean;
}>();

const { rendered } = useStreamingMarkdown({
  markdown: () => props.markdown,
  streaming: () => props.streaming,
  incomplete: () => props.incomplete,
});
</script>

<template>
  <div class="markdown-body" v-html="rendered.html" />
  <span v-if="rendered.tail" class="md-streaming-tail"
    >{{ rendered.tail }}<i class="md-caret"
  /></span>
  <p v-if="incomplete && !streaming" class="md-incomplete-hint">
    本次回复未完成，内容可能不完整。
  </p>
</template>

<style scoped>
/* Markdown 排版：两页共用一套，颜色走全局设计 token */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: var(--app-text);
  font-weight: 700;
}

.markdown-body :deep(h1) {
  margin-top: 0;
  font-size: 22px;
}

.markdown-body :deep(h2) {
  margin-top: 18px;
  font-size: 17px;
}

.markdown-body :deep(h3) {
  margin-top: 14px;
  font-size: 15px;
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: var(--app-muted-strong);
  line-height: 1.8;
  font-size: 14px;
}

.markdown-body :deep(ul) {
  padding-left: 20px;
}

.markdown-body :deep(a) {
  color: var(--app-primary);
  text-decoration: none;
  border-bottom: 1px solid rgba(6, 182, 212, 0.22);
}

.markdown-body :deep(code) {
  background: rgba(248, 250, 252, 0.98);
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 13px;
  color: var(--app-text);
}

/* 未稳定尾巴：纯文本观感，必须保留 pre-wrap 以还原空格与换行 */
.md-streaming-tail {
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  color: inherit;
}

.md-caret {
  display: inline-block;
  width: 1px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: currentColor;
  animation: md-caret-blink 1s steps(2, start) infinite;
}

@keyframes md-caret-blink {
  0%,
  50% {
    opacity: 1;
  }

  50.01%,
  100% {
    opacity: 0;
  }
}

/* 真截断提示：明确告知内容不完整，替代"静默补符号"的隐性修复 */
.md-incomplete-hint {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(254, 226, 226, 0.7);
  border: 1px solid rgba(248, 113, 113, 0.28);
  color: #b91c1c;
  font-size: 12px;
  line-height: 1.6;
}
</style>
