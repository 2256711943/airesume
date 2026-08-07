<script setup lang="ts">
import { computed } from "vue";
import type { ChatMessageTrace, ChatTraceToolSpan } from "../../utils/resume";

const props = defineProps<{
  trace?: ChatMessageTrace | null;
}>();

const confidencePercent = computed(
  () => `${Math.round((props.trace?.routeDecision.confidence ?? 0) * 100)}%`,
);
const toolCallCount = computed(() => props.trace?.toolSpans.length ?? 0);
const normalizedToolSpans = computed(() => props.trace?.toolSpans ?? []);
const totalLatencyMs = computed(() => {
  const total = normalizedToolSpans.value.reduce(
    (sum, item) => sum + (item.latencyMs ?? 0),
    0,
  );
  return total > 0 ? total : null;
});
const matchedKeywords = computed(() => {
  const keywords =
    props.trace?.routeDecision.matchedRules.flatMap(
      (rule) => rule.matchedKeywords,
    ) ?? [];
  return Array.from(new Set(keywords)).filter(
    (keyword) => keyword.trim().length > 0,
  );
});
const agentLabel = computed(
  () => props.trace?.routeDecision.selectedAgent || "路由中",
);

const toolStatusLabel = (toolSpan: ChatTraceToolSpan) => {
  if (toolSpan.status === "pending" || toolSpan.status === "running") {
    return "进行中";
  }

  if (toolSpan.status === "failed") {
    return "失败";
  }

  if (toolSpan.status === "canceled") {
    return "已取消";
  }

  return "成功";
};

const toolStatusTagType = (toolSpan: ChatTraceToolSpan) => {
  if (toolSpan.status === "failed") return "danger";
  if (toolSpan.status === "canceled") return "info";
  if (toolSpan.status === "pending" || toolSpan.status === "running")
    return "primary";
  return "success";
};
</script>

<template>
  <details v-if="trace" class="agent-trace-card">
    <summary class="agent-trace-summary">
      <div class="summary-leading">
        <p class="trace-kicker">执行轨迹</p>
        <strong>{{ agentLabel }}</strong>
        <span class="trace-run-id">
          {{ trace.agentRunId }}
        </span>
      </div>

      <div class="summary-metrics">
        <el-tag type="primary" size="small">
          {{ confidencePercent }} 置信度
        </el-tag>
        <el-tag type="primary" size="small">
          {{ toolCallCount }} 个工具
        </el-tag>
        <el-tag type="primary" size="small">
          {{ totalLatencyMs !== null ? `${totalLatencyMs}ms` : "无耗时" }}
        </el-tag>
      </div>

      <span class="summary-chevron" aria-hidden="true"> ▾ </span>
    </summary>

    <div class="trace-body">
      <div class="trace-row">
        <div class="trace-step-index">1</div>
        <div class="trace-step-content">
          <p class="trace-step-title">路由判断</p>
          <p class="trace-step-text">
            {{ trace.routeDecision.reason }}
          </p>
          <div class="trace-chip-list">
            <el-tag type="primary" size="small">
              intent: {{ trace.routeDecision.intent }}
            </el-tag>
            <el-tag
              v-if="trace.routeDecision.fallbackUsed"
              type="warning"
              size="small"
            >
              fallback
            </el-tag>
          </div>
        </div>
      </div>

      <div class="trace-row">
        <div class="trace-step-index">2</div>
        <div class="trace-step-content">
          <p class="trace-step-title">命中规则</p>
          <p v-if="matchedKeywords.length > 0" class="trace-step-text">
            命中关键词：{{ matchedKeywords.join("、") }}
          </p>
          <p v-else class="trace-step-text">
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
                <el-tag
                  v-for="keyword in rule.matchedKeywords"
                  :key="`${rule.ruleId}-${keyword}`"
                  type="primary"
                  size="small"
                >
                  {{ keyword }}
                </el-tag>
              </div>
            </article>
          </div>
        </div>
      </div>

      <div class="trace-row">
        <div class="trace-step-index">3</div>
        <div class="trace-step-content">
          <p class="trace-step-title">工具调用</p>
          <template v-if="normalizedToolSpans.length > 0">
            <article
              v-for="toolSpan in normalizedToolSpans"
              :key="toolSpan.spanId"
              class="trace-tool-card"
            >
              <div class="trace-tool-head">
                <strong>{{ toolSpan.name }}</strong>
                <el-tag :type="toolStatusTagType(toolSpan)" size="small">
                  {{ toolStatusLabel(toolSpan) }}
                </el-tag>
              </div>
              <p class="trace-step-text">
                {{
                  toolSpan.status === "pending" || toolSpan.status === "running"
                    ? `started: ${toolSpan.startTs || "unknown"}`
                    : toolSpan.latencyMs !== null &&
                        toolSpan.latencyMs !== undefined
                      ? `${toolSpan.latencyMs}ms`
                      : "无耗时数据"
                }}
              </p>
              <p v-if="toolSpan.errorMessage" class="trace-step-text">
                {{ toolSpan.errorMessage }}
              </p>
            </article>
          </template>
          <p v-else class="trace-step-text">这次回复没有调用外部工具。</p>
        </div>
      </div>
    </div>
  </details>
