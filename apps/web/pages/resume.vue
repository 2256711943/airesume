<script setup lang="ts">
/**
 * @description 简历对话工作台页面，负责表单、对话、版本预览，以及 Markdown/PDF 导出编排。
 */
import MarkdownIt from "markdown-it";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";

import ResumeFormBubble from "../components/resume/ResumeFormBubble.vue";
import ResumePdfPreviewPane from "../components/resume/ResumePdfPreviewPane.vue";
import ResumeVariantPreview from "../components/resume/ResumeVariantPreview.vue";
import ReplayTimelineCard from "../components/chat/observability/ReplayTimelineCard.vue";
import { useApiFetch } from "../composables/useApiFetch";
import { useAuth } from "../composables/useAuth";
import { useResumeConversation } from "../composables/useResumeConversation";
import { useResumeGeneration } from "../composables/useResumeGeneration";
import { useResumePdfExport } from "../composables/useResumePdfExport";
import { useResumeWorkspaceLayout } from "../composables/useResumeWorkspaceLayout";
import type { SpanTreeNode } from "../composables/useSpanStore";
import {
  type ApiEnvelope,
  buildAllVariantsMarkdown,
  buildGenerateQuery,
  buildVariantFileStem,
  createResumeFormState,
  quickTags,
} from "../utils/resume";
import { RESUME_PRINT_STYLE_BASELINE } from "../utils/resume-print-style";
import {
  clearResumeSessionConversationId,
  applyResumeFormSnapshot,
  findLatestSystemContextMessage,
  readResumeSessionSnapshot,
  toResumeChatMessages,
  type ConversationResumeSessionDto,
  type ResumeSessionStorageSnapshot,
  writeResumeSessionSnapshot,
} from "../utils/resume-session";
import { useHead } from "#imports";

const { token, clearAuth, initAuth, user } = useAuth();
const markdown = new MarkdownIt({
  breaks: true,
  linkify: true,
  html: false,
});

await initAuth();

useHead({
  style: [
    {
      id: "resume-print-style-baseline",
      innerHTML: RESUME_PRINT_STYLE_BASELINE,
    },
  ],
});

interface ResumeVariantPreviewHandle {
  getExportRootElement: () => HTMLElement | null;
}

const form = reactive(createResumeFormState());
const errorMessage = ref("");
const statusMessage = ref("");
const chatComposerRef = ref<HTMLTextAreaElement | null>(null);
const resumeVariantPreviewRef = ref<ResumeVariantPreviewHandle | null>(null);
const sessionHydrated = ref(false);
const formDismissed = ref(false);
const resumeSessionStoragePrefix = "aitext_resume_session";

const { formFocusActive, enterFormFocus, exitFormFocus } =
  useResumeWorkspaceLayout();

let getVariantSnapshot = () => buildAllVariantsMarkdown([]);

const conversation = useResumeConversation({
  form,
  token,
  clearAuth,
  errorMessage,
  statusMessage,
  getVariantSnapshot: () => getVariantSnapshot(),
});

const generation = useResumeGeneration({
  form,
  token,
  clearAuth,
  errorMessage,
  statusMessage,
  syncSystemContext: conversation.syncSystemContext,
  seedGeneratedConversation: conversation.seedGeneratedConversation,
});

const { exportingPdf, exportResumePdf } = useResumePdfExport({
  token,
  clearAuth,
});

getVariantSnapshot = () =>
  buildAllVariantsMarkdown(generation.resumeVariants.value);

const {
  applyQuickPrompt: applyQuickPromptBase,
  activeAssistantMessageId,
  chatInput,
  chatMessages,
  chatSpanAnomalies,
  chatSpanDiagnosticItems,
  chatSpanEvents,
  chatSpanRunId,
  chatSpanStats,
  chatSpanTree,
  hasChatSpanTimeline,
  conversationId,
  formSummaryLines,
  lastSyncedSystemContext,
  sendChatMessage,
  sendingMessage,
} = conversation;

const {
  activeVariantLabel,
  cancelGenerate,
  generateResume,
  generating,
  generationReady,
  hasGeneratedVariants,
  lastGenerateQuery,
  resumeVariants,
  retryGenerate,
  selectedVariant,
  selectedVariantFileName,
  selectedVariantIndex,
  selectedVariantMarkdown,
  streamPreview,
  streamProgress,
  streamStageLabel,
} = generation;

