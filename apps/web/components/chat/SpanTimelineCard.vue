<script setup lang="ts">
import { computed } from "vue";

import type { Span, SpanTreeNode } from "../../composables/useSpanStore";

interface SpanTimelineRow {
  depth: number;
  isActive: boolean;
  span: Span;
}

const props = defineProps<{
  runId?: string | null;
  tree: SpanTreeNode[];
  highlightedSpanId?: string | null;
}>();

const emit = defineEmits<{
  (event: "span-click", spanId: string): void;
  (event: "span-hover", spanId: string): void;
  (event: "span-leave"): void;
}>();

const kindLabels: Record<Span["kind"], string> = {
  run: "运行",
  step: "步骤",
  tool: "工具",
  text: "文本",
  checkpoint: "检查点",
};

const statusLabels: Record<Span["status"], string> = {
  pending: "等待中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
};

const statusTagType: Record<
  Span["status"],
  "success" | "primary" | "danger" | "info"
> = {
  pending: "primary",
  running: "primary",
  succeeded: "success",
  failed: "danger",
  canceled: "info",
};

function flattenTree(
  nodes: SpanTreeNode[],
  depth = 0,
  rows: SpanTimelineRow[] = [],
): SpanTimelineRow[] {
  for (const node of nodes) {
    rows.push({
      depth,
      isActive: node.isActive,
      span: node.span,
    });

    if (node.children.length > 0) {
      flattenTree(node.children, depth + 1, rows);
    }
  }

  return rows;
}

const rows = computed(() => flattenTree(props.tree));
const totalCount = computed(() => rows.value.length);
const activeCount = computed(
  () => rows.value.filter((row) => row.isActive).length,
);
const rootLabel = computed(
  () => props.runId?.trim() || rows.value[0]?.span.runId || "run",
);
const rootStatus = computed<Span["status"]>(
  () => rows.value[0]?.span.status ?? "pending",
);

const getErrorMessage = (span: Span): string => {
  return typeof span.meta.errorMessage === "string"
    ? span.meta.errorMessage
    : "";
};
</script>

<template>
  <details v-if="rows.length > 0" class="span-timeline-card" open>
    <summary class="span-timeline-summary">
      <div class="summary-leading">
        <p class="trace-kicker">span timeline</p>
        <strong>{{ rootLabel }}</strong>
        <span class="trace-run-id">
          {{ statusLabels[rootStatus] }} · {{ totalCount }} spans
        </span>
      </div>

      <div class="summary-metrics">
        <el-tag type="primary" size="small"> {{ activeCount }} active </el-tag>
      </div>

      <span class="summary-chevron" aria-hidden="true"> ▾ </span>
    </summary>

    <div class="timeline-body">
      <div
        v-for="row in rows"
        :key="row.span.spanId"
        class="timeline-row"
        :style="{ '--span-depth': row.depth }"
      >
        <div class="timeline-rail">
          <span
            class="timeline-dot"
            :class="[row.span.kind, row.span.status, { active: row.isActive }]"
          />
        </div>

        <article
          class="timeline-card"
          :class="{
            active: row.isActive,
            highlighted: row.span.spanId === highlightedSpanId,
          }"
          role="button"
          tabindex="0"
          @click="emit('span-click', row.span.spanId)"
          @mouseenter="emit('span-hover', row.span.spanId)"
          @mouseleave="emit('span-leave')"
        >
          <div class="timeline-head">
            <div>
              <p class="timeline-kind">
                {{ kindLabels[row.span.kind] }}
              </p>
              <strong>{{ row.span.name }}</strong>
            </div>
            <el-tag :type="statusTagType[row.span.status]" size="small">
              {{ statusLabels[row.span.status] }}
            </el-tag>
          </div>

          <div class="timeline-meta">
            <span>{{ row.span.spanId }}</span>
            <span
              >{{ row.span.seqStart }} →
              {{ row.span.seqEnd ?? row.span.seqStart }}</span
            >
            <span>{{ row.span.startTs }}</span>
          </div>

          <p v-if="getErrorMessage(row.span)" class="timeline-note error">
            {{ getErrorMessage(row.span) }}
          </p>
        </article>
      </div>
    </div>
  </details>
</template>

<style scoped>
/* 柔和扁平风：无渐变无阴影，淡描边表达层级 */
.span-timeline-card {
  margin-top: 10px;
  border: 1px solid #e6e9f2;
  border-radius: 14px;
  background: #fafbff;
  overflow: clip;
  transition: border-color 0.2s ease;
}

.span-timeline-summary {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  list-style: none;
}

.span-timeline-summary::-webkit-details-marker {
  display: none;
}

.summary-leading {
  display: grid;
  gap: 4px;
}

.trace-kicker {
  margin: 0;
  color: #5b63ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.summary-leading strong {
  color: #111827;
  font-size: 14px;
  font-weight: 600;
}

.trace-run-id {
  color: #94a3b8;
  font-size: 12px;
}

