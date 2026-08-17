<script setup lang="ts">
/**
 * @description 历史 run 回放面板：加载会话 run 列表 → 载入 replay 完整包 → 驱动回放。
 * 回放态基于独立 ReplaySpanStore，与实时观测态完全隔离。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue';

import SpanTimelineCard from '../SpanTimelineCard.vue';
import { useApiFetch } from '../../../composables/useApiFetch';
import {
  useReplayController,
  type ReplayMode,
} from '../../../composables/useReplayController';
import { useReplaySpanStore } from '../../../composables/useReplaySpanStore';
import { useObservabilityDiagnostics } from '../../../composables/useObservabilityDiagnostics';
import ReplayControlBar from './ReplayControlBar.vue';
import ReplayRunPicker from './ReplayRunPicker.vue';

const props = defineProps<{
  /** 目标会话 ID，用于拉取该会话下可 replay 的 run 列表。 */
  conversationId: string;
}>();

const replayStore = useReplaySpanStore();
const controller = useReplayController(replayStore, { apiFetch: useApiFetch });

// ---- 派生展示数据（基于回放游标处快照，随 seek 响应式更新）----
const replayTree = computed(() => replayStore.buildSpanTree());
const replayEvents = computed(() => replayStore.listFilteredEvents());
const replayStats = computed(() => replayStore.getStats());
const replayRunId = computed(() => replayStore.runId.value);
const replayDiagnosticsView = useObservabilityDiagnostics({
  localAnomalies: () => [],
  remoteIssues: () => replayStore.diagnostics.value,
  events: () => replayEvents.value,
});
const replayDiagnosticItems = replayDiagnosticsView.items;

// ---- 控制器状态透传（顶层 ref 便于模板自动解包）----
const replayMode = computed(() => controller.mode.value);
const replaySpeed = computed(() => controller.speed.value);
const replayCursorSeq = computed(() => controller.cursorSeq.value);
const replayFirstSeq = computed(() => controller.firstSeq.value);
const replayLastSeq = computed(() => controller.lastSeq.value);
const replaySelectedCheckpointId = computed(
  () => controller.selectedCheckpointId.value,
);
const replayLoadingRun = computed(() => controller.loadingRun.value);
const replayRuns = computed(() => controller.runs.value);
const replayRunsLoading = computed(() => controller.runsLoading.value);
const replayRunError = computed(() => controller.runError.value);
const replayCheckpoints = computed(() => replayStore.checkpoints.value);

const replayModeLabels: Record<ReplayMode, string> = {
  idle: '空闲',
  playing: '播放中',
  paused: '已暂停',
  completed: '已结束',
};

onMounted(() => {
  if (props.conversationId) {
    void controller.loadConversationRuns(props.conversationId);
  }
});

onBeforeUnmount(() => {
  controller.dispose();
});

function handleSelectRun(runId: string): void {
  void controller.loadRun(runId);
}

function handleRefreshRuns(): void {
  if (props.conversationId) {
    void controller.loadConversationRuns(props.conversationId);
  }
}
</script>

<template>
  <details
    class="replay-timeline-card"
    open
  >
    <summary class="replay-summary">
      <div class="summary-leading">
        <p class="trace-kicker">
          replay
        </p>
        <strong>{{ replayRunId ?? '历史回放' }}</strong>
        <span class="trace-run-id">
          按 seq 逐步复盘历史 run · 与实时观测隔离
        </span>
      </div>

      <div class="summary-metrics">
        <el-tag
          type="primary"
          size="small"
        >
          {{ replayModeLabels[replayMode] }}
        </el-tag>
        <el-tag
          type="primary"
          size="small"
        >
          {{ replayCursorSeq }} / {{ replayLastSeq ?? 0 }}
        </el-tag>
      </div>

      <span
        class="summary-chevron"
        aria-hidden="true"
      >
        ▾
      </span>
    </summary>

    <div class="replay-body">
      <ReplayRunPicker
        :runs="replayRuns"
        :loading="replayRunsLoading"
        :selected-run-id="replayRunId"
        @select="handleSelectRun"
        @refresh="handleRefreshRuns"
      />

      <ReplayControlBar
        :mode="replayMode"
        :cursor-seq="replayCursorSeq"
        :min-seq="replayFirstSeq"
        :max-seq="replayLastSeq"
        :speed="replaySpeed"
        :checkpoints="replayCheckpoints"
        :selected-checkpoint-id="replaySelectedCheckpointId"
        :disabled="replayLoadingRun"
        @play="controller.play"
        @pause="controller.pause"
        @step-backward="controller.stepBackward"
        @step-forward="controller.stepForward"
        @fast-forward="controller.fastForward"
        @seek="controller.jumpToSeq"
        @jump-checkpoint="controller.jumpToCheckpoint"
        @speed-change="controller.setSpeed"
        @reset="controller.reset"
      />

      <p
        v-if="replayRunError"
        class="replay-empty error"
      >
        {{ replayRunError }}
      </p>
      <p
        v-else-if="!replayRunId"
        class="replay-empty"
      >
        从上方选择一个历史 run 开始回放
      </p>
      <SpanTimelineCard
        v-else
        :tree="replayTree"
        :events="replayEvents"
        :run-id="replayRunId"
        :stats="replayStats"
        :diagnostics="replayDiagnosticItems"
      />
    </div>
  </details>
</template>

<style scoped>
.replay-timeline-card {
  margin-top: 10px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: var(--app-shadow-sm);
  overflow: clip;
  transition: border-color 0.2s ease;
}

.replay-summary {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
}

.replay-summary::-webkit-details-marker {
  display: none;
}

.summary-leading {
  display: grid;
  gap: 4px;
}

.trace-kicker {
  margin: 0;
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.summary-leading strong {
  color: var(--app-text);
  font-size: 14px;
  font-weight: 600;
}

.trace-run-id {
  color: var(--app-muted-strong);
  font-size: 12px;
}

.summary-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.summary-metrics :deep(.el-tag) {
  border: 1px solid rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
  border-radius: 999px;
  font-weight: 500;
  box-shadow: var(--app-shadow-sm);
}

.summary-chevron {
  color: var(--app-muted-strong);
  font-size: 12px;
  transition: transform 0.2s ease;
}

.replay-timeline-card[open] .summary-chevron {
  transform: rotate(180deg);
}

.replay-body {
  display: grid;
  gap: 12px;
  padding: 0 16px 16px;
}

.replay-empty {
  margin: 0;
  padding: 14px;
  border: 1px solid rgba(148, 163, 184, 0.16);
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.72);
  color: var(--app-muted-strong);
  font-size: 13px;
  text-align: center;
}

.replay-empty.error {
  border-color: rgba(248, 113, 113, 0.3);
  color: #b91c1c;
}

@media (max-width: 640px) {
  .replay-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-metrics {
    justify-content: flex-start;
  }
}
</style>