const resumeSessionStorageKey = computed(() => {
  return `${resumeSessionStoragePrefix}:${user.value?.id ?? "anonymous"}`;
});

const buildResumeSessionSnapshot = (): ResumeSessionStorageSnapshot => ({
  conversationId: conversationId.value,
  form: {
    ...form,
  },
  resumeVariants: resumeVariants.value,
  selectedVariantIndex: selectedVariantIndex.value,
  lastGenerateQuery: lastGenerateQuery.value,
  formDismissed: formDismissed.value,
});

const persistResumeSession = (): void => {
  if (!sessionHydrated.value) {
    return;
  }

  const snapshot = buildResumeSessionSnapshot();
  const isEmptySnapshot =
    !snapshot.formDismissed &&
    !snapshot.conversationId &&
    !snapshot.form.fullName &&
    !snapshot.form.background &&
    !snapshot.form.targetRole &&
    !snapshot.form.targetDescription &&
    !snapshot.form.skillsText &&
    !snapshot.form.targetSkillsText &&
    !snapshot.form.experienceText &&
    !snapshot.form.projectText &&
    snapshot.resumeVariants.length === 0 &&
    !snapshot.lastGenerateQuery;

  writeResumeSessionSnapshot(
    typeof localStorage === "undefined" ? undefined : localStorage,
    resumeSessionStorageKey.value,
    isEmptySnapshot ? null : snapshot,
  );
};

const restoreResumeSession = async (): Promise<void> => {
  const storage =
    typeof localStorage === "undefined" ? undefined : localStorage;
  const snapshot = readResumeSessionSnapshot(
    storage,
    resumeSessionStorageKey.value,
  );
  if (!snapshot) {
    sessionHydrated.value = true;
    return;
  }

  formDismissed.value = snapshot.formDismissed;

  applyResumeFormSnapshot(form, snapshot.form);
  resumeVariants.value = snapshot.resumeVariants;
  selectedVariantIndex.value = snapshot.selectedVariantIndex;
  lastGenerateQuery.value =
    snapshot.lastGenerateQuery ||
    (snapshot.resumeVariants.length > 0 ? buildGenerateQuery(form) : "");
  conversationId.value = snapshot.conversationId;

  if (!snapshot.conversationId) {
    if (formDismissed.value) {
      chatMessages.value = chatMessages.value.filter(
        (message) => message.kind !== "form",
      );
    }
    sessionHydrated.value = true;
    return;
  }

  try {
    const response = await useApiFetch<
      ApiEnvelope<ConversationResumeSessionDto>
    >(`/conversations/${snapshot.conversationId}/resume-session?limit=50`);

    if (!response.success || !response.data) {
      throw new Error(response.error?.message || "恢复会话失败");
    }

    conversationId.value = response.data.conversationId;
    chatMessages.value = toResumeChatMessages(response.data.messages);
    if (formDismissed.value) {
      chatMessages.value = chatMessages.value.filter(
        (message) => message.kind !== "form",
      );
    }
    lastSyncedSystemContext.value = findLatestSystemContextMessage(
      response.data.messages,
    );
    errorMessage.value = "";
    statusMessage.value = response.data.latestContextPack
      ? `已恢复会话，${response.data.messages.length} 条消息，${response.data.resumeContext.selectedCount} 项简历上下文，最新上下文包 ${response.data.latestContextPack.packId}`
      : `已恢复会话，${response.data.messages.length} 条消息，${response.data.resumeContext.selectedCount} 项简历上下文`;
  } catch (error) {
    conversationId.value = "";
    lastSyncedSystemContext.value = "";
    writeResumeSessionSnapshot(
      storage,
      resumeSessionStorageKey.value,
      clearResumeSessionConversationId(buildResumeSessionSnapshot()),
    );
    errorMessage.value =
      error instanceof Error ? error.message : "会话恢复失败";
  } finally {
    sessionHydrated.value = true;
  }
};

const selectedTimelineSpanId = ref<string | null>(null);
const hoveredTimelineSpanId = ref<string | null>(null);
const activeTimelineSpanId = computed(
  () => hoveredTimelineSpanId.value ?? selectedTimelineSpanId.value,
);

const clearTimelineSelection = () => {
  selectedTimelineSpanId.value = null;
  hoveredTimelineSpanId.value = null;
};

