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

import PrintResumeView from "../components/resume/PrintResumeView.vue";
import { useApiFetch } from "../composables/useApiFetch";
import { useAuth } from "../composables/useAuth";
import { useResumeConversation } from "../composables/useResumeConversation";
import { useResumeGeneration } from "../composables/useResumeGeneration";
import { useResumePdfExport } from "../composables/useResumePdfExport";
import type { SpanTreeNode } from "../composables/useSpanStore";
import {
  type ApiEnvelope,
  buildAllVariantsMarkdown,
  buildGenerateQuery,
  buildVariantFileStem,
  createResumeFormState,
  quickTags,
  variantLabels,
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
      children: RESUME_PRINT_STYLE_BASELINE,
    },
  ],
});

interface PrintResumeViewHandle {
  getRootElement: () => HTMLElement | null;
}

const form = reactive(createResumeFormState());
const errorMessage = ref("");
const statusMessage = ref("");
const chatComposerRef = ref<HTMLTextAreaElement | null>(null);
const printResumeViewRef = ref<PrintResumeViewHandle | null>(null);
const printResumeExportRef = ref<PrintResumeViewHandle | null>(null);
const sessionHydrated = ref(false);
const resumeSessionStoragePrefix = "aitext_resume_session";

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
  chatSpanRunId,
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
});

const persistResumeSession = (): void => {
  if (!sessionHydrated.value) {
    return;
  }

  const snapshot = buildResumeSessionSnapshot();
  const isEmptySnapshot =
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

  applyResumeFormSnapshot(form, snapshot.form);
  resumeVariants.value = snapshot.resumeVariants;
  selectedVariantIndex.value = snapshot.selectedVariantIndex;
  lastGenerateQuery.value =
    snapshot.lastGenerateQuery ||
    (snapshot.resumeVariants.length > 0 ? buildGenerateQuery(form) : "");
  conversationId.value = snapshot.conversationId;

  if (!snapshot.conversationId) {
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
  return printResumeExportRef.value?.getRootElement() ?? null;
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

const onComposerKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendChatMessage();
  }
};

onBeforeUnmount(() => {
  generation.dispose();
  conversation.dispose();
});
</script>

