<script setup lang="ts">
/**
 * @description 对话首页：核心区域为对话界面。
 * 对话区显著位置提供「创建简历」入口，点击后直接进入简历工作台填写，
 * 填写的信息作为对话上下文，可生成三版简历。
 */
import MarkdownIt from "markdown-it";
import { computed, nextTick, onBeforeUnmount, reactive, ref } from "vue";

import { useAuth } from "../composables/useAuth";
import { useResumeConversation } from "../composables/useResumeConversation";
import {
  createResumeFormState,
  quickTags,
  type ChatMessage,
} from "../utils/resume";
import { writeResumeSessionSnapshot } from "../utils/resume-session";

const { token, clearAuth, initAuth, user, isMockAuth } = useAuth();
const markdown = new MarkdownIt({
  breaks: true,
  linkify: true,
  html: false,
});

await initAuth();

const form = reactive(createResumeFormState());
const errorMessage = ref("");
const statusMessage = ref("");
const chatComposerRef = ref<HTMLTextAreaElement | null>(null);

const conversation = useResumeConversation({
  form,
  token,
  clearAuth,
  errorMessage,
  statusMessage,
});

const {
  activeAssistantMessageId,
  applyQuickPrompt: applyQuickPromptBase,
  chatInput,
  chatMessages,
  sendChatMessage,
  sendingMessage,
} = conversation;

const hasFormData = computed(
  () =>
    !!(
      form.fullName.trim() ||
      form.targetRole.trim() ||
      form.skillsText.trim() ||
      form.background.trim()
    ),
);

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

/** 快捷标签对应的微图标（SVG path，24x24 viewBox，stroke 风格随文字颜色） */
const tagIcons: Record<string, string> = {
  简历诊断:
    "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z",
  简历翻译:
    "M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802",
  项目亮点优化:
    "M9.813 15.904L9.375 20.5l-2.5-4.6m0 0L2.25 15l4.625-2.9m0 0V7.5m3.938 8.404L11.25 20.5l1.875-4.096m0 0l3.938-1.125 1.437-3.75-3.438-1.688M9.813 8.3l.375-2.05.625-2.05m1.812 3.75l1.875 1.688 1.625.5m-1.625-3.5l1.25-1.938m3.5 5.938l2.25.625m-4.75 2.125l.625 2.25",
  职业规划:
    "M12 21a9 9 0 100-18 9 9 0 000 18zm0-5.25a3.75 3.75 0 100-7.5 3.75 3.75 0 000 7.5zm0-2.25a1.5 1.5 0 100-3 1.5 1.5 0 000 3z",
};

const onComposerKeydown = (event: Event) => {
  const keyboardEvent = event as KeyboardEvent;
  if (keyboardEvent.isComposing) {
    return;
  }

  if (keyboardEvent.key === "Enter" && !keyboardEvent.shiftKey) {
    keyboardEvent.preventDefault();
    void sendChat();
  }
};

/**
 * 发送消息入口：模拟登录模式下不请求后端，给出明确提示。
 */
const sendChat = async () => {
  if (isMockAuth.value) {
    errorMessage.value =
      "当前为模拟登录模式，暂不支持发送对话。请使用真实账号登录体验对话功能。";
    statusMessage.value = "";
    return;
  }

  await sendChatMessage();
};

const copyContent = async (content: string) => {
  await navigator.clipboard.writeText(content);
  statusMessage.value = "内容已复制到剪贴板。";
};

/**
 * 将首页填写的简历信息写入工作台会话草稿，再跳转至 /resume 生成简历。
 */
const goToWorkspace = () => {
  const storage =
    typeof localStorage === "undefined" ? undefined : localStorage;
  writeResumeSessionSnapshot(
    storage,
    `aitext_resume_session:${user.value?.id ?? "anonymous"}`,
    {
      conversationId: "",
      form: { ...form },
      resumeVariants: [],
      selectedVariantIndex: 0,
      lastGenerateQuery: "",
      formDismissed: false,
    },
  );
  navigateTo("/resume");
};

const isFormMessage = (message: ChatMessage) => message.kind === "form";

onBeforeUnmount(() => {
  conversation.dispose();
});
</script>