const findSpanNode = (
  spanId: string | null | undefined,
  nodes: SpanTreeNode[] = chatSpanTree.value,
): SpanTreeNode | null => {
  if (!spanId) {
    return null;
  }

  for (const node of nodes) {
    if (node.span.spanId === spanId) {
      return node;
    }

    const childMatch = findSpanNode(spanId, node.children);
    if (childMatch) {
      return childMatch;
    }
  }

  return null;
};

const findAssistantMessageIdBySpanId = (
  spanId: string | null | undefined,
): string | null => {
  if (!spanId) {
    return null;
  }

  for (let index = chatMessages.value.length - 1; index >= 0; index -= 1) {
    const message = chatMessages.value[index];
    if (message?.role !== "assistant") {
      continue;
    }

    if (message.trace?.mainSpanId === spanId) {
      return message.id;
    }
  }

  return null;
};

const collectTextSpanIds = (nodes: SpanTreeNode[]): string[] => {
  const textSpanIds: string[] = [];

  for (const node of nodes) {
    if (node.span.kind === "text") {
      textSpanIds.push(node.span.spanId);
    }

    if (node.children.length > 0) {
      textSpanIds.push(...collectTextSpanIds(node.children));
    }
  }

  return textSpanIds;
};

const resolveTimelineMessageId = (
  spanId: string | null | undefined,
): string => {
  const directMatch = findAssistantMessageIdBySpanId(spanId);
  if (directMatch) {
    return directMatch;
  }

  const node = findSpanNode(spanId);
  if (node) {
    for (const textSpanId of collectTextSpanIds([node])) {
      const descendantMatch = findAssistantMessageIdBySpanId(textSpanId);
      if (descendantMatch) {
        return descendantMatch;
      }
    }
  }

  return activeAssistantMessageId.value;
};

const activeTimelineMessageId = computed(() =>
  resolveTimelineMessageId(activeTimelineSpanId.value),
);
const printResumeExportRootElement = computed(() => {
  return resumeVariantPreviewRef.value?.getExportRootElement() ?? null;
});
const printResumeExportOuterHtml = computed(() => {
  return printResumeExportRootElement.value?.outerHTML ?? "";
});
const selectedVariantPdfFileStem = computed(() => {
  return buildVariantFileStem(form.targetRole, selectedVariantIndex.value);
});

watch(buildResumeSessionSnapshot, persistResumeSession, { deep: true });

watch(
  hasChatSpanTimeline,
  (hasTimeline) => {
    if (!hasTimeline) {
      clearTimelineSelection();
    }
  },
  { immediate: true },
);

onMounted(() => {
  void restoreResumeSession();
});

const renderMarkdown = (content: string): string =>
  markdown.render(content || "");

const focusComposer = async () => {
  await nextTick();
  chatComposerRef.value?.focus();
};

const applyQuickPrompt = async (prompt: string) => {
  await applyQuickPromptBase(prompt);
  await focusComposer();
};

/**
 * 跳过系统表单，直接从对话开始：移除表单气泡并记录跳过状态，刷新后不再出现。
 */
const handleSkipForm = async () => {
  formDismissed.value = true;
  chatMessages.value = chatMessages.value.filter(
    (message) => message.kind !== "form",
  );
  exitFormFocus();
  await focusComposer();
};

/**
 * 点击表单空白区域进入"聚焦预览"模式：
 * 侧边栏收缩为纯图标，工作台展开为「编辑表单 + 实时预览」左右分栏。
 * 输入框、按钮等交互元素上的点击不触发，避免干扰正常编辑。
 */
const FOCUS_TRIGGER_BLOCK_SELECTOR =
  "input, textarea, select, button, .el-select, .el-input, .el-textarea, .el-tag";

const handleFormBubbleClick = (event: MouseEvent) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  if (target.closest(FOCUS_TRIGGER_BLOCK_SELECTOR)) {
    return;
  }
  enterFormFocus();
};

const copyContent = async (content: string) => {
  await navigator.clipboard.writeText(content);
  statusMessage.value = "内容已复制到剪贴板。";
};

const scrollToTimelineMessage = async (spanId: string | null | undefined) => {
  const messageId = resolveTimelineMessageId(spanId);
  if (!messageId) {
    return;
  }

  await nextTick();

  const target = document.getElementById(messageId);

  target?.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
};

const handleSpanClick = async (spanId: string) => {
  selectedTimelineSpanId.value = spanId;
  await scrollToTimelineMessage(spanId);
};

const handleSpanHover = (spanId: string) => {
  hoveredTimelineSpanId.value = spanId;
};

