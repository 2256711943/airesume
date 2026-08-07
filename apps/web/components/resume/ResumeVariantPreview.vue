<script setup lang="ts">
/**
 * @description 三版简历预览气泡：版本切换、内容展示、复制/导出 PDF，并持有打印视图供导出读取 DOM。
 */
import { ref } from "vue";

import PrintResumeView from "./PrintResumeView.vue";
import { variantLabels, type ResumeVariant } from "../../utils/resume";

interface ResumeVariantPreviewProps {
  variants: ResumeVariant[];
  selectedVariantIndex: number;
  selectedVariant: ResumeVariant | null;
  selectedVariantMarkdown: string;
  fullName: string;
  targetRole: string;
  exportingPdf: boolean;
  printReady: boolean;
  activeVariantLabel: string;
}

defineProps<ResumeVariantPreviewProps>();

const emit = defineEmits<{
  "select-variant": [index: number];
  copy: [markdown: string];
  "export-pdf": [];
}>();

interface PrintResumeViewHandle {
  getRootElement: () => HTMLElement | null;
}

const exportViewRef = ref<PrintResumeViewHandle | null>(null);

defineExpose({
  getExportRootElement: () => exportViewRef.value?.getRootElement() ?? null,
});
</script>

<template>
  <article class="chat-message assistant">
    <div class="bubble variant-bubble">
      <div class="variant-head">
        <div>
          <p class="variant-kicker">三版预览</p>
          <h4>技术版 / 业务版 / 综合版</h4>
          <p class="variant-head-note">
            共 {{ variants.length }} 个版本，当前展示第
            {{ selectedVariantIndex + 1 }} 个，点击上方标签切换。
          </p>
        </div>
        <el-tag> 当前：{{ activeVariantLabel }} </el-tag>
      </div>

      <div class="variant-tabs" role="tablist" aria-label="切换简历版本">
        <button
          v-for="(variant, index) in variants"
          :id="`variant-tab-${index}`"
          :key="variant.id"
          type="button"
          role="tab"
          class="variant-tab"
          :class="{ active: index === selectedVariantIndex }"
          :aria-selected="index === selectedVariantIndex"
          @click="emit('select-variant', index)"
        >
          <span class="variant-tab-index">{{ index + 1 }}</span>
          <span class="variant-tab-label">
            {{ variantLabels[index] ?? `版本 ${index + 1}` }}
          </span>
          <span v-if="index === selectedVariantIndex" class="variant-tab-state">
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
                <el-tag
                  v-for="skill in selectedVariant.skills"
                  :key="skill"
                  type="primary"
                  size="small"
                >
                  {{ skill }}
                </el-tag>
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
                    <li v-for="highlight in exp.highlights" :key="highlight">
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
                  <li v-for="highlight in project.highlights" :key="highlight">
                    {{ highlight }}
                  </li>
                </ul>
              </div>
            </div>
          </article>

          <div class="mini-actions">
            <el-button
              size="small"
              :disabled="!selectedVariantMarkdown"
              @click="emit('copy', selectedVariantMarkdown)"
            >
              复制当前版本
            </el-button>
            <el-button
              size="small"
              :disabled="!printReady || exportingPdf"
              @click="emit('export-pdf')"
            >
              {{ exportingPdf ? "导出 PDF 中..." : "导出 PDF" }}
            </el-button>
          </div>

          <section
            class="print-preview-shell"
            :data-print-ready="printReady ? 'true' : 'false'"
          >
            <div class="print-preview-head">
              <div>
                <p class="variant-label">打印视图</p>
                <p class="print-preview-note">
                  {{
                    printReady
                      ? "打印 DOM 已就绪，可供 PDF 导出读取。"
                      : "打印 DOM 准备中。"
                  }}
                </p>
              </div>

              <el-tag type="primary" size="small">
                {{ printReady ? "已就绪" : "未就绪" }}
              </el-tag>
            </div>

            <div class="print-preview-canvas">
              <PrintResumeView
                :full-name="fullName"
                :target-role="targetRole"
                :variant="selectedVariant"
              />
            </div>

            <div class="print-export-staging" aria-hidden="true">
              <PrintResumeView
                ref="exportViewRef"
                :full-name="fullName"
                :target-role="targetRole"
                :variant="selectedVariant"
                :show-page-footer="false"
              />
            </div>
          </section>
        </div>
      </Transition>
    </div>
  </article>