<template>
  <section class="resume-page">
    <header class="page-header">
      <div>
        <p class="eyebrow">Resume Assistant</p>
        <h2>简历对话工作台</h2>
        <p class="page-note">
          新开对话时，系统会先把表单直接发进消息流里。你可以填写后生成三版简历，也可以跳过直接聊天。
        </p>
      </div>

      <div class="header-pills">
        <span class="status-pill">
          {{ conversationId ? "会话已建立" : "等待对话" }}
        </span>
        <span class="status-pill soft">
          {{
            hasGeneratedVariants
              ? `已生成 ${resumeVariants.length} 个版本`
              : "尚未生成"
          }}
        </span>
      </div>
    </header>

    <p v-if="errorMessage" class="banner error-banner">
      {{ errorMessage }}
    </p>

    <p v-if="statusMessage" class="banner status-banner">
      {{ statusMessage }}
    </p>

    <section class="panel chat-panel">
      <div class="section-head">
        <div>
          <p class="section-kicker">对话窗口</p>
          <h3>围绕简历继续提问</h3>
        </div>

        <span class="section-tag">
          {{ conversationId ? "会话进行中" : "新对话" }}
        </span>
      </div>

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
          <div v-if="message.kind === 'form'" class="bubble form-bubble">
            <div class="form-message-head">
              <p class="form-message-kicker">系统表单</p>
              <h4>先告诉 UP AI 一些基础信息</h4>
              <p class="form-message-note">
                这张表单就是本轮对话的系统上下文入口。可以填写后生成简历，也可以直接跳过。
              </p>
            </div>

            <div class="form-grid">
              <label class="field">
                <span>姓名</span>
                <input
                  v-model="form.fullName"
                  type="text"
                  maxlength="80"
                  placeholder="例如：张三"
                />
              </label>

              <label class="field">
                <span>目标岗位</span>
                <input
                  v-model="form.targetRole"
                  type="text"
                  maxlength="100"
                  placeholder="例如：后端工程师"
                />
              </label>

              <label class="field full-width">
                <span>背景简介</span>
                <textarea
                  v-model="form.background"
                  rows="3"
                  maxlength="500"
                  placeholder="例如：3 年后端开发经验，做过高并发服务和接口优化。"
                />
              </label>

              <label class="field full-width">
                <span>技能</span>
                <input
                  v-model="form.skillsText"
                  type="text"
                  placeholder="例如：Node.js, NestJS, PostgreSQL, Redis"
                />
              </label>

              <label class="field full-width">
                <span>岗位要求</span>
                <input
                  v-model="form.targetSkillsText"
                  type="text"
                  placeholder="例如：微服务, 性能优化, 可观测性"
                />
              </label>

              <label class="field full-width">
                <span>岗位描述</span>
                <textarea
                  v-model="form.targetDescription"
                  rows="3"
                  maxlength="2000"
                  placeholder="补充岗位职责、业务场景或团队要求，便于生成更贴合的版本。"
                />
              </label>

              <label class="field full-width">
                <span>工作经历</span>
                <textarea
                  v-model="form.experienceText"
                  rows="4"
                  placeholder="每行格式：公司|岗位|亮点1;亮点2"
                />
              </label>

              <label class="field full-width">
                <span>项目经历</span>
                <textarea
                  v-model="form.projectText"
                  rows="4"
                  placeholder="每行格式：项目名|亮点1;亮点2"
                />
              </label>

              <label class="field">
                <span>语气</span>
                <select v-model="form.tone">
                  <option value="professional">professional</option>
                  <option value="concise">concise</option>
                </select>
              </label>

              <label class="field">
                <span>语言</span>
                <select v-model="form.language">
                  <option value="zh-CN">zh-CN</option>
                  <option value="en-US">en-US</option>
                </select>
              </label>
            </div>

            <div class="form-summary">
              <p class="form-summary-label">当前上下文预览</p>
              <div class="summary-chips">
                <span
                  v-for="line in formSummaryLines"
                  :key="line"
                  class="summary-chip"
                >
                  {{ line }}
                </span>
              </div>
            </div>

            <div class="action-row">
              <button
                class="primary-button"
                type="button"
                :disabled="generating || !generationReady"
                @click="generateResume"
              >
                {{ generating ? "正在生成..." : "生成三版简历" }}
              </button>

              <button
                class="secondary-button"
                type="button"
                :disabled="generating"
                @click="focusComposer"
              >
                跳过，直接对话
              </button>

              <button
                class="ghost-button"
                type="button"
                :disabled="generating || !lastGenerateQuery"
                @click="retryGenerate"
              >
                重试生成
              </button>

              <button
                class="ghost-button"
                type="button"
                :disabled="!generating"
                @click="cancelGenerate"
              >
                取消
              </button>
            </div>

            <div v-if="generating || streamProgress > 0" class="progress-box">
              <div class="progress-head">
                <span>{{ streamStageLabel }}</span>
                <strong>{{ Math.round(streamProgress) }}%</strong>
              </div>
              <div class="progress-track">
                <div
                  class="progress-bar"
                  :style="{ width: `${streamProgress}%` }"
                />
              </div>
              <p v-if="streamPreview" class="progress-preview">
                {{ streamPreview }}
              </p>
            </div>
          </div>

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
              <button
                type="button"
                class="chip-button"
                @click="copyContent(message.content)"
              >
                复制
              </button>
              <button
                type="button"
                class="chip-button"
                @click="exportContent(message.content, 'chat-message.md')"
              >
                导出
              </button>
            </div>
          </template>
        </article>

        <article v-if="hasGeneratedVariants" class="chat-message assistant">
          <div class="bubble variant-bubble">
            <div class="variant-head">
              <div>
                <p class="variant-kicker">三版预览</p>
                <h4>技术版 / 业务版 / 综合版</h4>
                <p class="variant-head-note">
                  共 {{ resumeVariants.length }} 个版本，当前展示第
                  {{ selectedVariantIndex + 1 }} 个，点击上方标签切换。
                </p>
              </div>
              <span class="section-tag"> 当前：{{ activeVariantLabel }} </span>
            </div>

            <div class="variant-tabs" role="tablist" aria-label="切换简历版本">
              <button
                v-for="(variant, index) in resumeVariants"
                :id="`variant-tab-${index}`"
                :key="variant.id"
                type="button"
                role="tab"
                class="variant-tab"
                :class="{ active: index === selectedVariantIndex }"
                :aria-selected="index === selectedVariantIndex"
                @click="selectedVariantIndex = index"
              >
                <span class="variant-tab-index">{{ index + 1 }}</span>
                <span class="variant-tab-label">
                  {{ variantLabels[index] ?? `版本 ${index + 1}` }}
                </span>
                <span
                  v-if="index === selectedVariantIndex"
                  class="variant-tab-state"
                >
                  当前
                </span>
                <span v-else class="variant-tab-state"> 查看 </span>
              </button>
            </div>

            <Transition name="variant-switch" mode="out-in">
              <div
                v-if="selectedVariant"
                :key="selectedVariantIndex"
                class="variant-switch-stage"
              >
                <div class="variant-summary">
                  <p class="variant-label">摘要</p>
                  <p class="variant-summary-text">
                    {{ selectedVariant.summary }}
                  </p>
                </div>

                <div class="variant-grid">
                  <article class="variant-block">
                    <p class="variant-label">核心技能</p>
                    <div class="tag-list">
                      <span
                        v-for="skill in selectedVariant.skills"
                        :key="skill"
                        class="tag"
                      >
                        {{ skill }}
                      </span>
                    </div>
                  </article>

                  <article class="variant-block">
                    <p class="variant-label">工作经历</p>
                    <div class="entry-list">
                      <div
                        v-for="exp in selectedVariant.experience"
                        :key="`${exp.company}-${exp.role}`"
                        class="entry-card"
                      >
                        <strong>{{ exp.company }} · {{ exp.role }}</strong>
                        <ul>
                          <li
                            v-for="highlight in exp.highlights"
                            :key="highlight"
                          >
                            {{ highlight }}
                          </li>
                        </ul>
                      </div>
                    </div>
                  </article>
                </div>

                <article class="variant-block">
                  <p class="variant-label">项目经历</p>
                  <div class="entry-list">
                    <div
                      v-for="project in selectedVariant.projects"
                      :key="project.name"
                      class="entry-card"
                    >
                      <strong>{{ project.name }}</strong>
                      <ul>
                        <li
                          v-for="highlight in project.highlights"
                          :key="highlight"
                        >
                          {{ highlight }}
                        </li>
                      </ul>
                    </div>
                  </div>
                </article>

                <div class="mini-actions">
                  <button
                    type="button"
                    class="mini-button"
                    :disabled="!selectedVariantMarkdown"
                    @click="copyContent(selectedVariantMarkdown)"
                  >
                    复制当前版本
                  </button>
                  <button
                    type="button"
                    class="mini-button"
                    :disabled="!printResumeExportOuterHtml || exportingPdf"
                    @click="exportSelectedVariantPdf"
                  >
                    {{ exportingPdf ? "导出 PDF 中..." : "导出 PDF" }}
                  </button>
                </div>

                <section
                  class="print-preview-shell"
                  :data-print-ready="Boolean(printResumeExportOuterHtml)"
                >
                  <div class="print-preview-head">
                    <div>
                      <p class="variant-label">打印视图</p>
                      <p class="print-preview-note">
                        {{
                          printResumeExportOuterHtml
                            ? "打印 DOM 已就绪，可供 PDF 导出读取。"
                            : "打印 DOM 准备中。"
                        }}
                      </p>
                    </div>

                    <span class="print-preview-state">
                      {{ printResumeExportOuterHtml ? "已就绪" : "未就绪" }}
                    </span>
                  </div>

                  <div class="print-preview-canvas">
                    <PrintResumeView
                      ref="printResumeViewRef"
                      :full-name="form.fullName"
                      :target-role="form.targetRole"
                      :variant="selectedVariant"
                    />
                  </div>

                  <div class="print-export-staging" aria-hidden="true">
                    <PrintResumeView
                      ref="printResumeExportRef"
                      :full-name="form.fullName"
                      :target-role="form.targetRole"
                      :variant="selectedVariant"
                      :show-page-footer="false"
                    />
                  </div>
                </section>
              </div>
            </Transition>
          </div>
        </article>
      </div>

      <ChatSpanTimelineCard
        v-if="hasChatSpanTimeline"
        :run-id="chatSpanRunId"
        :tree="chatSpanTree"
        :highlighted-span-id="activeTimelineSpanId"
        @span-click="handleSpanClick"
        @span-hover="handleSpanHover"
        @span-leave="handleSpanLeave"
      />

      <div class="composer">
        <label class="composer-field">
          <span>告诉 UP AI 你的需求...</span>
          <textarea
            ref="chatComposerRef"
            v-model="chatInput"
            rows="4"
            placeholder="告诉 UP AI 你的需求..."
            @keydown="onComposerKeydown"
          />
        </label>

        <div class="composer-footer">
          <div class="quick-tags">
            <button
              v-for="tag in quickTags"
              :key="tag"
              type="button"
              class="quick-button"
              @click="applyQuickPrompt(tag)"
            >
              {{ tag }}
            </button>
          </div>

          <button
            class="send-button"
            type="button"
            :disabled="sendingMessage || generating || !chatInput.trim()"
            @click="sendChatMessage"
          >
            →
          </button>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.resume-page {
  display: grid;
  gap: 20px;
  max-width: none;
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 4px 2px 0;
}

