<script setup lang="ts">
/**
 * @description 简历工作台内的系统表单气泡：简历字段录入、上下文摘要、生成操作与流式进度。
 */
import type { ResumeFormState } from "../../utils/resume";

interface ResumeFormBubbleProps {
  form: ResumeFormState;
  formSummaryLines: string[];
  generating: boolean;
  generationReady: boolean;
  streamProgress: number;
  streamStageLabel: string;
  streamPreview: string;
  lastGenerateQuery: string;
}

const props = defineProps<ResumeFormBubbleProps>();

const emit = defineEmits<{
  generate: [];
  retry: [];
  cancel: [];
  skip: [];
}>();

/**
 * form 是页面与组件共享的响应式对象（页面负责会话持久化等），
 * 组件直接编辑其字段以保持双向绑定。
 */
const form = props.form;
</script>

<template>
  <div class="bubble form-bubble">
    <div class="form-grid">
      <label class="field">
        <span>姓名</span>
        <el-input
          v-model="form.fullName"
          maxlength="80"
          placeholder="例如：张三"
          size="large"
        />
      </label>

      <label class="field">
        <span>目标岗位</span>
        <el-input
          v-model="form.targetRole"
          maxlength="100"
          placeholder="例如：后端工程师"
          size="large"
        />
      </label>

      <label class="field full-width">
        <span>背景简介</span>
        <el-input
          v-model="form.background"
          type="textarea"
          :rows="3"
          maxlength="500"
          placeholder="例如：3 年后端开发经验，做过高并发服务和接口优化。"
          size="large"
        />
      </label>

      <label class="field full-width">
        <span>技能</span>
        <el-input
          v-model="form.skillsText"
          placeholder="例如：Node.js, NestJS, PostgreSQL, Redis"
          size="large"
        />
      </label>

      <label class="field full-width">
        <span>岗位要求</span>
        <el-input
          v-model="form.targetSkillsText"
          placeholder="例如：微服务, 性能优化, 可观测性"
          size="large"
        />
      </label>

      <label class="field full-width">
        <span>岗位描述</span>
        <el-input
          v-model="form.targetDescription"
          type="textarea"
          :rows="3"
          maxlength="2000"
          placeholder="补充岗位职责、业务场景或团队要求，便于生成更贴合的版本。"
          size="large"
        />
      </label>

      <label class="field full-width">
        <span>工作经历</span>
        <el-input
          v-model="form.experienceText"
          type="textarea"
          :rows="4"
          placeholder="每行格式：公司|岗位|亮点1;亮点2"
          size="large"
        />
      </label>

      <label class="field full-width">
        <span>项目经历</span>
        <el-input
          v-model="form.projectText"
          type="textarea"
          :rows="4"
          placeholder="每行格式：项目名|亮点1;亮点2"
          size="large"
        />
      </label>

      <label class="field">
        <span>语气</span>
        <el-select v-model="form.tone" size="large">
          <el-option value="professional" label="professional" />
          <el-option value="concise" label="concise" />
        </el-select>
      </label>

      <label class="field">
        <span>语言</span>
        <el-select v-model="form.language" size="large">
          <el-option value="zh-CN" label="zh-CN" />
          <el-option value="en-US" label="en-US" />
        </el-select>
      </label>
    </div>

    <div class="form-summary">
      <div class="summary-chips">
        <el-tag
          v-for="line in formSummaryLines"
          :key="line"
          type="primary"
          size="small"
        >
          {{ line }}
        </el-tag>
      </div>
    </div>

    <div class="action-row">
      <el-button
        type="primary"
        size="large"
        :loading="generating"
        :disabled="!generationReady"
        @click="emit('generate')"
      >
        {{ generating ? "正在生成..." : "生成三版简历" }}
      </el-button>

      <el-button size="large" :disabled="generating" @click="emit('skip')">
        跳过，直接对话
      </el-button>

      <el-button
        size="large"
        :disabled="generating || !lastGenerateQuery"
        @click="emit('retry')"
      >
        重试生成
      </el-button>

      <el-button size="large" :disabled="!generating" @click="emit('cancel')">
        取消
      </el-button>
    </div>

    <div v-if="generating || streamProgress > 0" class="progress-box">
      <div class="progress-head">
        <span>{{ streamStageLabel }}</span>
        <strong>{{ Math.round(streamProgress) }}%</strong>
      </div>
      <div class="progress-track">
        <div class="progress-bar" :style="{ width: `${streamProgress}%` }" />
      </div>
      <p v-if="streamPreview" class="progress-preview">
        {{ streamPreview }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 与 resume.vue 主页面风格一致：柔和扁平，淡描边，无阴影 */
.bubble {
  width: 100%;
  padding: 20px;
  border-radius: 18px;
  box-shadow: none;
  border: 1px solid #e6e9f2;
  background: #ffffff;
  transition: border-color 0.2s ease;
}

.form-bubble {
  display: grid;
  gap: 18px;
}

/* Kicker 使用品牌色做弱提示 */
.form-message-kicker,
.form-summary-label {
  margin: 0;
  color: #5b63ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.form-message-head h4 {
  margin: 6px 0 0;
  color: #111827;
  line-height: 1.25;
  font-size: 20px;
  font-weight: 700;
}

.form-message-note {
  margin: 8px 0 0;
  color: #6b7280;
  font-size: 14px;
  line-height: 1.75;
}

/* 表单网格：更克制的间距 */
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.field {
  display: grid;
  gap: 8px;
  color: #4b5563;
  font-size: 13px;
  font-weight: 500;
}

.field.full-width {
  grid-column: 1 / -1;
}

/* 统一 Element Plus 输入框风格：淡底色、圆角、聚焦柔和光晕 */
.field :deep(.el-input__wrapper),
.field :deep(.el-textarea__inner),
.field :deep(.el-select__wrapper) {
  border: 1px solid #e6e9f2;
  border-radius: 14px;
  background: #f6f8fc;
  box-shadow: none;
  transition: all 0.2s ease;
}

.field :deep(.el-textarea__inner) {
  padding: 12px 14px;
  line-height: 1.7;
}

.field :deep(.el-input__wrapper:hover),
.field :deep(.el-textarea__inner:hover),
.field :deep(.el-select__wrapper:hover) {
  border-color: #d0d5e3;
}

.field :deep(.el-input__wrapper.is-focus),
.field :deep(.el-textarea__inner:focus),
.field :deep(.el-select__wrapper.is-focused) {
  border-color: #5b63ff;
  background: #ffffff;
  box-shadow: 0 0 0 3px #eef0ff;
}

.field :deep(.el-input__inner),
.field :deep(.el-textarea__inner),
.field :deep(.el-select__placeholder),
.field :deep(.el-select__selected-item) {
  color: #111827;
  font-size: 14px;
}

.form-summary {
  display: grid;
  gap: 10px;
}

.summary-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.summary-chips :deep(.el-tag) {
  border: 1px solid #e6e9f2;
  border-radius: 999px;
  background: #ffffff;
  color: #4b5563;
  font-weight: 500;
}

.summary-chips :deep(.el-tag--primary) {
  border-color: #eef0ff;
  background: #eef0ff;
  color: #0e7490;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

/* 按钮风格：胶囊形，弱描边 → hover 品牌色填充 */
.action-row :deep(.el-button) {
  border-radius: 999px;
  padding: 0 20px;
  height: 40px;
  font-weight: 500;
  transition: all 0.18s ease;
}

.action-row :deep(.el-button--primary) {
  border: 0;
  background: #5b63ff;
  color: #fff;
}

.action-row :deep(.el-button--primary:hover) {
  background: #0e7490;
  transform: translateY(-1px);
}

.action-row :deep(.el-button:not(.el-button--primary)) {
  border: 1px solid #e6e9f2;
  background: #ffffff;
  color: #4b5563;
}

.action-row :deep(.el-button:not(.el-button--primary):hover) {
  border-color: #5b63ff;
  background: #eef0ff;
  color: #0e7490;
}

/* 生成进度条：更平 */
.progress-box {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 14px;
  background: #f6f8fc;
  border: 1px solid #e6e9f2;
}

.progress-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #4b5563;
  font-size: 13px;
  font-weight: 500;
}

.progress-track {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #e6e9f2;
}

.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: #5b63ff;
  transition: width 0.2s ease;
}