const handleSpanLeave = () => {
  hoveredTimelineSpanId.value = null;
};

const exportContent = (content: string, fileName: string) => {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  statusMessage.value = "已导出 Markdown 文件。";
};

/**
 * @returns 触发当前选中简历版本的 PDF 导出。
 */
const exportSelectedVariantPdf = async (): Promise<void> => {
  if (!selectedVariant.value || !printResumeExportOuterHtml.value) {
    errorMessage.value = "打印视图尚未准备完成，请稍后重试。";
    statusMessage.value = "";
    return;
  }

  errorMessage.value = "";
  statusMessage.value = "正在导出 PDF，请稍候...";

  try {
    const result = await exportResumePdf({
      htmlFragment: printResumeExportOuterHtml.value,
      fileName: selectedVariantPdfFileStem.value,
      documentTitle: selectedVariantPdfFileStem.value,
    });

    statusMessage.value = result.pageCount
      ? `PDF 已开始下载，共 ${result.pageCount} 页。`
      : `PDF 已开始下载，文件名为 ${result.fileName}。`;
  } catch (error) {
    errorMessage.value =
      error instanceof Error ? error.message : "PDF 导出失败，请稍后重试。";
    statusMessage.value = "";
  }
};

const onComposerKeydown = (event: Event) => {
  const keyboardEvent = event as KeyboardEvent;
  if (keyboardEvent.isComposing) {
    return;
  }

  if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
    keyboardEvent.preventDefault();
    void sendChatMessage();
  }
};

onBeforeUnmount(() => {
  generation.dispose();
  conversation.dispose();
  exitFormFocus();
});
</script>

<template>
  <section class="resume-page">
    <p v-if="errorMessage" class="banner error-banner">
      {{ errorMessage }}
    </p>

    <p v-if="statusMessage" class="banner status-banner">
      {{ statusMessage }}
    </p>

    <!-- 聚焦预览模式：编辑表单（左）+ 实时预览（右） -->
    <section v-if="formFocusActive" class="focus-workspace">
      <section class="focus-pane focus-editor">
        <header class="focus-pane-head">
          <div>
            <p class="section-kicker">编辑表单</p>
            <h3>简历信息</h3>
          </div>
          <el-button
            class="focus-exit-button"
            size="small"
            @click="exitFormFocus"
          >
            ← 退出预览
          </el-button>
        </header>

        <ResumeFormBubble
          :form="form"
          :form-summary-lines="formSummaryLines"
          :generating="generating"
          :generation-ready="generationReady"
          :stream-progress="streamProgress"
          :stream-stage-label="streamStageLabel"
          :stream-preview="streamPreview"
          :last-generate-query="lastGenerateQuery"
          @generate="generateResume"
          @retry="retryGenerate"
          @cancel="cancelGenerate"
          @skip="handleSkipForm"
        />
      </section>

      <aside class="focus-pane focus-preview">
        <ResumePdfPreviewPane
          :full-name="form.fullName"
          :target-role="form.targetRole"
          :variant="selectedVariant"
        />
      </aside>
    </section>

    <section
      v-else
      class="panel chat-panel"
      :class="{ 'has-timeline': hasChatSpanTimeline }"
    >
      <div class="chat-window">
        <article
          v-for="message in chatMessages"
          :id="message.id"
          :key="message.id"
          class="chat-message"
          :class="[
            message.role,
            {
              'span-linked':
                message.role === 'assistant' &&
                message.id === activeTimelineMessageId,
            },
          ]"
        >
          <ResumeFormBubble
            v-if="message.kind === 'form'"
            :form="form"
            :form-summary-lines="formSummaryLines"
            :generating="generating"
            :generation-ready="generationReady"
            :stream-progress="streamProgress"
            :stream-stage-label="streamStageLabel"
            :stream-preview="streamPreview"
            :last-generate-query="lastGenerateQuery"
            @generate="generateResume"
            @retry="retryGenerate"
            @cancel="cancelGenerate"
            @skip="handleSkipForm"
            @click="handleFormBubbleClick"
          />

          <p v-if="message.kind === 'form'" class="form-focus-hint">
            提示：点击表单空白区域，可进入「编辑 + 实时预览」聚焦模式
          </p>

          <template v-else>
            <div class="bubble">
              <div
                v-if="message.role === 'assistant' || message.role === 'system'"
                class="markdown-body"
                v-html="renderMarkdown(message.content)"
              />
              <p v-else class="plain-message">
                {{ message.content }}
              </p>
            </div>

            <AgentTraceCard
              v-if="
                message.role === 'assistant' &&
                message.trace &&
                (message.trace.routeDecisionStarted ||
                  message.trace.toolSpans.length > 0 ||
                  message.trace.done)
              "
              :trace="message.trace"
            />

            <div
              v-if="message.role === 'assistant' && !message.streaming"
              class="message-actions"
            >
              <el-button size="small" @click="copyContent(message.content)">
                复制
              </el-button>
              <el-button
                size="small"
                @click="exportContent(message.content, 'chat-message.md')"
              >
                导出
              </el-button>
            </div>
          </template>
        </article>

        <ResumeVariantPreview
          v-if="hasGeneratedVariants"
          ref="resumeVariantPreviewRef"
          :variants="resumeVariants"
          :selected-variant-index="selectedVariantIndex"
          :selected-variant="selectedVariant"
          :selected-variant-markdown="selectedVariantMarkdown"
          :full-name="form.fullName"
          :target-role="form.targetRole"
          :exporting-pdf="exportingPdf"
          :print-ready="Boolean(printResumeExportOuterHtml)"
          :active-variant-label="activeVariantLabel"
          @select-variant="selectedVariantIndex = $event"
          @copy="copyContent"
          @export-pdf="exportSelectedVariantPdf"
        />

        <ReplayTimelineCard
          v-if="conversationId"
          :conversation-id="conversationId"
        />
      </div>

      <ChatSpanTimelineCard
        v-if="hasChatSpanTimeline"
        :anomalies="chatSpanAnomalies"
        :diagnostics="chatSpanDiagnosticItems"
        :events="chatSpanEvents"
        :run-id="chatSpanRunId"
        :stats="chatSpanStats"
        :tree="chatSpanTree"
        :highlighted-span-id="activeTimelineSpanId"
        @span-click="handleSpanClick"
        @span-hover="handleSpanHover"
        @span-leave="handleSpanLeave"
      />

      <div class="composer">
        <div class="quick-tags">
          <el-button
            v-for="tag in quickTags"
            :key="tag"
            size="small"
            @click="applyQuickPrompt(tag)"
          >
            {{ tag }}
          </el-button>
        </div>

        <label class="composer-field">
          <el-input
            ref="chatComposerRef"
            v-model="chatInput"
            type="textarea"
            :rows="4"
            placeholder="告诉 UP AI 你的需求..."
            size="large"
            @keydown="onComposerKeydown"
          />
        </label>

        <el-button
          type="primary"
          size="large"
          class="send-button"
          :disabled="sendingMessage || generating || !chatInput.trim()"
          @click="sendChatMessage"
        >
          →
        </el-button>
      </div>
    </section>
  </section>