.eyebrow,
.section-kicker,
.form-message-kicker,
.variant-kicker,
.variant-label,
.form-summary-label {
  margin: 0;
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.page-header h2,
.section-head h3,
.form-message-head h4,
.variant-head h4 {
  margin: 8px 0 0;
  color: #1f2a44;
  line-height: 1.2;
}

.page-header h2 {
  font-size: 30px;
}

.section-head h3,
.form-message-head h4,
.variant-head h4 {
  font-size: 22px;
}

.page-note,
.form-message-note {
  margin: 10px 0 0;
  color: #667085;
  font-size: 14px;
  line-height: 1.8;
}

.header-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.status-pill,
.section-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid #dce4ff;
  background: #edf2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.status-pill.soft {
  border-color: #edf0f6;
  background: #f6f8fc;
  color: #667085;
}

.banner {
  margin: 0;
  padding: 14px 16px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.7;
}

.error-banner {
  border: 1px solid #ffd4d4;
  background: #fff5f5;
  color: #c24141;
}

.status-banner {
  border: 1px solid #dbe9ff;
  background: #f4f8ff;
  color: #355bff;
}

.panel {
  padding: 22px;
  border: 1px solid rgba(225, 231, 242, 0.92);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.94);
  backdrop-filter: blur(14px);
  box-shadow: 0 24px 60px rgba(31, 43, 77, 0.08);
}

