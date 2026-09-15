<script setup lang="ts">
/**
 * @description 展示实时诊断提示（本地派生异常 + 后端规则引擎结果），
 * 支持按分类分组、展开全部与定位到对应事件或 span。
 */
import { computed, ref } from "vue";

import {
  DIAGNOSTIC_CATEGORY_LABELS,
  type DiagnosticGroup,
  type DiagnosticItem,
} from "../../../composables/useObservabilityDiagnostics";

const props = defineProps<{
  /** 统一诊断项列表（已合并去重排序）。 */
  items: DiagnosticItem[];
}>();

const emit = defineEmits<{
  (event: "select", item: DiagnosticItem): void;
}>();

/** 分组折叠时每组最多展示的条目数 */
const COLLAPSE_LIMIT = 2;

const expanded = ref(false);

const severityRank: Record<DiagnosticItem["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

/**
 * 按分类分组：组间按最高严重级别排序，组内按严重级别与 seq 排序。
 */
const groups = computed<DiagnosticGroup[]>(() => {
  const map = new Map<string, DiagnosticItem[]>();
  for (const item of props.items) {
    const list = map.get(item.category) ?? [];
    list.push(item);
    map.set(item.category, list);
  }

  const groupList: DiagnosticGroup[] = [];
  for (const [key, list] of map.entries()) {
    const sorted = [...list].sort(
      (left, right) =>
        severityRank[left.severity] - severityRank[right.severity] ||
        (left.seq ?? Number.MAX_SAFE_INTEGER) -
          (right.seq ?? Number.MAX_SAFE_INTEGER),
    );
    groupList.push({
      key,
      label: DIAGNOSTIC_CATEGORY_LABELS[key] ?? key,
      severity: sorted[0]?.severity ?? "warning",
      items: sorted,
    });
  }

  return groupList.sort(
    (left, right) => severityRank[left.severity] - severityRank[right.severity],
  );
});

/** 是否存在需要折叠的分组（决定是否展示"展开全部"按钮）。 */
const hasCollapsible = computed(() =>
  groups.value.some((group) => group.items.length > COLLAPSE_LIMIT),
);

/**
 * 读取分组当前展示的条目：折叠时每组仅展示前 2 条。
 *
 * @param group 诊断分组。
 * @returns 待渲染的条目列表。
 */
function visibleItems(group: DiagnosticGroup): DiagnosticItem[] {
  return expanded.value ? group.items : group.items.slice(0, COLLAPSE_LIMIT);
}

/**
 * 将诊断项交给父组件定位。
 *
 * @param item 被点击的诊断项。
 * @returns 无返回值。
 */
function selectItem(item: DiagnosticItem): void {
  emit("select", item);
}
</script>

<template>
  <section v-if="props.items.length > 0" class="diagnostic-strip">
    <div class="strip-head">
      <span class="strip-title"> 实时诊断（{{ props.items.length }}） </span>
      <button
        v-if="hasCollapsible"
        type="button"
        class="strip-toggle"
        @click="expanded = !expanded"
      >
        {{ expanded ? "收起" : "展开全部" }}
      </button>
    </div>

    <div v-for="group in groups" :key="group.key" class="diagnostic-group">
      <div class="group-head">
        <span :class="['severity-dot', group.severity]" />
        <span class="group-label">{{ group.label }}</span>
        <span class="group-count">{{ group.items.length }}</span>
      </div>

      <button
        v-for="item in visibleItems(group)"
        :key="item.id"
        type="button"
        class="diagnostic-pill"
        @click="selectItem(item)"
      >
        <strong>{{ item.title }}</strong>
        <span>{{ item.reason }}</span>
      </button>

      <p
        v-if="!expanded && group.items.length > COLLAPSE_LIMIT"
        class="group-more"
      >
        +{{ group.items.length - COLLAPSE_LIMIT }} 条
      </p>
    </div>
  </section>
</template>

<style scoped>
.diagnostic-strip {
  display: grid;
  gap: 10px;
}

.strip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.strip-title {
  color: var(--app-text);
  font-size: 12px;
  font-weight: 600;
}

.strip-toggle {
  border: none;
  background: transparent;
  color: var(--app-primary);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}

.strip-toggle:hover {
  text-decoration: underline;
}

.diagnostic-group {
  display: grid;
  gap: 6px;
}

.group-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.group-label {
  color: var(--app-muted-strong);
  font-size: 12px;
  font-weight: 600;
}

.group-count {
  min-width: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  color: var(--app-muted-strong);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

.diagnostic-pill {
  display: grid;
  grid-template-columns: minmax(88px, auto) minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid rgba(248, 113, 113, 0.18);
  border-radius: 12px;
  background: rgba(254, 242, 242, 0.72);
  color: var(--app-text);
  cursor: pointer;
  text-align: left;
}

.diagnostic-pill strong,
.diagnostic-pill span:last-child {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diagnostic-pill span:last-child {
  color: var(--app-muted-strong);
}

.group-more {
  margin: 0;
  padding-inline-start: 14px;
  color: var(--app-muted-strong);
  font-size: 11px;
}

.severity-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #64748b;
}

.severity-dot.critical {
  background: #dc2626;
}

.severity-dot.warning {
  background: #d97706;
}

.severity-dot.info {
  background: #0891b2;
}

@media (max-width: 760px) {
  .diagnostic-pill {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