</template>

<style scoped>
/* 设计 token 挂在页面根容器下，作用域明确，避免与全局冲突 */
.resume-page {
  --rp-bg-page: transparent;
  --rp-bg-surface: rgba(255, 255, 255, 0.82);
  --rp-bg-surface-solid: #ffffff;
  --rp-bg-soft: #f6f8fc;
  --rp-bg-hover: #eef1f8;
  --rp-bg-user: #e8edff;
  /* 抵消布局底部留白，让输入区贴近屏幕底部，营造悬浮感 */
  margin-bottom: -18px;
  --rp-border-soft: 1px solid #e6e9f2;
  --rp-border-strong: 1px solid #dde2ee;
  --rp-text-primary: #111827;
  --rp-text-secondary: #4b5563;
  --rp-text-tertiary: #6b7280;
  --rp-text-muted: #94a3b8;
  --rp-brand: #06b6d4;
  --rp-brand-strong: #0e7490;
  --rp-brand-soft: #ecfeff;
  --rp-success: #0f766e;
  --rp-danger: #b91c1c;
  --rp-radius-sm: 10px;
  --rp-radius-md: 14px;
  --rp-radius-lg: 18px;
  --rp-radius-pill: 999px;

  display: grid;
  gap: 20px;
  max-width: none;
  color: var(--rp-text-primary);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

/* Header：克制的信息密度，参考图那种 pill 弱存在感 */
.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 2px 2px 0;
}

.header-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.header-pills :deep(.el-tag) {
  border: var(--rp-border-soft);
  border-radius: var(--rp-radius-pill);
  background: var(--rp-bg-surface-solid);
  color: var(--rp-text-secondary);
  font-weight: 500;
  box-shadow: none;
}

