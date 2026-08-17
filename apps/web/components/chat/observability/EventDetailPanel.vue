<script setup lang="ts">
/**
 * @description 展示观测事件列表与选中事件 payload 详情。
 */
import { computed } from "vue";

import type { Span, SpanEvent } from "../../../composables/useSpanStore";

const props = defineProps<{
  /** 当前详情区事件列表。 */
  events: SpanEvent[];
  /** 事件类型的展示文案映射。 */
  eventTypeLabels: Record<string, string>;
  /** span 类型的展示文案映射。 */
  kindLabels: Record<Span["kind"], string>;
  /** 当前选中的事件。 */
  selectedEvent: SpanEvent | null;
  /** 当前选中的事件 ID。 */
  selectedEventId: string | null;
  /** 当前选中的 span。 */
  selectedSpan: Span | null;
}>();

const emit = defineEmits<{
  (event: "select-event", item: SpanEvent): void;
}>();

const detailTitle = computed(
  () =>
    props.selectedSpan?.name ??
    props.selectedEvent?.type ??
    "latest events",
);

/**
 * 序列化事件 payload，避免详情区域输出过长。
 *
 * @param payload 事件载荷。
 * @returns 截断后的 JSON 文本。
 */
function formatPayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}\n...` : text;
}

/**
 * 将事件选择动作交给父组件同步 span 高亮。
 *
 * @param event 事件记录。
 * @returns 无返回值。
 */
function selectEvent(event: SpanEvent): void {
  emit("select-event", event);
}
</script>

<template>
  <aside class="event-detail-panel">
    <div class="detail-head">
      <div>
        <p class="trace-kicker">
          event detail
        </p>
        <strong>{{ detailTitle }}</strong>
      </div>

      <el-tag
        v-if="props.selectedSpan"
        size="small"
      >
        {{ props.kindLabels[props.selectedSpan.kind] }}
      </el-tag>
    </div>

    <div class="event-list">
      <button
        v-for="event in props.events"
        :key="event.eventId"
        type="button"
        :class="{ selected: event.eventId === props.selectedEventId }"
        class="event-row"
        @click="selectEvent(event)"
      >
        <span>{{ event.seq }}</span>
        <strong>{{ props.eventTypeLabels[event.type] ?? event.type }}</strong>
        <em>{{ event.spanId ?? "run" }}</em>
      </button>
    </div>

    <pre
      v-if="props.selectedEvent"
      class="payload-preview"
    >{{ formatPayload(props.selectedEvent.payload) }}</pre>
  </aside>
</template>

<style scoped>
.event-detail-panel {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.72);
}

.detail-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.trace-kicker {
  margin: 0;
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.detail-head strong {
  color: var(--app-text);
  font-size: 13px;
}

.event-list {
  display: grid;
  max-height: 220px;
  overflow: auto;
  gap: 6px;
}

.event-row {
  display: grid;
  grid-template-columns: 44px minmax(86px, auto) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.82);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.event-row:hover,
.event-row.selected {
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(255, 255, 255, 0.96);
}

.event-row span,
.event-row strong,
.event-row em {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-row span,
.event-row em {
  color: var(--app-muted-strong);
  font-style: normal;
}

.payload-preview {
  max-height: 260px;
  margin: 0;
  overflow: auto;
  padding: 10px;
  border: 1px solid rgba(148, 163, 184, 0.14);
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.92);
  color: #e5e7eb;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 760px) {
  .event-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .event-row em {
    grid-column: 2;
  }
}
</style>