.summary-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.summary-metrics :deep(.el-tag) {
  border: 1px solid #eef0ff;
  background: #eef0ff;
  color: #0e7490;
  border-radius: 999px;
  font-weight: 500;
}

.summary-chevron {
  color: #94a3b8;
  font-size: 12px;
  transition: transform 0.2s ease;
}

.span-timeline-card[open] .summary-chevron {
  transform: rotate(180deg);
}

.timeline-body {
  display: grid;
  gap: 12px;
  padding: 0 16px 16px;
}

.timeline-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding-inline-start: calc(var(--span-depth, 0) * 14px);
}

.timeline-rail {
  display: flex;
  justify-content: center;
  padding-top: 12px;
}

.timeline-dot {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: #cbd5e1;
  box-shadow: 0 0 0 3px #f1f5f9;
}

.timeline-dot.run {
  background: #5b63ff;
  box-shadow: 0 0 0 3px #eef0ff;
}

.timeline-dot.step {
  background: #0891b2;
  box-shadow: 0 0 0 3px #cffafe;
}

.timeline-dot.tool {
  background: #06b6d4;
  box-shadow: 0 0 0 3px #ede9fe;
}

.timeline-dot.text {
  background: #d97706;
  box-shadow: 0 0 0 3px #fef3c7;
}

.timeline-dot.checkpoint {
  background: #64748b;
  box-shadow: 0 0 0 3px #f1f5f9;
}

.timeline-dot.active {
  animation: pulse 1.8s ease-in-out infinite;
}

.timeline-card {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #e6e9f2;
  background: #ffffff;
  cursor: pointer;
  transition: all 0.2s ease;
}

.timeline-card:hover {
  border-color: #dde2ee;
  background: #fafbff;
}

.timeline-card.active {
  border-color: #dde2ee;
  background: #f6f8fc;
}

.timeline-card.highlighted {
  border-color: #5b63ff;
  background: #fafbff;
}

.timeline-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.timeline-kind {
  margin: 0 0 4px;
  color: #5b63ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.timeline-head strong {
  color: #111827;
  font-size: 13px;
  font-weight: 600;
}

.timeline-head :deep(.el-tag) {
  border-radius: 999px;
  font-weight: 500;
  border: 1px solid #e6e9f2;
  background: #ffffff;
  color: #4b5563;
}

.timeline-head :deep(.el-tag--primary) {
  border-color: #eef0ff;
  background: #eef0ff;
  color: #0e7490;
}

.timeline-head :deep(.el-tag--success) {
  border-color: #d1fae5;
  background: #ecfdf5;
  color: #047857;
}

.timeline-head :deep(.el-tag--danger) {
  border-color: #fee2e2;
  background: #fef2f2;
  color: #b91c1c;
}

.timeline-head :deep(.el-tag--info) {
  border-color: #e0e7ff;
  background: #eef2ff;
  color: #0e7490;
}

.timeline-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: #94a3b8;
  font-size: 12px;
}

.timeline-note {
  margin: 0;
  color: #6b7280;
  font-size: 12px;
  line-height: 1.7;
}

.timeline-note.error {
  color: #b91c1c;
}

@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px #eef0ff;
  }
  50% {
    box-shadow: 0 0 0 7px rgba(238, 240, 255, 0.55);
  }
}

@media (max-width: 640px) {
  .span-timeline-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-metrics {
    justify-content: flex-start;
  }
}

.span-timeline-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: var(--app-shadow-sm);
}

.span-timeline-summary {
  padding: 14px 16px;
}

.trace-kicker {
  color: var(--app-primary);
}

.summary-leading strong {
  color: var(--app-text);
}

.trace-run-id,
.timeline-meta,
.timeline-note {
  color: var(--app-muted-strong);
}

.summary-metrics :deep(.el-tag) {
  border: 1px solid rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
  box-shadow: var(--app-shadow-sm);
}

.timeline-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.84);
  box-shadow: var(--app-shadow-sm);
}

.timeline-card:hover,
.timeline-card.active,
.timeline-card.highlighted {
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(255, 255, 255, 0.96);
}

.timeline-kind {
  color: var(--app-primary);
}

.timeline-head strong {
  color: var(--app-text);
}

.timeline-head :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.82);
  color: var(--app-muted-strong);
}

.timeline-head :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.timeline-head :deep(.el-tag--success) {
  border-color: rgba(34, 197, 94, 0.16);
  background: rgba(236, 253, 245, 0.82);
  color: #047857;
}

.timeline-head :deep(.el-tag--danger) {
  border-color: rgba(248, 113, 113, 0.16);
  background: rgba(254, 242, 242, 0.82);
  color: #b91c1c;
}

.timeline-head :deep(.el-tag--info) {
  border-color: rgba(6, 182, 212, 0.12);
  background: rgba(239, 246, 255, 0.82);
  color: var(--app-primary-strong);
}
</style>
