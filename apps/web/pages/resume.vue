<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import { nextTick, reactive, ref } from 'vue';

import { useAuth } from '../composables/useAuth';
import { useResumeConversation } from '../composables/useResumeConversation';
import { useResumeGeneration } from '../composables/useResumeGeneration';
import { buildAllVariantsMarkdown, createResumeFormState, quickTags, variantLabels } from '../utils/resume';

const { token, clearAuth } = useAuth();
const markdown = new MarkdownIt({
  breaks: true,
  linkify: true,
  html: false,
});

const form = reactive(createResumeFormState());
const errorMessage = ref('');
const statusMessage = ref('');
const chatComposerRef = ref<HTMLTextAreaElement | null>(null);

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

getVariantSnapshot = () => buildAllVariantsMarkdown(generation.resumeVariants.value);

const {
  applyQuickPrompt: applyQuickPromptBase,
  chatInput,
  chatMessages,
  conversationId,
  formSummaryLines,
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

const renderMarkdown = (content: string): string => markdown.render(content || '');

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
  statusMessage.value = '内容已复制到剪贴板。';
};

const exportContent = (content: string, fileName: string) => {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  statusMessage.value = '已导出 Markdown 文件。';
};

const onComposerKeydown = (event: KeyboardEvent) => {
  if (event.isComposing) {
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
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
        <p class="eyebrow">
          Resume Assistant
        </p>
        <h2>绠€鍘嗗璇濆伐浣滃彴</h2>
        <p class="page-note">
          鏂板紑瀵硅瘽鏃讹紝绯荤粺浼氬厛鎶婅〃鍗曠洿鎺ュ彂杩涙秷鎭祦閲屻€備綘鍙互濉啓鍚庣敓鎴愪笁鐗堢畝鍘嗭紝涔熷彲浠ヨ烦杩囩洿鎺ヨ亰澶┿€?
        </p>
      </div>

      <div class="header-pills">
        <span class="status-pill">
          {{ conversationId ? '会话已建立' : '等待对话' }}
        </span>
        <span class="status-pill soft">
          {{ hasGeneratedVariants ? `已生成 ${resumeVariants.length} 个版本` : '尚未生成' }}
        </span>
      </div>
    </header>

    <p
      v-if="errorMessage"
      class="banner error-banner"
    >
      {{ errorMessage }}
    </p>

    <p
      v-if="statusMessage"
      class="banner status-banner"
    >
      {{ statusMessage }}
    </p>

    <section class="panel chat-panel">
      <div class="section-head">
        <div>
          <p class="section-kicker">
            瀵硅瘽绐楀彛
          </p>
          <h3>围绕简历继续提问</h3>
        </div>

        <span class="section-tag">
          {{ conversationId ? '会话进行中' : '新对话' }}
        </span>
      </div>

      <div class="chat-window">
        <article
          v-for="message in chatMessages"
          :key="message.id"
          class="chat-message"
          :class="message.role"
        >
          <div
            v-if="message.kind === 'form'"
            class="bubble form-bubble"
          >
            <div class="form-message-head">
              <p class="form-message-kicker">
                绯荤粺琛ㄥ崟
              </p>
              <h4>鍏堝憡璇?UP AI 涓€浜涘熀纭€淇℃伅</h4>
              <p class="form-message-note">
                杩欏紶琛ㄥ崟灏辨槸鏈疆瀵硅瘽鐨勭郴缁熶笂涓嬫枃鍏ュ彛銆傚彲浠ュ～鍐欏悗鐢熸垚绠€鍘嗭紝涔熷彲浠ョ洿鎺ヨ烦杩囥€?
              </p>
            </div>

            <div class="form-grid">
              <label class="field">
                <span>濮撳悕</span>
                <input
                  v-model="form.fullName"
                  type="text"
                  maxlength="80"
                  placeholder="例如：张三"
                >
              </label>

              <label class="field">
                <span>鐩爣宀椾綅</span>
                <input
                  v-model="form.targetRole"
                  type="text"
                  maxlength="100"
                  placeholder="渚嬪锛氬悗绔伐绋嬪笀"
                >
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
                  placeholder="渚嬪锛歂ode.js, NestJS, PostgreSQL, Redis"
                >
              </label>

              <label class="field full-width">
                <span>宀椾綅瑕佹眰</span>
                <input
                  v-model="form.targetSkillsText"
                  type="text"
                  placeholder="例如：微服务, 性能优化, 可观测性"
                >
              </label>

              <label class="field full-width">
                <span>宀椾綅鎻忚堪</span>
                <textarea
                  v-model="form.targetDescription"
                  rows="3"
                  maxlength="2000"
                  placeholder="补充岗位职责、业务场景或团队要求，便于生成更贴合的版本。"
                />
              </label>

              <label class="field full-width">
                <span>宸ヤ綔缁忓巻</span>
                <textarea
                  v-model="form.experienceText"
                  rows="4"
                  placeholder="姣忚鏍煎紡锛氬叕鍙竱宀椾綅|浜偣1;浜偣2"
                />
              </label>

              <label class="field full-width">
                <span>椤圭洰缁忓巻</span>
                <textarea
                  v-model="form.projectText"
                  rows="4"
                  placeholder="姣忚鏍煎紡锛氶」鐩悕|浜偣1;浜偣2"
                />
              </label>

              <label class="field">
                <span>璇皵</span>
                <select v-model="form.tone">
                  <option value="professional">
                    professional
                  </option>
                  <option value="concise">
                    concise
                  </option>
                </select>
              </label>

              <label class="field">
                <span>璇█</span>
                <select v-model="form.language">
                  <option value="zh-CN">
                    zh-CN
                  </option>
                  <option value="en-US">
                    en-US
                  </option>
                </select>
              </label>
            </div>

            <div class="form-summary">
              <p class="form-summary-label">
                褰撳墠涓婁笅鏂囬瑙?
              </p>
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
                {{ generating ? '正在生成...' : '生成三版简历' }}
              </button>

              <button
                class="secondary-button"
                type="button"
                :disabled="generating"
                @click="focusComposer"
              >
                璺宠繃锛岀洿鎺ュ璇?
              </button>

              <button
                class="ghost-button"
                type="button"
                :disabled="generating || !lastGenerateQuery"
                @click="retryGenerate"
              >
                閲嶈瘯鐢熸垚
              </button>

              <button
                class="ghost-button"
                type="button"
                :disabled="!generating"
                @click="cancelGenerate"
              >
                鍙栨秷
              </button>
            </div>

            <div
              v-if="generating || streamProgress > 0"
              class="progress-box"
            >
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
              <p
                v-if="streamPreview"
                class="progress-preview"
              >
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
              <p
                v-else
                class="plain-message"
              >
                {{ message.content }}
              </p>
            </div>

            <AgentTraceCard
              v-if="message.role === 'assistant' && message.trace && (message.trace.routeDecisionStarted || message.trace.toolCalls.length > 0 || message.trace.done)"
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
                澶嶅埗
              </button>
              <button
                type="button"
                class="chip-button"
                @click="exportContent(message.content, 'chat-message.md')"
              >
                瀵煎嚭
              </button>
            </div>
          </template>
        </article>

        <article
          v-if="hasGeneratedVariants"
          class="chat-message assistant"
        >
          <div class="bubble variant-bubble">
            <div class="variant-head">
              <div>
                <p class="variant-kicker">
                  涓夌増棰勮
                </p>
                <h4>技术版 / 业务版 / 综合版</h4>
              </div>
              <span class="section-tag">
                当前：{{ activeVariantLabel }}
              </span>
            </div>

            <div class="variant-tabs">
              <button
                v-for="(variant, index) in resumeVariants"
                :key="variant.id"
                type="button"
                class="variant-tab"
                :class="{ active: index === selectedVariantIndex }"
                @click="selectedVariantIndex = index"
              >
                {{ variantLabels[index] ?? `鐗堟湰 ${index + 1}` }}
              </button>
            </div>

            <template v-if="selectedVariant">
              <div class="variant-summary">
                <p class="variant-label">
                  鎽樿
                </p>
                <p class="variant-summary-text">
                  {{ selectedVariant.summary }}
                </p>
              </div>

              <div class="variant-grid">
                <article class="variant-block">
                  <p class="variant-label">
                    鏍稿績鎶€鑳?
                  </p>
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
                  <p class="variant-label">
                    宸ヤ綔缁忓巻
                  </p>
                  <div class="entry-list">
                    <div
                      v-for="exp in selectedVariant.experience"
                      :key="`${exp.company}-${exp.role}`"
                      class="entry-card"
                    >
                      <strong>{{ exp.company }} 路 {{ exp.role }}</strong>
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
                <p class="variant-label">
                  椤圭洰缁忓巻
                </p>
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
                  澶嶅埗褰撳墠鐗堟湰
                </button>
                <button
                  type="button"
                  class="mini-button"
                  :disabled="!selectedVariantMarkdown"
                  @click="exportContent(selectedVariantMarkdown, selectedVariantFileName)"
                >
                  瀵煎嚭 Markdown
                </button>
              </div>
            </template>
          </div>
        </article>
      </div>

      <div class="composer">
        <label class="composer-field">
          <span>鍛婅瘔 UP AI 浣犵殑闇€姹?..</span>
          <textarea
            ref="chatComposerRef"
            v-model="chatInput"
            rows="4"
            placeholder="鍛婅瘔 UP AI 浣犵殑闇€姹?.."
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
            鈫?
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

.chat-message.system .bubble {
  border: 1px solid #e5ecff;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(247, 250, 255, 0.98));
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
.message-actions,
.variant-tabs {
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
.variant-tab,
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
.quick-button,
.variant-tab {
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
.variant-tab:hover,
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

.variant-head,
.variant-summary,
.variant-grid,
.variant-block {
  display: grid;
  gap: 12px;
}

.variant-tab.active {
  border-color: #355bff;
  background: #355bff;
  color: #ffffff;
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
}
</style>