.header-pills :deep(.el-tag--primary) {
  border-color: var(--rp-brand-soft);
  background: var(--rp-brand-soft);
  color: var(--rp-brand-strong);
}

/* Banner：柔和扁平，不做强对比 */
.banner {
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--rp-radius-md);
  font-size: 14px;
  line-height: 1.7;
  border: var(--rp-border-soft);
}

.error-banner {
  border-color: #fee2e2;
  background: #fef2f2;
  color: var(--rp-danger);
}

.status-banner {
  border-color: #e0e7ff;
  background: #eef2ff;
  color: var(--rp-brand-strong);
}

/* Panel：核心容器——无阴影，纯白，淡描边，中等圆角 */
.panel {
  padding: 24px;
  border: var(--rp-border-soft);
  border-radius: var(--rp-radius-lg);
  background: var(--rp-bg-surface-solid);
  backdrop-filter: none;
  box-shadow: none;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.chat-panel {
  display: grid;
  gap: 20px;
  min-height: 840px;
}

/* 区块标题：更平的层级，kicker 用品牌色弱提示 */
.section-kicker {
  margin: 0;
  color: var(--rp-brand);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.section-head h3 {
  margin: 6px 0 0;
  color: var(--rp-text-primary);
  line-height: 1.25;
  font-size: 20px;
  font-weight: 700;
}

.section-head :deep(.el-tag) {
  border: var(--rp-border-soft);
  background: var(--rp-bg-soft);
  color: var(--rp-text-secondary);
  border-radius: var(--rp-radius-pill);
  font-weight: 500;
}

/* 对话流：留白充分，气泡极淡描边 */
.chat-window {
  display: grid;
  gap: 22px;
  align-content: start;
}

.chat-message {
  display: grid;
  gap: 10px;
}

.chat-message.user {
  justify-items: end;
}

.chat-message.assistant,
.chat-message.system {
  justify-items: start;
}

.bubble {
  width: 100%;
  padding: 16px 18px;
  border-radius: var(--rp-radius-lg);
  box-shadow: none;
  line-height: 1.7;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

/* 用户气泡：极淡的蓝紫底色，不做强渐变饱和色，贴近参考图 */
.chat-message.user .bubble {
  background: var(--rp-bg-user);
  color: var(--rp-brand-strong);
  border: 1px solid #d8defd;
}

.chat-message.assistant .bubble {
  background: var(--rp-bg-surface-solid);
  border: var(--rp-border-soft);
}

/* span-linked：用描边 + 更淡的背景色，不做投影 */
.chat-message.assistant.span-linked .bubble {
  border-color: var(--rp-brand);
  background: #fafbff;
  box-shadow: none;
}

.chat-message.system .bubble {
  border: var(--rp-border-soft);
  background: var(--rp-bg-soft);
}

.message-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.message-actions :deep(.el-button) {
  border: var(--rp-border-soft);
  background: var(--rp-bg-surface-solid);
  color: var(--rp-text-secondary);
  border-radius: var(--rp-radius-pill);
  transition: all 0.18s ease;
}

.message-actions :deep(.el-button:hover) {
  border-color: var(--rp-brand);
  background: var(--rp-brand-soft);
  color: var(--rp-brand-strong);
}

.plain-message {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.8;
}

/* Markdown：柔和的层级，纯文本观感 */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: var(--rp-text-primary);
  font-weight: 700;
}

.markdown-body :deep(h1) {
  margin-top: 0;
  font-size: 22px;
}

.markdown-body :deep(h2) {
  margin-top: 18px;
  font-size: 17px;
}

.markdown-body :deep(h3) {
  margin-top: 14px;
  font-size: 15px;
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: var(--rp-text-secondary);
  line-height: 1.8;
  font-size: 14px;
}

.markdown-body :deep(ul) {
  padding-left: 20px;
}

.markdown-body :deep(a) {
  color: var(--rp-brand);
  text-decoration: none;
  border-bottom: 1px solid var(--rp-brand-soft);
}

.markdown-body :deep(code) {
  background: var(--rp-bg-soft);
  border: var(--rp-border-soft);
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 13px;
  color: var(--rp-text-primary);
}

/* Composer：输入卡片贴底、快捷标签内嵌顶部（与对话首页一致） */
.composer {
  position: relative;
  padding-top: 46px;
}

.composer-field {
  display: grid;
  gap: 8px;
  color: var(--rp-text-tertiary);
  font-size: 13px;
  font-weight: 500;
}

.composer-field :deep(.el-textarea__inner) {
  border: var(--rp-border-soft);
  border-radius: var(--rp-radius-lg);
  background: var(--rp-bg-soft);
  color: var(--rp-text-primary);
  padding: 16px 58px 16px 18px;
  font-size: 14px;
  line-height: 1.7;
  transition: all 0.2s ease;
}

.composer-field :deep(.el-textarea__inner:hover) {
  border-color: #d0d5e3;
}

.composer-field :deep(.el-textarea__inner:focus) {
  border-color: var(--rp-brand);
  background: var(--rp-bg-surface-solid);
  outline: 3px solid var(--rp-brand-soft);
}

.quick-tags {
  position: absolute;
  top: 6px;
  left: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  z-index: 1;
}

.quick-tags :deep(.el-button) {
  border: var(--rp-border-soft);
  background: var(--rp-bg-surface-solid);
  color: var(--rp-text-secondary);
  border-radius: var(--rp-radius-pill);
  padding: 0 14px;
  height: 32px;
  font-size: 13px;
  transition: all 0.18s ease;
}

.quick-tags :deep(.el-button:hover) {
  border-color: var(--rp-brand);
  background: var(--rp-brand-soft);
  color: var(--rp-brand-strong);
}

.send-button {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--rp-brand);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: scale(1);
  transition: all 0.2s ease;
  z-index: 1;
}

.send-button:hover:not(:disabled) {
  background: var(--rp-brand-strong);
  transform: scale(1.08);
}

.send-button:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
  transform: scale(0.9);
}

