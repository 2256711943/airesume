<script setup lang="ts">
/**
 * @description 回放控制条：播放/暂停、单步、快进、进度跳转、速度与 checkpoint 定位。
 */
import { computed, ref, watch } from 'vue';

import type { ReplayMode } from '../../../composables/useReplayController';
import type { SpanCheckpoint } from '../../../composables/useSpanStore';

const props = defineProps<{
  mode: ReplayMode;
  /** 当前游标 seq。 */
  cursorSeq: number;
  /** 事件序列范围（未加载 run 时为 null）。 */
  minSeq: number | null;
  maxSeq: number | null;
  /** 播放速度：每秒推进的事件数。 */
  speed: number;
  checkpoints: readonly SpanCheckpoint[];
  selectedCheckpointId?: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: 'play'): void;
  (event: 'pause'): void;
  (event: 'step-backward'): void;
  (event: 'step-forward'): void;
  (event: 'fast-forward'): void;
  (event: 'seek', seq: number): void;
  (event: 'jump-checkpoint', checkpointId: string): void;
  (event: 'speed-change', speed: number): void;
  (event: 'reset'): void;
}>();

const speedOptions = [
  { label: '0.5x', value: 0.5 },
  { label: '1x', value: 1 },
  { label: '2x', value: 2 },
  { label: '5x', value: 5 },
];

const modeLabels: Record<ReplayMode, string> = {
  idle: '空闲',
  playing: '播放中',
  paused: '已暂停',
  completed: '已结束',
};

const isPlaying = computed(() => props.mode === 'playing');
const isReady = computed(
  () => !props.disabled && props.minSeq !== null && props.maxSeq !== null,
);
const canStepBackward = computed(
  () => isReady.value && props.cursorSeq > (props.minSeq ?? 0),
);
const canStepForward = computed(
  () => isReady.value && props.cursorSeq < (props.maxSeq ?? 0),
);

// 进度滑块：拖拽期间使用本地草稿，拖拽结束再提交 seek，避免与播放定时器互相覆盖
const dragging = ref(false);
const draftSeq = ref(props.cursorSeq);
watch(
  () => props.cursorSeq,
  (value) => {
    if (!dragging.value) {
      draftSeq.value = value;
    }
  },
);

function handleSeekStart(): void {
  dragging.value = true;
}

function handleSeekEnd(): void {
  dragging.value = false;
  emit('seek', draftSeq.value);
}

function handleSpeedChange(value: unknown): void {
  emit('speed-change', Number(value));
}

function handleCheckpointChange(value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    emit('jump-checkpoint', value);
  }
}

function formatSeq(seq: number | null): string {
  return seq === null ? '-' : String(seq);
}
</script>

<template>
  <section
    class="replay-control-bar"
    aria-label="replay control"
  >
    <div class="transport-row">
      <div class="transport-buttons">
        <el-button
          size="small"
          :disabled="!isReady"
          @click="emit('reset')"
        >
          回到起点
        </el-button>
        <el-button
          size="small"
          :disabled="!canStepBackward"
          @click="emit('step-backward')"
        >
          上一步
        </el-button>
        <el-button
          v-if="!isPlaying"
          type="primary"
          size="small"
          :disabled="!isReady"
          @click="emit('play')"
        >
          播放
        </el-button>
        <el-button
          v-else
          type="primary"
          size="small"
          @click="emit('pause')"
        >
          暂停
        </el-button>
        <el-button
          size="small"
          :disabled="!canStepForward"
          @click="emit('step-forward')"
        >
          下一步
        </el-button>
        <el-button
          size="small"
          :disabled="!isReady"
          @click="emit('fast-forward')"
        >
          快进
        </el-button>
      </div>

      <span class="transport-status">
        {{ modeLabels[props.mode] }} ·
        {{ formatSeq(props.cursorSeq) }} /
        {{ formatSeq(props.maxSeq) }}
      </span>
    </div>

    <div class="seek-row">
      <el-slider
        v-model="draftSeq"
        :min="props.minSeq ?? 0"
        :max="props.maxSeq ?? 0"
        :disabled="!isReady"
        :show-tooltip="isReady"
        class="seek-slider"
        @input-start="handleSeekStart"
        @input-end="handleSeekEnd"
      />
    </div>

    <div class="option-row">
      <label class="option-item">
        <span class="option-label">速度</span>
        <el-select
          :model-value="props.speed"
          size="small"
          class="option-control"
          @change="handleSpeedChange"
        >
          <el-option
            v-for="option in speedOptions"
            :key="option.value"
            :label="option.label"
            :value="option.value"
          />
        </el-select>
      </label>

      <label class="option-item">
        <span class="option-label">检查点</span>
        <el-select
          :model-value="props.selectedCheckpointId ?? ''"
          size="small"
          clearable
          class="option-control"
          placeholder="跳转到检查点"
          @change="handleCheckpointChange"
        >
          <el-option
            v-for="checkpoint in props.checkpoints"
            :key="checkpoint.checkpointId"
            :label="`#${checkpoint.seq} ${checkpoint.label}`"
            :value="checkpoint.checkpointId"
          />
        </el-select>
      </label>
    </div>
  </section>
</template>

<style scoped>
.replay-control-bar {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.84);
}

.transport-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.transport-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.transport-status {
  color: var(--app-muted-strong);
  font-size: 12px;
  white-space: nowrap;
}

.seek-slider {
  width: 100%;
}

.option-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.option-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.option-label {
  color: var(--app-muted-strong);
  font-size: 12px;
}

.option-control {
  width: 150px;
}
</style>
