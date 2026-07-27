<script setup lang="ts">
import { computed } from 'vue';

import type { Span, SpanTreeNode } from '../../composables/useSpanStore';

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
  (event: 'span-click', spanId: string): void;
  (event: 'span-hover', spanId: string): void;
  (event: 'span-leave'): void;
}>();

const kindLabels: Record<Span['kind'], string> = {
  run: '运行',
  step: '步骤',
  tool: '工具',
  text: '文本',
  checkpoint: '检查点',
};

const statusLabels: Record<Span['status'], string> = {
  pending: '等待中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
};

function flattenTree(nodes: SpanTreeNode[], depth = 0, rows: SpanTimelineRow[] = []): SpanTimelineRow[] {
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
const activeCount = computed(() => rows.value.filter((row) => row.isActive).length);
const rootLabel = computed(() => props.runId?.trim() || rows.value[0]?.span.runId || 'run');
const rootStatus = computed<Span['status']>(() => rows.value[0]?.span.status ?? 'pending');

const getErrorMessage = (span: Span): string => {
  return typeof span.meta.errorMessage === 'string' ? span.meta.errorMessage : '';
};
</script>

<template>
  <details
    v-if="rows.length > 0"
    class="span-timeline-card"
    open
  >
    <summary class="span-timeline-summary">
      <div class="summary-leading">
        <p class="trace-kicker">
          span timeline
        </p>
        <strong>{{ rootLabel }}</strong>
        <span class="trace-run-id">
          {{ statusLabels[rootStatus] }} · {{ totalCount }} spans
        </span>
      </div>

      <div class="summary-metrics">
        <span class="metric-pill">
          {{ activeCount }} active
        </span>
      </div>

      <span
        class="summary-chevron"
        aria-hidden="true"
      >
        ▾
      </span>
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
          :class="{ active: row.isActive, highlighted: row.span.spanId === highlightedSpanId }"
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
            <span class="timeline-status">
              {{ statusLabels[row.span.status] }}
            </span>
          </div>

          <div class="timeline-meta">
            <span>{{ row.span.spanId }}</span>
            <span>{{ row.span.seqStart }} → {{ row.span.seqEnd ?? row.span.seqStart }}</span>
            <span>{{ row.span.startTs }}</span>
          </div>

          <p
            v-if="getErrorMessage(row.span)"
            class="timeline-note error"
          >
            {{ getErrorMessage(row.span) }}
          </p>
        </article>
      </div>
    </div>
  </details>
</template>

<style scoped>
.span-timeline-card {
  margin-top: 12px;
  border: 1px solid #dfe7ff;
  border-radius: 20px;
  background:
    linear-gradient(180deg, rgba(242, 247, 255, 0.98), rgba(255, 255, 255, 0.98));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.82);
  overflow: clip;
}

.span-timeline-summary {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  padding: 14px 16px;
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
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.summary-leading strong {
  color: #1f2a44;
  font-size: 14px;
}

.trace-run-id {
  color: #7c8599;
  font-size: 12px;
}

.summary-metrics {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.metric-pill {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: #eef3ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.summary-chevron {
  color: #8b93a6;
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
  background: #c8d2eb;
  box-shadow: 0 0 0 4px rgba(200, 210, 235, 0.18);
}

.timeline-dot.run {
  background: #355bff;
  box-shadow: 0 0 0 4px rgba(53, 91, 255, 0.14);
}

.timeline-dot.step {
  background: #28b7ca;
  box-shadow: 0 0 0 4px rgba(40, 183, 202, 0.12);
}

.timeline-dot.tool {
  background: #8b5cf6;
  box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.12);
}

.timeline-dot.text {
  background: #f59e0b;
  box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.12);
}

.timeline-dot.checkpoint {
  background: #64748b;
}

.timeline-dot.active {
  animation: pulse 1.8s ease-in-out infinite;
}

.timeline-card {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 16px;
  border: 1px solid #e5ebf7;
  background: rgba(255, 255, 255, 0.94);
  cursor: pointer;
}

.timeline-card.active {
  border-color: #c7d4ff;
  box-shadow: 0 12px 24px rgba(53, 91, 255, 0.08);
}

.timeline-card.highlighted {
  border-color: #355bff;
  box-shadow: 0 14px 28px rgba(53, 91, 255, 0.14);
}

.timeline-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.timeline-kind {
  margin: 0 0 4px;
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.timeline-head strong {
  color: #1f2a44;
  font-size: 13px;
}

.timeline-status {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: #eef3ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.timeline-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: #7c8599;
  font-size: 12px;
}

.timeline-note {
  margin: 0;
  color: #56637a;
  font-size: 12px;
  line-height: 1.7;
}

.timeline-note.error {
  color: #c24141;
}

@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 4px rgba(53, 91, 255, 0.14);
  }
  50% {
    box-shadow: 0 0 0 8px rgba(53, 91, 255, 0.05);
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
</style>
