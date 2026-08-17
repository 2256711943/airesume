<script setup lang="ts">
/**
 * @description 展示当前 Agent run 的实时观测摘要指标。
 */
import type { SpanStoreStats } from "../../../composables/useSpanStore";

const props = defineProps<{
  /** 当前 run 的派生统计数据。 */
  stats?: SpanStoreStats | null;
}>();

/**
 * 将毫秒转换为紧凑展示文本。
 *
 * @param value 毫秒数。
 * @returns 面向 UI 的耗时文本。
 */
function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  return `${(value / 1000).toFixed(1)}s`;
}
</script>

<template>
  <section
    class="run-overview"
    aria-label="run overview"
  >
    <div class="metric-cell">
      <span>last seq</span>
      <strong>{{ props.stats?.lastSeq ?? 0 }}</strong>
    </div>

    <div class="metric-cell">
      <span>tools</span>
      <strong>
        {{ props.stats?.failedToolSpanCount ?? 0 }} /
        {{ props.stats?.toolSpanCount ?? 0 }}
      </strong>
    </div>

    <div class="metric-cell">
      <span>chunks</span>
      <strong>{{ props.stats?.assistantChunkEventCount ?? 0 }}</strong>
    </div>

    <div class="metric-cell">
      <span>duration</span>
      <strong>{{ formatDuration(props.stats?.durationMs) }}</strong>
    </div>
  </section>
</template>

<style scoped>
.run-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.metric-cell {
  display: grid;
  min-width: 0;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 12px;
  background: rgba(248, 250, 252, 0.84);
}

.metric-cell span {
  overflow: hidden;
  color: var(--app-muted-strong);
  font-size: 11px;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.metric-cell strong {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--app-text);
  font-size: 14px;
  font-weight: 700;
}

@media (max-width: 760px) {
  .run-overview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