</template>

<style scoped>
/* 与 resume.vue 风格一致：柔和扁平，淡描边，无阴影 */
.bubble {
  width: min(920px, 100%);
  padding: 20px;
  border-radius: 18px;
  box-shadow: none;
  background: #ffffff;
  border: 1px solid #e6e9f2;
  transition: border-color 0.2s ease;
}

.variant-bubble {
  display: grid;
  gap: 18px;
}

/* Kicker 用品牌色做弱提示 */
.variant-kicker,
.variant-label {
  margin: 0;
  color: #5b63ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.variant-head h4 {
  margin: 6px 0 0;
  color: #111827;
  line-height: 1.25;
  font-size: 20px;
  font-weight: 700;
}

.variant-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.variant-head-note {
  margin: 6px 0 0;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.7;
}

.variant-head :deep(.el-tag) {
  border: 1px solid #e6e9f2;
  background: #f6f8fc;
  color: #4b5563;
  border-radius: 999px;
  font-weight: 500;
}

/* Tabs：柔和的描边切换，激活态用淡品牌色底 + 深品牌色字（不做强黑底） */
.variant-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px;
  background: #f6f8fc;
  border: 1px solid #e6e9f2;
  border-radius: 14px;
}

.variant-tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 0;
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: transparent;
  color: #6b7280;
  font: inherit;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}

.variant-tab:hover {
  border-color: #dde2ee;
  background: #ffffff;
  color: #0e7490;
}

.variant-tab.active {
  border-color: #eef0ff;
  background: #ffffff;
  color: #0e7490;
  box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
}

.variant-tab-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  border-radius: 999px;
  background: #e5e7eb;
  color: #4b5563;
  font-size: 12px;
  font-weight: 700;
  transition: all 0.2s ease;
}

.variant-tab.active .variant-tab-index {
  background: #5b63ff;
  color: #ffffff;
}

.variant-tab:hover .variant-tab-index {
  background: #eef0ff;
  color: #0e7490;
}

.variant-tab-label {
  font-size: 14px;
  font-weight: 600;
  flex: 1;
}

.variant-tab-state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.variant-tab.active .variant-tab-state {
  background: #eef0ff;
  color: #0e7490;
}

.variant-tab:not(.active) .variant-tab-state {
  background: #e5e7eb;
  color: #6b7280;
}

.variant-switch-stage {
  display: grid;
  gap: 16px;
}

.variant-switch-enter-active,
.variant-switch-leave-active {
  transition:
    opacity 0.22s ease,
    transform 0.22s ease;
}

.variant-switch-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.variant-switch-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.variant-summary,
.variant-grid,
.variant-block,
.variant-switch-stage {
  display: grid;
  gap: 12px;
}

.variant-grid {
  grid-template-columns: 1fr;
  gap: 14px;
}

@media (min-width: 780px) {
  .variant-grid {
    grid-template-columns: 0.8fr 1.2fr;
  }
}