.chat-panel {
  display: grid;
  gap: 18px;
  min-height: 840px;
}

.section-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.chat-window {
  display: grid;
  gap: 18px;
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
  width: min(920px, 100%);
  padding: 18px 20px;
  border-radius: 22px;
  box-shadow: 0 16px 34px rgba(31, 43, 77, 0.08);
}

.chat-message.user .bubble {
  background: linear-gradient(135deg, #355bff 0%, #5d7aff 100%);
  color: #ffffff;
}

.chat-message.assistant .bubble {
  background: #ffffff;
  border: 1px solid #edf0f6;
}

.chat-message.assistant.span-linked .bubble {
  border-color: #355bff;
  box-shadow: 0 18px 36px rgba(53, 91, 255, 0.12);
}

.chat-message.system .bubble {
  border: 1px solid #e5ecff;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.96),
    rgba(247, 250, 255, 0.98)
  );
}

.form-bubble,
.variant-bubble {
  display: grid;
  gap: 16px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: grid;
  gap: 9px;
  color: #1f2a44;
  font-size: 13px;
  font-weight: 700;
}

.field.full-width {
  grid-column: 1 / -1;
}

.field input,
.field textarea,
.field select,
.composer-field textarea {
  width: 100%;
  border: 1px solid #dfe5f1;
  border-radius: 16px;
  background: #ffffff;
  color: #1f2a44;
  font: inherit;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.field input,
.field select {
  min-height: 48px;
  padding: 0 14px;
}

.field textarea,
.composer-field textarea {
  padding: 14px;
  resize: vertical;
}

.field input:focus,
.field textarea:focus,
.field select:focus,
.composer-field textarea:focus {
  outline: none;
  border-color: #c7d4ff;
  box-shadow: 0 0 0 4px rgba(53, 91, 255, 0.08);
}

.form-summary {
  display: grid;
  gap: 10px;
}

.summary-chips,
.tag-list,
.quick-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.summary-chip,
.tag {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
}

.action-row,
.mini-actions,
.message-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.primary-button,
.secondary-button,
.ghost-button,
.mini-button,
.chip-button,
.quick-button,
.send-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 14px;
  font: inherit;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease,
    opacity 0.2s ease;
}