/* 响应式：保持克制 */
@media (max-width: 1100px) {
  .resume-page {
    margin-bottom: 0;
  }

  .page-header {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .panel {
    padding: 18px;
  }

  .section-head h3 {
    font-size: 18px;
  }
}

.resume-page {
  color: var(--app-text);
}

.header-pills :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: var(--app-radius-pill);
  background: rgba(255, 255, 255, 0.74);
  color: var(--app-muted-strong);
  font-weight: 600;
  box-shadow: var(--app-shadow-sm);
}

.header-pills :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.banner {
  padding: 14px 16px;
  border-radius: 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.74);
  box-shadow: var(--app-shadow-sm);
}

.error-banner {
  border-color: rgba(248, 113, 113, 0.18);
  background: rgba(254, 242, 242, 0.84);
  color: #b91c1c;
}

.status-banner {
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(239, 246, 255, 0.84);
  color: var(--app-primary-strong);
}

.panel {
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-xl);
  background: rgba(255, 255, 255, 0.74);
  box-shadow: var(--app-shadow-md);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  animation: fade-in-up 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* 工作台对话面板：去除卡片化外观，直接铺在页面底色上（与对话首页一致） */
.chat-panel {
  display: grid;
  gap: 10px;
  min-height: 0;
  flex: 1 1 auto;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  padding: 18px 8px 8px;
  animation: none;
  /* 默认单栏：无时间线时对话窗口与系统表单占满全宽，避免收缩 */
  grid-template-columns: 1fr;
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "window"
    "composer";
}

.chat-panel.has-timeline {
  grid-template-columns: minmax(0, 1.08fr) minmax(340px, 0.92fr);
  grid-template-rows: minmax(0, 1fr) auto;
  grid-template-areas:
    "window timeline"
    "composer timeline";
}

.chat-panel > .chat-window {
  grid-area: window;
}

.chat-panel > :deep(.span-timeline-card) {
  grid-area: timeline;
  align-self: start;
}

.chat-panel > .composer {
  grid-area: composer;
}

/* 聚焦预览模式：编辑表单（左）+ 实时预览（右）左右分栏 */
.focus-workspace {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(380px, 0.92fr);
  gap: 20px;
  animation: fade-in-up 0.4s ease both;
}

.focus-pane {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 18px;
  min-height: 0;
  padding: 22px;
  border: 1px solid var(--app-border);
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: var(--app-shadow-md);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
}

/* 编辑区：表单较高时内部滚动，预览区保持充满 */
.focus-editor {
  align-content: start;
  overflow-y: auto;
}

.focus-preview {
  padding: 0;
  overflow: hidden;
}

