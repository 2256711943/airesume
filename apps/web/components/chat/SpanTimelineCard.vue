<script setup lang="ts">
/**
 * @description 展示 Agent 实时观测时间线，包含 run 总览、筛选、异常提示和事件详情。
 */
import { computed, ref } from "vue";

import DiagnosticStrip from "./observability/DiagnosticStrip.vue";
import EventDetailPanel from "./observability/EventDetailPanel.vue";
import ObservabilityFilterBar from "./observability/ObservabilityFilterBar.vue";
import RunOverviewBar from "./observability/RunOverviewBar.vue";
import type {
  Span,
  SpanDerivedAnomaly,
  SpanEvent,
  SpanKind,
  SpanStatus,
  SpanStoreStats,
  SpanTreeNode,
} from "../../composables/useSpanStore";
import {
  toDiagnosticItems,
  type DiagnosticItem,
} from "../../composables/useObservabilityDiagnostics";

interface SpanTimelineRow {
  depth: number;
  isActive: boolean;
  span: Span;
}

interface FilterOption<TValue extends string> {
  label: string;
  value: TValue;
}

const props = defineProps<{
  /** 当前 run 派生出的轻量异常提示（与 diagnostics 二选一，优先 diagnostics）。 */
  anomalies?: SpanDerivedAnomaly[];
  /** 统一诊断项列表（本地派生 + 后端规则引擎合并结果）。 */
  diagnostics?: DiagnosticItem[];
  /** 当前 run 的归一化事件列表。 */
  events?: SpanEvent[];
  /** 当前 runId，优先用于摘要区展示。 */
  runId?: string | null;
  /** 当前 run 的派生统计数据。 */
  stats?: SpanStoreStats | null;
  /** Span 树数据。 */
  tree: SpanTreeNode[];
  /** 外部 hover 或 click 时传入的高亮 spanId。 */
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

const severityTagType: Record<
  SpanDerivedAnomaly["severity"],
  "danger" | "warning" | "info"
> = {
  critical: "danger",
  warning: "warning",
  info: "info",
};

const kindOptions: FilterOption<"all" | SpanKind>[] = [
  { label: "全部 span", value: "all" },
  { label: "运行", value: "run" },
  { label: "步骤", value: "step" },
  { label: "工具", value: "tool" },
  { label: "文本", value: "text" },
  { label: "检查点", value: "checkpoint" },
];

const statusOptions: FilterOption<"all" | SpanStatus>[] = [
  { label: "全部状态", value: "all" },
  { label: "进行中", value: "running" },
  { label: "已完成", value: "succeeded" },
  { label: "失败", value: "failed" },
  { label: "已取消", value: "canceled" },
  { label: "等待中", value: "pending" },
];

const eventTypeLabels: Record<string, string> = {
  start: "start",
  route_decision: "route",
  "agent.step.started": "step start",
  "agent.step.finished": "step done",
  "tool.call.started": "tool start",
  "tool.call.finished": "tool done",
  assistant_chunk: "text",
  assistant_done: "text done",
  checkpoint: "checkpoint",
  done: "done",
  error: "error",
  canceled: "canceled",
};

const selectedKind = ref<"all" | SpanKind>("all");
const selectedStatus = ref<"all" | SpanStatus>("all");
const selectedEventType = ref("all");
const showOnlyIssues = ref(false);
const selectedSpanId = ref<string | null>(null);
const selectedEventId = ref<string | null>(null);

/**
 * 将 span 树压平成按执行顺序展示的行。
 *
 * @param nodes 当前层级的 span 树节点。
 * @param depth 当前递归深度。
 * @param rows 递归累积的行集合。
 * @returns 展示用的扁平行集合。
 */
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

/**
 * 读取 span 上可展示的错误信息。
 *
 * @param span 当前 span。
 * @returns 错误文本，缺失时返回空字符串。
 */
function getErrorMessage(span: Span): string {
  return typeof span.meta.errorMessage === "string"
    ? span.meta.errorMessage
    : "";
}

/**
 * 判断 span 是否应该被异常筛选命中。
 *
 * @param span 当前 span。
 * @returns span 是否存在失败状态或被诊断 evidence 引用。
 */
function hasSpanIssue(span: Span): boolean {
  if (span.status === "failed" || getErrorMessage(span)) {
    return true;
  }

  return displayDiagnostics.value.some((item) => item.spanId === span.spanId);
}

/**
 * 选中 span 并继续向外派发原有点击事件。
 *
 * @param spanId 被选中的 spanId。
 * @returns 无返回值。
 */
function selectSpan(spanId: string): void {
  selectedSpanId.value = spanId;
  selectedEventId.value = null;
  emit("span-click", spanId);
}

/**
 * 选中一条诊断提示，并跳转到其对应事件或 span。
 *
 * @param item 被选中的诊断项。
 * @returns 无返回值。
 */
function selectAnomaly(item: DiagnosticItem): void {
  selectedEventId.value = item.eventId;
  selectedSpanId.value = item.spanId;
  if (item.spanId) {
    emit("span-click", item.spanId);
  }
}

const rows = computed(() => flattenTree(props.tree));
/** 展示用的统一诊断项：优先外部传入的合并结果，否则将轻量异常归一化。 */
const displayDiagnostics = computed<DiagnosticItem[]>(
  () => props.diagnostics ?? toDiagnosticItems(props.anomalies ?? []),
);
const issueSpanIds = computed(
  () =>
    new Set(
      displayDiagnostics.value.map((item) => item.spanId).filter(Boolean),
    ),
);
const eventTypeSpanIds = computed(() => {
  if (selectedEventType.value === "all") {
    return null;
  }

  return new Set(
    (props.events ?? [])
      .filter((event) => event.type === selectedEventType.value)
      .map((event) => event.spanId)
      .filter((spanId): spanId is string => typeof spanId === "string"),
  );
});
const filteredRows = computed(() => {
  return rows.value.filter((row) => {
    if (selectedKind.value !== "all" && row.span.kind !== selectedKind.value) {
      return false;
    }

    if (
      selectedStatus.value !== "all" &&
      row.span.status !== selectedStatus.value
    ) {
      return false;
    }

    if (showOnlyIssues.value && !hasSpanIssue(row.span)) {
      return false;
    }

    if (
      eventTypeSpanIds.value &&
      !eventTypeSpanIds.value.has(row.span.spanId)
    ) {
      return false;
    }

    return true;
  });
});
const eventTypeOptions = computed<FilterOption<string>[]>(() => {
  const types = Array.from(
    new Set((props.events ?? []).map((event) => event.type)),
  );
  return [
    { label: "全部事件", value: "all" },
    ...types.map((type) => ({
      label: eventTypeLabels[type] ?? type,
      value: type,
    })),
  ];
});
const filteredEvents = computed(() => {
  return (props.events ?? []).filter((event) => {
    if (
      selectedEventType.value !== "all" &&
      event.type !== selectedEventType.value
    ) {
      return false;
    }

    if (showOnlyIssues.value) {
      return (
        event.type === "error" ||
        (event.spanId ? issueSpanIds.value.has(event.spanId) : false)
      );
    }

    return true;
  });
});
const detailEvents = computed(() => {
  const targetSpanId = selectedSpanId.value ?? props.highlightedSpanId;
  if (targetSpanId) {
    const spanEvents = filteredEvents.value.filter(
      (event) => event.spanId === targetSpanId,
    );
    if (spanEvents.length > 0) {
      return spanEvents;
    }
  }

  return filteredEvents.value.slice(-8);
});
const selectedSpan = computed<Span | null>(() => {
  const targetId = selectedSpanId.value ?? props.highlightedSpanId;
  return targetId
    ? (rows.value.find((row) => row.span.spanId === targetId)?.span ?? null)
    : null;
});
const selectedEvent = computed(() => {
  return selectedEventId.value
    ? ((props.events ?? []).find(
        (event) => event.eventId === selectedEventId.value,
      ) ?? null)
    : null;
});
const totalCount = computed(() => props.stats?.totalSpans ?? rows.value.length);
const activeCount = computed(
  () =>
    props.stats?.activeSpanCount ??
    rows.value.filter((row) => row.isActive).length,
);
const rootLabel = computed(
  () => props.runId?.trim() || rows.value[0]?.span.runId || "run",
);
const rootStatus = computed<Span["status"]>(
  () => rows.value[0]?.span.status ?? "pending",
);
const highestSeverity = computed(
  () => displayDiagnostics.value[0]?.severity ?? null,
);

/**
 * 选中事件详情，并同步高亮其所属 span。
 *
 * @param event 事件记录。
 * @returns 无返回值。
 */
function handleSelectEvent(event: SpanEvent): void {
  selectedEventId.value = event.eventId;
  selectedSpanId.value = event.spanId;
  if (event.spanId) {
    emit("span-click", event.spanId);
  }
}
</script>

<template>
  <details v-if="rows.length > 0" class="span-timeline-card" open>
    <summary class="span-timeline-summary">
      <div class="summary-leading">
        <p class="trace-kicker">observability</p>
        <strong>{{ rootLabel }}</strong>
        <span class="trace-run-id">
          {{ statusLabels[rootStatus] }} · {{ totalCount }} spans ·
          {{ props.stats?.totalEvents ?? 0 }} events
        </span>
      </div>

      <div class="summary-metrics">
        <el-tag type="primary" size="small"> {{ activeCount }} active </el-tag>
        <el-tag
          v-if="displayDiagnostics.length"
          :type="highestSeverity ? severityTagType[highestSeverity] : 'info'"
          size="small"
        >
          {{ displayDiagnostics.length }} issues
        </el-tag>
      </div>

      <span class="summary-chevron" aria-hidden="true"> ▾ </span>
    </summary>

    <div class="timeline-body">
      <RunOverviewBar :stats="props.stats" />

      <ObservabilityFilterBar
        :kind-options="kindOptions"
        :selected-kind="selectedKind"
        :status-options="statusOptions"
        :selected-status="selectedStatus"
        :event-type-options="eventTypeOptions"
        :selected-event-type="selectedEventType"
        :show-only-issues="showOnlyIssues"
        @update:selected-kind="selectedKind = $event"
        @update:selected-status="selectedStatus = $event"
        @update:selected-event-type="selectedEventType = $event"
        @update:show-only-issues="showOnlyIssues = $event"
      />

      <DiagnosticStrip
        v-if="displayDiagnostics.length"
        :items="displayDiagnostics"
        @select="selectAnomaly"
      />

      <div
        v-for="row in filteredRows"
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
            highlighted:
              row.span.spanId === highlightedSpanId ||
              row.span.spanId === selectedSpanId,
            issue: hasSpanIssue(row.span),
          }"
          role="button"
          tabindex="0"
          @click="selectSpan(row.span.spanId)"
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
            <span>
              {{ row.span.seqStart }} →
              {{ row.span.seqEnd ?? row.span.seqStart }}
            </span>
            <span>{{ row.span.startTs }}</span>
          </div>

          <p v-if="getErrorMessage(row.span)" class="timeline-note error">
            {{ getErrorMessage(row.span) }}
          </p>
        </article>
      </div>

      <section v-if="filteredRows.length === 0" class="timeline-empty">
        当前筛选无匹配 span
      </section>

      <EventDetailPanel
        :events="detailEvents"
        :event-type-labels="eventTypeLabels"
        :kind-labels="kindLabels"
        :selected-event="selectedEvent"
        :selected-event-id="selectedEventId"
        :selected-span="selectedSpan"
        @select-event="handleSelectEvent"
      />
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

.timeline-card.issue {
  border-color: rgba(248, 113, 113, 0.3);
}

.timeline-empty {
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.72);
}

.timeline-empty {
  padding: 14px;
  color: var(--app-muted-strong);
  font-size: 13px;
  text-align: center;
}
</style>