.progress-preview {
  margin: 0;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
}

@media (max-width: 1100px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .form-message-head h4 {
    font-size: 18px;
  }

  .bubble {
    padding: 16px;
  }
}

.bubble {
  border: 1px solid var(--app-border);
  border-radius: 28px;
  background:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.92),
      rgba(248, 250, 252, 0.86)
    ),
    var(--app-gradient-soft);
  box-shadow: var(--app-shadow-md);
  animation: fade-in-up 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.form-message-kicker,
.form-summary-label {
  color: var(--app-primary);
}

.form-message-head h4 {
  color: var(--app-text);
  letter-spacing: -0.03em;
}

.form-message-note {
  color: var(--app-muted-strong);
}

.form-grid {
  gap: 16px;
}

.field {
  color: var(--app-muted-strong);
  font-size: 13px;
  font-weight: 600;
}

.field span {
  margin-bottom: 2px;
}

.field :deep(.el-input__wrapper),
.field :deep(.el-textarea__inner),
.field :deep(.el-select__wrapper) {
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.84);
  box-shadow: none;
  transition: all 0.3s ease;
}

.field :deep(.el-input__wrapper.is-focus),
.field :deep(.el-textarea__inner:focus),
.field :deep(.el-select__wrapper.is-focused) {
  border-color: rgba(6, 182, 212, 0.72);
  background: rgba(255, 255, 255, 0.98);
  box-shadow: var(--app-shadow-focus);
}

.field :deep(.el-input__inner),
.field :deep(.el-textarea__inner),
.field :deep(.el-select__placeholder),
.field :deep(.el-select__selected-item) {
  color: var(--app-text);
}

.summary-chips :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.8);
  color: var(--app-muted-strong);
  border-radius: var(--app-radius-pill);
  box-shadow: var(--app-shadow-sm);
}

.summary-chips :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.action-row :deep(.el-button) {
  border-radius: var(--app-radius-pill);
  min-height: 44px;
  padding: 0 20px;
  transition:
    transform 0.3s ease,
    box-shadow 0.3s ease,
    border-color 0.3s ease,
    background-color 0.3s ease;
}

.action-row :deep(.el-button--primary) {
  background: var(--app-gradient);
  box-shadow: 0 14px 30px rgba(6, 182, 212, 0.22);
}

.action-row :deep(.el-button--primary:hover) {
  transform: translateY(-2px);
  box-shadow: 0 20px 42px rgba(6, 182, 212, 0.3);
}

.action-row :deep(.el-button:not(.el-button--primary)) {
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.78);
  color: var(--app-muted-strong);
}

.action-row :deep(.el-button:not(.el-button--primary):hover) {
  border-color: rgba(6, 182, 212, 0.24);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.progress-box {
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.74);
  box-shadow: var(--app-shadow-sm);
}

.progress-bar {
  background: var(--app-gradient);
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
