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
.bubble {
  width: min(920px, 100%);
  padding: 18px 20px;
  border-radius: 22px;
  box-shadow: 0 16px 34px rgba(31, 43, 77, 0.08);
  background: #ffffff;
  border: 1px solid #edf0f6;
}

.variant-bubble {
  display: grid;
  gap: 16px;
}

.variant-kicker,
.variant-label {
  margin: 0;
  color: #6b7386;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.variant-head h4 {
  margin: 8px 0 0;
  color: #1f2a44;
  line-height: 1.2;
  font-size: 22px;
}

.variant-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
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

.variant-summary,
.variant-grid,
.variant-block,
.variant-switch-stage {
  display: grid;
  gap: 12px;
}

.variant-summary-text {
  margin: 0;
  color: #334155;
  font-size: 14px;
  line-height: 1.8;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
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

.mini-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
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

@media (max-width: 900px) {
  .print-preview-head {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
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