<template>
  <section class="chat-home">
    <p v-if="errorMessage" class="banner error-banner">
      {{ errorMessage }}
    </p>

    <p v-if="statusMessage" class="banner status-banner">
      {{ statusMessage }}
    </p>

    <section class="panel chat-panel">
      <div v-if="hasFormData" class="form-ready-strip">
        <div class="ready-chips">
          <span class="ready-label">已填写：</span>
          <el-tag v-if="form.fullName.trim()" size="small" type="primary">
            {{ form.fullName.trim() }}
          </el-tag>
          <el-tag v-if="form.targetRole.trim()" size="small" type="primary">
            {{ form.targetRole.trim() }}
          </el-tag>
          <el-tag v-if="form.skillsText.trim()" size="small">
            {{ form.skillsText.trim() }}
          </el-tag>
        </div>
        <el-button size="small" @click="goToWorkspace"> 编辑 </el-button>
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
                message.id === activeAssistantMessageId,
            },
          ]"
        >
          <template v-if="isFormMessage(message)">
            <div class="bubble system-bubble">
              <p class="form-hint-title">从简历开始</p>
              <p class="form-hint-text">
                点击右上角「创建简历」填写基础信息，即可生成三版简历；也可以跳过，直接开始对话。
              </p>
            </div>
          </template>

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
            </div>
          </template>
        </article>
      </div>

      <div class="composer">
        <div class="composer-box">
          <el-input
            ref="chatComposerRef"
            v-model="chatInput"
            type="textarea"
            :rows="4"
            placeholder="告诉 UP AI 你的需求..."
            size="large"
            @keydown="onComposerKeydown"
          />

          <div class="composer-quick-tags">
            <button
              v-for="tag in quickTags"
              :key="tag"
              type="button"
              class="quick-chip"
              @click="applyQuickPrompt(tag)"
            >
              <svg
                class="quick-chip-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path :d="tagIcons[tag]" />
              </svg>
              {{ tag }}
            </button>
          </div>

          <el-button
            type="primary"
            size="large"
            class="send-button"
            :disabled="sendingMessage || !chatInput.trim()"
            @click="sendChat"
          >
            →
          </el-button>
        </div>
      </div>
    </section>
  </section>
</template>

<style scoped>
.chat-home {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: none;
  /* 撑满主内容区，让对话面板吸收剩余高度、输入卡片贴底 */
  min-height: 100%;
  /* 抵消布局底部留白，让输入区贴近屏幕底部，营造悬浮感 */
  margin-bottom: -18px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 4px 2px 0;
}

.eyebrow,
.section-kicker {
  margin: 0;
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.page-header h2,
.section-head h3 {
  margin: 8px 0 0;
  color: #1f2a44;
  line-height: 1.2;
}

.page-header h2 {
  font-size: 30px;
}

.page-note {
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
  color: #06b6d4;
}

.panel {
  padding: 22px;
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.72);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 24px 60px rgba(31, 43, 77, 0.08);
}

.chat-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 720px;
  /* 吸收剩余高度，让输入卡片贴底 */
  flex: 1 1 auto;
}

.form-ready-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: min(800px, 100%);
  margin: 0 auto;
  padding: 12px 16px;
  border-radius: 16px;
  border: 1px solid #e5ecff;
  background: rgba(248, 250, 255, 0.92);
}

.ready-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #455164;
}

.ready-label {
  color: #6b7386;
  font-weight: 700;
}

.chat-window {
  display: grid;
  gap: 18px;
  align-content: start;
  width: min(800px, 100%);
  margin: 0 auto;
  /* 吸收弹性空间，把输入卡片顶到面板底部；消息过多时区内滚动，输入框保持固定 */
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
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
  padding: 18px 20px;
  border-radius: 22px;
  box-shadow: 0 16px 34px rgba(31, 43, 77, 0.08);
}

.chat-message.user .bubble {
  background: linear-gradient(135deg, #06b6d4 0%, #22d3ee 100%);
  color: #ffffff;
}

.chat-message.assistant .bubble {
  background: #fbfcfe;
  border: 1px solid #e7ecf4;
}

.chat-message.assistant.span-linked .bubble {
  border-color: #06b6d4;
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

.form-hint-title {
  margin: 0;
  color: #06b6d4;
  font-size: 13px;
  font-weight: 800;
}

.form-hint-text {
  margin: 8px 0 0;
  color: #667085;
  font-size: 14px;
  line-height: 1.8;
}

.composer-quick-tags {
  position: absolute;
  top: 14px;
  left: 18px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  z-index: 1;
}

.quick-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: 1px solid rgba(148, 163, 184, 0.2);
  border-radius: 999px;
  background: rgba(241, 245, 249, 0.92);
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;
}

.quick-chip-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

/* 悬停反色：背景变蓝紫渐变、文字与图标变白 */
.quick-chip:hover {
  border-color: transparent;
  background: var(--app-gradient);
  color: #ffffff;
  box-shadow: 0 6px 16px rgba(6, 182, 212, 0.28);
}

.plain-message {
  margin: 0;
  white-space: pre-wrap;
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
  /* 铺满内容区宽度，紧贴左右边缘，作为页面的一部分而非悬浮浮层 */
  padding-top: 8px;
  border-top: 1px solid #eef2fb;
}

.composer-box {
  position: relative;
}

@media (max-width: 1100px) {
  .page-header {
    flex-direction: column;
  }

  .chat-home {
    margin-bottom: 0;
  }
}

@media (max-width: 900px) {
  .form-ready-strip {
    align-items: flex-start;
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .panel {
    padding: 16px;
  }

  .page-header h2 {
    font-size: 24px;
  }
}

.chat-home {
  color: var(--app-text);
}

.page-header h2 {
  letter-spacing: -0.03em;
}

.page-note {
  color: var(--app-muted-strong);
}

.header-pills :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.74);
  color: var(--app-muted-strong);
  box-shadow: var(--app-shadow-sm);
  border-radius: var(--app-radius-pill);
}