.focus-pane-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.focus-pane-head h3 {
  margin: 6px 0 0;
  color: var(--app-text);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.focus-exit-button {
  border-radius: 999px;
}

/* 聊天流中表单气泡下方的聚焦模式提示 */
.form-focus-hint {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.section-kicker {
  color: var(--app-primary);
}

.section-head h3 {
  color: var(--app-text);
  letter-spacing: -0.03em;
}

.section-head :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.74);
  color: var(--app-muted-strong);
  border-radius: var(--app-radius-pill);
  font-weight: 600;
  box-shadow: var(--app-shadow-sm);
}

.chat-window {
  display: grid;
  gap: 22px;
  align-content: start;
  overflow-y: auto;
  min-height: 0;
}

.chat-message {
  animation: fade-in-up 0.45s ease both;
}

.bubble {
  width: 100%;
  padding: 18px 20px;
  border-radius: 24px;
  box-shadow: var(--app-shadow-sm);
  line-height: 1.7;
  transition:
    border-color 0.3s ease,
    background-color 0.3s ease,
    box-shadow 0.3s ease,
    transform 0.3s ease;
}

.chat-message.user .bubble {
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(
    135deg,
    rgba(8, 145, 178, 0.96),
    rgba(6, 182, 212, 0.94)
  );
  color: #ffffff;
  box-shadow: 0 18px 36px rgba(6, 182, 212, 0.18);
}

.chat-message.assistant .bubble {
  border: 1px solid rgba(191, 219, 254, 0.92);
  background: rgba(239, 246, 255, 0.96);
}

.chat-message.assistant.span-linked .bubble {
  border-color: rgba(6, 182, 212, 0.4);
  background: rgba(248, 250, 252, 0.98);
  box-shadow: 0 18px 32px rgba(6, 182, 212, 0.12);
}

.chat-message.system .bubble {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.84);
}

.message-actions :deep(.el-button) {
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.78);
  color: var(--app-muted-strong);
}

.message-actions :deep(.el-button:hover) {
  border-color: rgba(6, 182, 212, 0.24);
  background: rgba(219, 234, 254, 0.8);
  color: var(--app-primary-strong);
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: var(--app-text);
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: var(--app-muted-strong);
}

.markdown-body :deep(a) {
  color: var(--app-primary);
  border-bottom: 1px solid rgba(6, 182, 212, 0.22);
}

.markdown-body :deep(code) {
  background: rgba(248, 250, 252, 0.98);
  border: 1px solid rgba(148, 163, 184, 0.2);
  color: var(--app-text);
}

.composer {
  padding-top: 46px;
}

.composer-field {
  color: var(--app-muted-strong);
  font-weight: 600;
}
.composer-field :deep(.el-textarea__inner) {
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.84);
  color: var(--app-text);
  padding: 16px 58px 16px 18px;
  transition: background-color 0.3s ease;
}

.composer-field :deep(.el-textarea__inner:focus) {
  background: rgba(255, 255, 255, 0.98);
}

.quick-tags :deep(.el-button) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.78);
  color: var(--app-muted-strong);
}

.quick-tags :deep(.el-button:hover) {
  border-color: rgba(6, 182, 212, 0.24);
  background: rgba(219, 234, 254, 0.8);
  color: var(--app-primary-strong);
}

.send-button {
  box-shadow: 0 14px 28px rgba(6, 182, 212, 0.24);
}

.send-button:hover:not(:disabled) {
  transform: scale(1.08);
  box-shadow: 0 20px 38px rgba(6, 182, 212, 0.3);
}

.chat-message.user .bubble:hover,
.chat-message.assistant .bubble:hover,
.chat-message.system .bubble:hover {
  transform: translateY(-1px);
}

@media (max-width: 1100px) {
  .chat-panel {
    grid-template-columns: 1fr;
    grid-template-areas:
      "window"
      "timeline"
      "composer";
  }

  /* 窄屏下聚焦模式改为上下堆叠：编辑区在上，预览区在下 */
  .focus-workspace {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
}

@keyframes fade-in-up {
  from {
    opacity: 0;
    transform: translateY(12px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>

<style>
/* 工作台页面：主内容卡片透明化 + 极淡网格纹理（与对话首页一致） */
.workspace-main:has(.resume-page) {
  background: transparent;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.workspace-content:has(.resume-page) {
  padding: 0 8px;
  background-image:
    linear-gradient(rgba(100, 116, 139, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(100, 116, 139, 0.055) 1px, transparent 1px);
  background-size: 34px 34px;
  background-position: 0 0;
}

.workspace-content:has(.resume-page) > .resume-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  gap: 10px;
}
</style>
