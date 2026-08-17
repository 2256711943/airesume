<script setup lang="ts">
/**
 * @description 提供 Agent 实时观测面板的 span、状态、事件类型与异常筛选控件。
 */
import type { SpanKind, SpanStatus } from "../../../composables/useSpanStore";

interface FilterOption<TValue extends string> {
  label: string;
  value: TValue;
}

const props = defineProps<{
  /** 可选 span 类型集合。 */
  kindOptions: FilterOption<"all" | SpanKind>[];
  /** 当前选中的 span 类型。 */
  selectedKind: "all" | SpanKind;
  /** 可选 span 状态集合。 */
  statusOptions: FilterOption<"all" | SpanStatus>[];
  /** 当前选中的 span 状态。 */
  selectedStatus: "all" | SpanStatus;
  /** 可选事件类型集合。 */
  eventTypeOptions: FilterOption<string>[];
  /** 当前选中的事件类型。 */
  selectedEventType: string;
  /** 是否只展示异常相关内容。 */
  showOnlyIssues: boolean;
}>();

const emit = defineEmits<{
  (event: "update:selected-kind", value: "all" | SpanKind): void;
  (event: "update:selected-status", value: "all" | SpanStatus): void;
  (event: "update:selected-event-type", value: string): void;
  (event: "update:show-only-issues", value: boolean): void;
}>();

/**
 * 更新 span 类型筛选值。
 *
 * @param value 新 span 类型。
 * @returns 无返回值。
 */
function updateSelectedKind(value: "all" | SpanKind): void {
  emit("update:selected-kind", value);
}

/**
 * 更新 span 状态筛选值。
 *
 * @param value 新 span 状态。
 * @returns 无返回值。
 */
function updateSelectedStatus(value: "all" | SpanStatus): void {
  emit("update:selected-status", value);
}

/**
 * 更新事件类型筛选值。
 *
 * @param value 新事件类型。
 * @returns 无返回值。
 */
function updateSelectedEventType(value: string): void {
  emit("update:selected-event-type", value);
}

/**
 * 更新异常筛选开关。
 *
 * @param value 是否只看异常。
 * @returns 无返回值。
 */
function updateShowOnlyIssues(value: boolean): void {
  emit("update:show-only-issues", value);
}
</script>

<template>
  <section
    class="timeline-filters"
    aria-label="timeline filters"
  >
    <el-select
      :model-value="props.selectedKind"
      size="small"
      class="filter-select"
      @update:model-value="updateSelectedKind"
    >
      <el-option
        v-for="option in props.kindOptions"
        :key="option.value"
        :label="option.label"
        :value="option.value"
      />
    </el-select>

    <el-select
      :model-value="props.selectedStatus"
      size="small"
      class="filter-select"
      @update:model-value="updateSelectedStatus"
    >
      <el-option
        v-for="option in props.statusOptions"
        :key="option.value"
        :label="option.label"
        :value="option.value"
      />
    </el-select>

    <el-select
      :model-value="props.selectedEventType"
      size="small"
      class="filter-select wide"
      @update:model-value="updateSelectedEventType"
    >
      <el-option
        v-for="option in props.eventTypeOptions"
        :key="option.value"
        :label="option.label"
        :value="option.value"
      />
    </el-select>

    <el-switch
      :model-value="props.showOnlyIssues"
      size="small"
      active-text="异常"
      inactive-text="全部"
      @update:model-value="updateShowOnlyIssues"
    />
  </section>
</template>

<style scoped>
.timeline-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.filter-select {
  width: 132px;
}

.filter-select.wide {
  width: 168px;
}

@media (max-width: 760px) {
  .filter-select,
  .filter-select.wide {
    width: min(100%, 180px);
  }
}
</style>