.primary-button {
  min-height: 46px;
  padding: 0 16px;
  background: linear-gradient(135deg, #355bff 0%, #4f72ff 100%);
  color: #ffffff;
  font-size: 14px;
  font-weight: 800;
  box-shadow: 0 14px 28px rgba(53, 91, 255, 0.2);
}

.secondary-button,
.ghost-button,
.mini-button,
.chip-button,
.quick-button {
  min-height: 44px;
  padding: 0 14px;
  border-color: #e4e8f2;
  background: #ffffff;
  color: #5f6880;
}

.ghost-button {
  background: #f8faff;
}

.primary-button:hover,
.secondary-button:hover,
.ghost-button:hover,
.mini-button:hover,
.chip-button:hover,
.quick-button:hover,
.send-button:hover {
  transform: translateY(-1px);
}

.primary-button:disabled,
.secondary-button:disabled,
.ghost-button:disabled,
.send-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  transform: none;
}

.progress-box {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 18px;
  background: #f8faff;
  border: 1px solid #ebeff8;
}

.progress-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #334155;
  font-size: 13px;
  font-weight: 700;
}

.progress-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: #e9edf7;
}

.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(135deg, #355bff 0%, #28b7ca 100%);
  transition: width 0.2s ease;
}

.progress-preview {
  margin: 0;
  color: #64748b;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

.plain-message {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.8;
}

.variant-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.variant-summary,
.variant-grid,
.variant-block,
.variant-switch-stage {
  display: grid;
  gap: 12px;
}

.variant-head-note {
  margin: 6px 0 0;
  color: #667085;
  font-size: 13px;
  line-height: 1.7;
}

.variant-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.variant-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid #e4e8f2;
  border-radius: 14px;
  background: #ffffff;
  color: #5f6880;
  font: inherit;
  cursor: pointer;
  transition:
    transform 0.2s ease,
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}

.variant-tab:hover {
  transform: translateY(-1px);
  border-color: #c7d4ff;
  color: #355bff;
}

.variant-tab.active {
  border-color: #355bff;
  background: #355bff;
  color: #ffffff;
}

.variant-tab-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 800;
}