.variant-summary-text {
  margin: 0;
  color: #4b5563;
  font-size: 14px;
  line-height: 1.8;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-list :deep(.el-tag) {
  border: 1px solid #e6e9f2;
  border-radius: 999px;
  background: #ffffff;
  color: #4b5563;
  font-weight: 500;
}

.tag-list :deep(.el-tag--primary) {
  border-color: #eef0ff;
  background: #eef0ff;
  color: #0e7490;
}

.entry-list {
  display: grid;
  gap: 10px;
}

.entry-card {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid #e6e9f2;
  background: #fafbff;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.entry-card:hover {
  border-color: #dde2ee;
  background: #ffffff;
}

.entry-card strong {
  color: #111827;
  font-size: 14px;
  font-weight: 600;
}

.entry-card ul {
  margin: 0;
  padding-left: 18px;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.8;
}

.mini-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.mini-actions :deep(.el-button) {
  border-radius: 999px;
  border: 1px solid #e6e9f2;
  background: #ffffff;
  color: #4b5563;
  font-weight: 500;
  transition: all 0.18s ease;
}

.mini-actions :deep(.el-button:hover) {
  border-color: #5b63ff;
  background: #eef0ff;
  color: #0e7490;
}

/* 打印预览：简洁嵌入感 */
.print-preview-shell {
  display: grid;
  gap: 14px;
  padding: 16px;
  border: 1px solid #e6e9f2;
  border-radius: 14px;
  background: #f6f8fc;
}

.print-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.print-preview-head :deep(.el-tag--primary) {
  border-color: #eef0ff;
  background: #eef0ff;
  color: #0e7490;
  border-radius: 999px;
  font-weight: 500;
}

.print-preview-note {
  margin: 6px 0 0;
  color: #6b7280;
  font-size: 13px;
  line-height: 1.7;
}

.print-preview-canvas {
  overflow: auto;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid #e6e9f2;
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

@media (max-width: 900px) {
  .print-preview-head {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  .variant-head h4 {
    font-size: 18px;
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
      rgba(255, 255, 255, 0.94),
      rgba(248, 250, 252, 0.88)
    ),
    var(--app-gradient-soft);
  box-shadow: var(--app-shadow-md);
  animation: fade-in-up 0.55s cubic-bezier(0.16, 1, 0.3, 1) both;
}

.variant-kicker,
.variant-label {
  color: var(--app-primary);
}

.variant-head h4 {
  color: var(--app-text);
  letter-spacing: -0.03em;
}

.variant-head-note,
.print-preview-note,
.variant-summary-text,
.entry-card ul,
.entry-card p {
  color: var(--app-muted-strong);
}

.variant-head :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.78);
  color: var(--app-muted-strong);
  box-shadow: var(--app-shadow-sm);
}

.variant-tabs {
  padding: 6px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  background: rgba(248, 250, 252, 0.82);
}

.variant-tab {
  min-height: 48px;
  border-radius: 16px;
  transition:
    transform 0.28s ease,
    background-color 0.28s ease,
    border-color 0.28s ease,
    color 0.28s ease,
    box-shadow 0.28s ease;
}

.variant-tab:hover {
  transform: translateY(-1px);
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(255, 255, 255, 0.84);
  color: var(--app-primary-strong);
}

.variant-tab.active {
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(255, 255, 255, 0.96);
  color: var(--app-primary-strong);
  box-shadow: var(--app-shadow-sm);
}

.variant-tab-index {
  background: rgba(148, 163, 184, 0.18);
  color: var(--app-muted-strong);
}

.variant-tab.active .variant-tab-index {
  background: var(--app-gradient);
  color: #ffffff;
}

.variant-tab-state {
  font-weight: 600;
}

.variant-tab.active .variant-tab-state {
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.variant-block,
.variant-summary,
.entry-card,
.print-preview-shell,
.print-preview-canvas {
  border-radius: 20px;
}

.variant-block {
  padding: 0;
}

.variant-summary {
  padding: 16px 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.82);
}

.tag-list :deep(.el-tag),
.mini-actions :deep(.el-button),
.print-preview-head :deep(.el-tag--primary) {
  border-radius: var(--app-radius-pill);
}

.tag-list :deep(.el-tag) {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.82);
  color: var(--app-muted-strong);
}

.tag-list :deep(.el-tag--primary) {
  border-color: rgba(6, 182, 212, 0.16);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.entry-card {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.82);
  box-shadow: var(--app-shadow-sm);
}

.entry-card:hover {
  border-color: rgba(6, 182, 212, 0.18);
  background: rgba(255, 255, 255, 0.96);
}

.mini-actions :deep(.el-button) {
  border: 1px solid rgba(148, 163, 184, 0.2);
  background: rgba(255, 255, 255, 0.78);
  color: var(--app-muted-strong);
}

.mini-actions :deep(.el-button:hover) {
  border-color: rgba(6, 182, 212, 0.24);
  background: rgba(219, 234, 254, 0.82);
  color: var(--app-primary-strong);
}

.print-preview-shell {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(248, 250, 252, 0.82);
}

.print-preview-canvas {
  border: 1px solid rgba(148, 163, 184, 0.18);
  background: rgba(255, 255, 255, 0.86);
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
