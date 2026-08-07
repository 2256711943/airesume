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
      <p class="form-summary-label">当前上下文预览</p>
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
.bubble {
  width: min(920px, 100%);
  padding: 18px 20px;
  border-radius: 22px;
  box-shadow: 0 16px 34px rgba(31, 43, 77, 0.08);
  border: 1px solid #e5ecff;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.96),
    rgba(247, 250, 255, 0.98)
  );
}

.form-bubble {
  display: grid;
  gap: 16px;
}

.form-message-kicker,
.form-summary-label {
  margin: 0;
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.form-message-head h4 {
  margin: 8px 0 0;
  color: #1f2a44;
  line-height: 1.2;
  font-size: 22px;
}

.form-message-note {
  margin: 10px 0 0;
  color: #667085;
  font-size: 14px;
  line-height: 1.8;
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

.form-summary {
  display: grid;
  gap: 10px;
}

.summary-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
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

@media (max-width: 1100px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .form-message-head h4 {
    font-size: 20px;
  }
}
</style>