.variant-tab.active .variant-tab-index {
  background: rgba(255, 255, 255, 0.22);
  color: #ffffff;
}

.variant-tab-label {
  font-size: 14px;
  font-weight: 700;
}

.variant-tab-state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.04em;
}

.variant-tab.active .variant-tab-state {
  background: rgba(255, 255, 255, 0.22);
  color: #ffffff;
}

.variant-tab:not(.active) .variant-tab-state {
  background: #f2f4fa;
  color: #98a1b5;
}

.variant-tab:not(.active):hover .variant-tab-state {
  background: #e6ecff;
  color: #355bff;
}

.variant-switch-stage {
  display: grid;
  gap: 16px;
}

.variant-switch-enter-active,
.variant-switch-leave-active {
  transition:
    opacity 0.24s ease,
    transform 0.24s ease;
}

.variant-switch-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.variant-switch-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}

.print-preview-shell {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid #edf0f6;
  border-radius: 18px;
  background: linear-gradient(
    180deg,
    rgba(248, 251, 255, 0.96),
    rgba(255, 255, 255, 0.98)
  );
}

.print-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.print-preview-note {
  margin: 6px 0 0;
  color: #667085;
  font-size: 13px;
  line-height: 1.7;
}

.print-preview-state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}

.print-preview-canvas {
  overflow: auto;
  padding: 12px;
  border-radius: 16px;
  border: 1px solid #edf0f6;
  background: #ffffff;
}

.print-export-staging {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}

.variant-summary-text {
  margin: 0;
  color: #334155;
  font-size: 14px;
  line-height: 1.8;
}

.entry-list {
  display: grid;
  gap: 12px;
}

.entry-card {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid #edf0f6;
  background: #fbfcff;
}

.entry-card strong {
  color: #1f2a44;
  font-size: 14px;
}

.entry-card ul {
  margin: 0;
  padding-left: 18px;
  color: #5f6880;
  font-size: 13px;
  line-height: 1.8;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: #1f2a44;
}

.markdown-body :deep(h1) {
  margin-top: 0;
  font-size: 24px;
}

.markdown-body :deep(h2) {
  margin-top: 18px;
  font-size: 18px;
}

.markdown-body :deep(h3) {
  margin-top: 14px;
  font-size: 15px;
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: #455164;
  line-height: 1.8;
}

.markdown-body :deep(ul) {
  padding-left: 20px;
}

.composer {
  display: grid;
  gap: 14px;
  padding-top: 18px;
  border-top: 1px solid #eef2fb;
}

.composer-field {
  display: grid;
  gap: 8px;
  color: #1f2a44;
  font-size: 13px;
  font-weight: 700;
}

.composer-field textarea {
  min-height: 126px;
}

.composer-footer {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.quick-button {
  min-height: 38px;
  padding: 0 12px;
  font-size: 12px;
}

.send-button {
  width: 52px;
  height: 52px;
  flex: 0 0 auto;
  border-radius: 16px;
  background: linear-gradient(135deg, #355bff 0%, #4f72ff 100%);
  color: #ffffff;
  font-size: 28px;
  font-weight: 700;
  box-shadow: 0 14px 28px rgba(53, 91, 255, 0.2);
}

@media (max-width: 1100px) {
  .page-header {
    flex-direction: column;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .composer-footer {
    flex-direction: column;
    align-items: stretch;
  }

  .print-preview-head {
    flex-direction: column;
  }

  .send-button {
    width: 100%;
  }
}

@media (max-width: 640px) {
  .panel {
    padding: 16px;
  }

  .page-header h2 {
    font-size: 24px;
  }

  .section-head h3,
  .form-message-head h4,
  .variant-head h4 {
    font-size: 20px;
  }

  .variant-head {
    flex-direction: column;
  }

  .variant-tabs {
    display: grid;
    grid-template-columns: 1fr;
  }

  .variant-tab {
    justify-content: flex-start;
  }

  .variant-tab-state {
    margin-left: auto;
  }
}
</style>
