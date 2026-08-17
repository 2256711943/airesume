<script setup lang="ts">
/**
 * @description 回放 Run 选择器：展示同一会话下可 replay 的 run 列表。
 */
import type { ObservabilityRunListItem } from '../../../composables/useReplaySpanStore';

const props = defineProps<{
  runs: readonly ObservabilityRunListItem[];
  loading: boolean;
  selectedRunId?: string | null;
}>();

const emit = defineEmits<{
  (event: 'select', runId: string): void;
  (event: 'refresh'): void;
}>();

const statusLabels: Record<string, string> = {
  pending: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};

function runLabel(run: ObservabilityRunListItem): string {
  const startedAt = run.startedAt ? new Date(run.startedAt).toLocaleString() : '-';
  return `${startedAt} · ${statusLabels[run.status] ?? run.status} · ${run.eventCount} 事件`;
}

function handleSelect(value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    emit('select', value);
  }
}
</script>

<template>
  <div
    class="replay-run-picker"
    aria-label="replay run picker"
  >
    <span class="picker-label">回放 Run</span>
    <el-select
      :model-value="props.selectedRunId ?? ''"
      :loading="props.loading"
      size="small"
      clearable
      class="picker-select"
      placeholder="选择一个历史 run"
      @change="handleSelect"
    >
      <el-option
        v-for="run in props.runs"
        :key="run.runId"
        :label="runLabel(run)"
        :value="run.runId"
      />
    </el-select>
    <el-button
      size="small"
      :loading="props.loading"
      @click="emit('refresh')"
    >
      刷新
    </el-button>
  </div>
</template>

<style scoped>
.replay-run-picker {
  display: flex;
  align-items: center;
  gap: 10px;
}

.picker-label {
  color: var(--app-muted-strong);
  font-size: 12px;
  white-space: nowrap;
}

.picker-select {
  flex: 1;
  min-width: 0;
}
</style>