</template>

<style scoped>
/* 柔和扁平风：无渐变无阴影，淡描边 */
.agent-trace-card {
  margin-top: 10px;
  border: 1px solid #e6e9f2;
  border-radius: 14px;
  background: #fafbff;
  overflow: clip;
  transition: border-color 0.2s ease;
}

.agent-trace-summary {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  padding: 12px 16px;
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
  background: #5b63ff;
  color: #ffffff;
  font-size: 12px;
  font-weight: 700;
}

.trace-step-content {
  display: grid;
  gap: 8px;
}

.trace-step-title {
  margin: 0;
  color: #111827;
  font-size: 13px;
  font-weight: 600;
}

.trace-step-text {
  margin: 0;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.7;
}

.trace-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.trace-chip-list :deep(.el-tag),
.trace-tool-head :deep(.el-tag) {
  border-radius: 999px;
  font-weight: 500;
  border: 1px solid #e6e9f2;
  background: #ffffff;
  color: #4b5563;
}

.trace-chip-list :deep(.el-tag--primary),
.trace-tool-head :deep(.el-tag--primary) {
  border-color: #eef0ff;
  background: #eef0ff;
  color: #0e7490;
}

.trace-tool-head :deep(.el-tag--danger) {
  border-color: #fee2e2;
  background: #fef2f2;
  color: #b91c1c;
}

.trace-tool-head :deep(.el-tag--success) {
  border-color: #d1fae5;
  background: #ecfdf5;
  color: #047857;
}

.trace-tool-head :deep(.el-tag--info) {
  border-color: #e0e7ff;
  background: #eef2ff;
  color: #0e7490;
}

.trace-chip-list :deep(.el-tag--warning) {
  border-color: #fef3c7;
  background: #fffbeb;
  color: #b45309;
}

.trace-rule-list {
  display: grid;
  gap: 10px;
}

.trace-rule-card,
.trace-tool-card {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid #e6e9f2;
  background: #ffffff;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.trace-rule-card:hover,
.trace-tool-card:hover {
  border-color: #dde2ee;
  background: #fafbff;
}

.trace-rule-card strong,
.trace-tool-head strong {
  color: #111827;
  font-size: 13px;
  font-weight: 600;
}

.trace-rule-card p {
  margin: 0;
  color: #94a3b8;
  font-size: 12px;
}

.trace-tool-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

@media (max-width: 640px) {
  .agent-trace-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .summary-metrics {
    justify-content: flex-start;
  }
}

.agent-trace-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.8);
  box-shadow: var(--app-shadow-sm);
}

.agent-trace-summary {
  padding: 14px 16px;
}

.trace-kicker {
  color: var(--app-primary);
}

.summary-leading strong {
  color: var(--app-text);
}

.trace-run-id,
.trace-step-text,
.trace-rule-card p {
  color: var(--app-muted-strong);
}

.summary-metrics :deep(.el-tag) {
  border: 1px solid rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
  box-shadow: var(--app-shadow-sm);
}

.trace-body {
  padding-bottom: 16px;
}

.trace-row {
  grid-template-columns: 30px minmax(0, 1fr);
}

.trace-step-index {
  background: var(--app-gradient);
  box-shadow: 0 12px 24px rgba(6, 182, 212, 0.2);
}

.trace-step-title {
  color: var(--app-text);
}

.trace-chip-list :deep(.el-tag),
.trace-tool-head :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.82);
  color: var(--app-muted-strong);
}

.trace-chip-list :deep(.el-tag--primary),
.trace-tool-head :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.trace-rule-card,
.trace-tool-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: var(--app-shadow-sm);
}

.trace-rule-card:hover,
.trace-tool-card:hover {
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(255, 255, 255, 0.96);
}
</style>