.header-pills :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.banner {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.74);
  box-shadow: var(--app-shadow-sm);
  border-radius: 18px;
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

.section-kicker {
  color: var(--app-primary);
}

.form-ready-strip {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.78);
  box-shadow: var(--app-shadow-sm);
  border-radius: 18px;
}

.ready-label {
  color: var(--app-muted-strong);
}

.ready-chips :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.8);
  color: var(--app-muted-strong);
  border-radius: var(--app-radius-pill);
}

.ready-chips :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.chat-window {
  display: grid;
  gap: 18px;
  align-content: start;
}

.chat-message {
  animation: fade-in-up 0.45s ease both;
}

.bubble {
  border: 1px solid var(--app-border);
  border-radius: 24px;
  box-shadow: var(--app-shadow-sm);
}

.chat-message.user .bubble {
  background: linear-gradient(
    135deg,
    rgba(8, 145, 178, 0.96),
    rgba(6, 182, 212, 0.94)
  );
  color: #ffffff;
}

.chat-message.assistant .bubble {
  background: rgba(239, 246, 255, 0.96);
  border-color: rgba(191, 219, 254, 0.92);
}

.chat-message.system .bubble {
  /* 玻璃拟态：半透明白 + backdrop-blur，去阴影，融入背景 */
  background: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  border-color: rgba(148, 163, 184, 0.18);
  box-shadow: none;
}

.form-hint-title,
.variant-kicker,
.variant-label,
.trace-kicker,
.timeline-kind {
  color: var(--app-primary);
}

.form-hint-text,
.plain-message,
.dialog-note,
.page-note {
  color: var(--app-muted-strong);
}

.composer {
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.composer-box :deep(.el-textarea__inner) {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.84);
  color: var(--app-text);
  /* 顶部预留快捷标签行，底部预留发送按钮，避免重叠 */
  padding: 52px 58px 16px 18px;
  transition: all 0.3s ease;
}

.composer-box :deep(.el-textarea__inner:focus) {
  border-color: rgba(6, 182, 212, 0.72);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: var(--app-shadow-focus);
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
  background: var(--app-gradient);
  color: #fff;
  font-size: 18px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 14px 28px rgba(6, 182, 212, 0.24);
  transform: scale(1);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
  z-index: 1;
}

.send-button:hover:not(:disabled) {
  transform: scale(1.08);
  box-shadow: 0 20px 38px rgba(6, 182, 212, 0.3);
}

.send-button:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
  box-shadow: none;
  transform: scale(0.9);
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

/* 去除对话面板的“卡片化”外观：透明底色、无阴影，让内容直接铺在页面底色上 */
.chat-panel {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  /* 左右、底部留白紧凑，让输入框像页面的一部分而非悬浮浮层 */
  padding: 18px 8px 8px;
  /* 透明面板随主卡片整体入场，自身不再单独播放淡入动画 */
  animation: none;
}
</style>

<!--
  页面级（非 scoped）覆盖：对话首页的主工作区不套白色卡片，
  让消息区与输入框直接落在页面底色（Slate-50/100 渐变）上，形成沉浸式工作台。
  仅对当前页面生效，离开页面后自动卸载。
-->
<style>
.workspace-main:has(.chat-home) {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.workspace-content:has(.chat-home) {
  padding: 0 8px;
  /* 极淡网格纹理：打破纯灰背景的单调感（借鉴 v0 / Perplexity 风格） */
  background-image:
    linear-gradient(rgba(100, 116, 139, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(100, 116, 139, 0.055) 1px, transparent 1px);
  background-size: 34px 34px;
  background-position: 0 0;
}
</style>
