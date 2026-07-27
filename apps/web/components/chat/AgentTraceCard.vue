<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessageTrace, ChatTraceToolSpan } from '../../utils/resume';

const props = defineProps<{
  trace?: ChatMessageTrace | null;
}>();

const confidencePercent = computed(() => `${Math.round((props.trace?.routeDecision.confidence ?? 0) * 100)}%`);
const toolCallCount = computed(() => props.trace?.toolSpans.length ?? 0);
const normalizedToolSpans = computed(() => props.trace?.toolSpans ?? []);
const totalLatencyMs = computed(() => {
  const total = normalizedToolSpans.value.reduce((sum, item) => sum + (item.latencyMs ?? 0), 0);
  return total > 0 ? total : null;
});
const matchedKeywords = computed(() => {
  const keywords = props.trace?.routeDecision.matchedRules.flatMap((rule) => rule.matchedKeywords) ?? [];
  return Array.from(new Set(keywords)).filter((keyword) => keyword.trim().length > 0);
});
const agentLabel = computed(() => props.trace?.routeDecision.selectedAgent || '路由中');

const toolStatusLabel = (toolSpan: ChatTraceToolSpan) => {
  if (toolSpan.status === 'pending' || toolSpan.status === 'running') {
    return '进行中';
  }

  if (toolSpan.status === 'failed') {
    return '失败';
  }

  if (toolSpan.status === 'canceled') {
    return '已取消';
  }

  return '成功';
};

const toolStatusClass = (toolSpan: ChatTraceToolSpan) => {
  if (toolSpan.status === 'pending' || toolSpan.status === 'running') {
    return 'pending';
  }

  return toolSpan.status === 'failed' ? 'failed' : 'success';
};
</script>

<template>
  <details
    v-if="trace"
    class="agent-trace-card"
  >
    <summary class="agent-trace-summary">
      <div class="summary-leading">
        <p class="trace-kicker">
          执行轨迹
        </p>
        <strong>{{ agentLabel }}</strong>
        <span class="trace-run-id">
          {{ trace.agentRunId }}
        </span>
      </div>

      <div class="summary-metrics">
        <span class="metric-pill">
          {{ confidencePercent }} 置信度
        </span>
        <span class="metric-pill">
          {{ toolCallCount }} 个工具
        </span>
        <span class="metric-pill">
          {{ totalLatencyMs !== null ? `${totalLatencyMs}ms` : '无耗时' }}
        </span>
      </div>

      <span
        class="summary-chevron"
        aria-hidden="true"
      >
        ▾
      </span>
    </summary>

    <div class="trace-body">
      <div class="trace-row">
        <div class="trace-step-index">
          1
        </div>
        <div class="trace-step-content">
          <p class="trace-step-title">
            路由判断
          </p>
          <p class="trace-step-text">
            {{ trace.routeDecision.reason }}
          </p>
          <div class="trace-chip-list">
            <span class="trace-chip">
              intent: {{ trace.routeDecision.intent }}
            </span>
            <span
              v-if="trace.routeDecision.fallbackUsed"
              class="trace-chip warning"
            >
              fallback
            </span>
          </div>
        </div>
      </div>

      <div class="trace-row">
        <div class="trace-step-index">
          2
        </div>
        <div class="trace-step-content">
          <p class="trace-step-title">
            命中规则
          </p>
          <p
            v-if="matchedKeywords.length > 0"
            class="trace-step-text"
          >
            命中关键词：{{ matchedKeywords.join('、') }}
          </p>
          <p
            v-else
            class="trace-step-text"
          >
            当前未命中明确规则，走默认处理链路。
          </p>
          <div class="trace-rule-list">
            <article
              v-for="rule in trace.routeDecision.matchedRules"
              :key="rule.ruleId"
              class="trace-rule-card"
            >
              <strong>{{ rule.label }}</strong>
              <p>{{ rule.ruleId }}</p>
              <div class="trace-chip-list">
                <span
                  v-for="keyword in rule.matchedKeywords"
                  :key="`${rule.ruleId}-${keyword}`"
                  class="trace-chip"
                >
                  {{ keyword }}
                </span>
              </div>
            </article>
          </div>
        </div>
      </div>

      <div class="trace-row">
        <div class="trace-step-index">
          3
        </div>
        <div class="trace-step-content">
          <p class="trace-step-title">
            工具调用
          </p>
          <template v-if="normalizedToolSpans.length > 0">
            <article
              v-for="toolSpan in normalizedToolSpans"
              :key="toolSpan.spanId"
              class="trace-tool-card"
            >
              <div class="trace-tool-head">
                <strong>{{ toolSpan.name }}</strong>
                <span :class="['trace-status', toolStatusClass(toolSpan)]">
                  {{ toolStatusLabel(toolSpan) }}
                </span>
              </div>
              <p class="trace-step-text">
                {{
                  toolSpan.status === 'pending' || toolSpan.status === 'running'
                    ? `started: ${toolSpan.startTs || 'unknown'}`
                    : toolSpan.latencyMs !== null && toolSpan.latencyMs !== undefined
                      ? `${toolSpan.latencyMs}ms`
                      : '无耗时数据'
                }}
              </p>
              <p
                v-if="toolSpan.errorMessage"
                class="trace-step-text"
              >
                {{ toolSpan.errorMessage }}
              </p>
            </article>
          </template>
          <p
            v-else
            class="trace-step-text"
          >
            这次回复没有调用外部工具。
          </p>
        </div>
      </div>
    </div>
  </details>
</template>

<style scoped>
.agent-trace-card {
  margin-top: 12px;
  border: 1px solid #dce4ff;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(244, 248, 255, 0.96), rgba(255, 255, 255, 0.98));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
  overflow: clip;
}

.agent-trace-summary {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  padding: 14px 16px;
  cursor: pointer;
  list-style: none;
}

.agent-trace-summary::-webkit-details-marker {
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

.agent-trace-card[open] .summary-chevron {
  transform: rotate(180deg);
}

.trace-body {
  display: grid;
  gap: 14px;
  padding: 0 16px 16px;
}

.trace-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}

.trace-step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: linear-gradient(135deg, #355bff 0%, #4f72ff 100%);
  color: #ffffff;
  font-size: 12px;
  font-weight: 800;
}

.trace-step-content {
  display: grid;
  gap: 8px;
}

.trace-step-title {
  margin: 0;
  color: #1f2a44;
  font-size: 13px;
  font-weight: 800;
}

.trace-step-text {
  margin: 0;
  color: #56637a;
  font-size: 13px;
  line-height: 1.7;
}

.trace-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.trace-chip {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.trace-chip.warning {
  background: #fff4dd;
  color: #b86500;
}

.trace-rule-list {
  display: grid;
  gap: 10px;
}

.trace-rule-card,
.trace-tool-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid #e5ebf7;
  background: rgba(255, 255, 255, 0.92);
}

.trace-rule-card strong,
.trace-tool-head strong {
  color: #1f2a44;
  font-size: 13px;
}

.trace-rule-card p {
  margin: 0;
  color: #7c8599;
  font-size: 12px;
}

.trace-tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.trace-status {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.trace-status.success {
  background: #e8f8ef;
  color: #188a4e;
}

.trace-status.failed {
  background: #ffecec;
  color: #c24141;
}

.trace-status.pending {
  background: #eef2ff;
  color: #355bff;
}

@media (max-width: 640px) {
  .agent-trace-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-metrics {
    justify-content: flex-start;
  }
}
</style>
