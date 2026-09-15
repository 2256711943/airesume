<script setup lang="ts">
/**
 * @description 简历 PDF 右侧实时预览容器：A4 画布 + 模板/主题设计变量。
 * 当前阶段先落地预览效果，模板/主题切换与表单数据回填在后续步骤接入。
 */
import PrintResumeView from "./PrintResumeView.vue";
import type { ResumeVariant } from "../../utils/resume";
import {
  DEFAULT_RESUME_PDF_TEMPLATE_ID,
  DEFAULT_RESUME_PDF_THEME_ID,
  buildResumePdfThemeCssVariables,
  getResumePdfTemplate,
  getResumePdfTheme,
} from "../../utils/resume-pdf-design";

defineProps<{
  fullName: string;
  targetRole: string;
  variant: ResumeVariant | null;
}>();

const template = getResumePdfTemplate(DEFAULT_RESUME_PDF_TEMPLATE_ID);
const theme = getResumePdfTheme(DEFAULT_RESUME_PDF_THEME_ID);
const themeCssVariables = buildResumePdfThemeCssVariables(theme);
</script>

<template>
  <section class="resume-pdf-preview-pane">
    <header class="preview-pane-head">
      <div>
        <p class="section-kicker">实时预览</p>
        <h3>PDF 效果预览</h3>
      </div>
      <div class="preview-meta">
        <el-tag size="small">
          {{ template.previewLabel }}
        </el-tag>
        <el-tag size="small" type="primary">
          {{ theme.previewLabel }}
        </el-tag>
      </div>
    </header>

    <div class="preview-canvas" :style="themeCssVariables">
      <div class="preview-sheet">
        <PrintResumeView
          :full-name="fullName"
          :target-role="targetRole"
          :variant="variant"
        />
      </div>
    </div>

    <footer class="preview-pane-foot">
      <span>A4 · {{ template.previewLabel }}</span>
      <span>{{ theme.description }}</span>
    </footer>
  </section>
</template>

<style scoped>
.resume-pdf-preview-pane {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 16px;
  padding: 22px;
}

.preview-pane-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.section-kicker {
  margin: 0;
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}

.preview-pane-head h3 {
  margin: 6px 0 0;
  color: var(--app-text);
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.03em;
}

.preview-meta {
  display: flex;
  gap: 6px;
}

.preview-meta :deep(.el-tag) {
  border-radius: 999px;
}

/* 预览画布：仿设计工具的点阵底板，A4 纸张居中悬浮 */
.preview-canvas {
  min-height: 0;
  overflow: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 30px 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 24px;
  background-color: rgba(248, 250, 252, 0.72);
  background-image: radial-gradient(
    rgba(100, 116, 139, 0.16) 1px,
    transparent 1px
  );
  background-size: 18px 18px;
}

/* A4 画布：等比缩放 + 套用主题设计变量 */
.preview-sheet {
  width: min(100%, 540px);
  aspect-ratio: 210 / 297;
  flex-shrink: 0;
  padding: 26px 30px;
  border-radius: var(--resume-pdf-radius, 14px);
  border: var(--resume-pdf-border-width, 1px) solid
    var(--resume-pdf-border, #dbe2f0);
  background: var(--resume-pdf-background, #ffffff);
  box-shadow: var(--resume-pdf-shadow, 0 8px 24px rgba(15, 23, 42, 0.06));
  overflow: hidden;
  color: var(--resume-pdf-text, #111827);
  font-family: var(--resume-pdf-font-family, sans-serif);
  font-size: var(--resume-pdf-font-size, 12px);
  line-height: var(--resume-pdf-line-height, 1.62);
}

/* 让打印简历视图跟随主题变量，预览与导出在颜色/字体上保持一致 */
.preview-sheet :deep(.rpv-print-root) {
  color: var(--resume-pdf-text);
  font-family: var(--resume-pdf-font-family);
  font-size: var(--resume-pdf-font-size);
  line-height: var(--resume-pdf-line-height);
  background: var(--resume-pdf-background);
}

.preview-sheet :deep(.rpv-page-header) {
  border-bottom-color: var(--resume-pdf-border);
}

.preview-sheet :deep(.rpv-page-header__name) {
  color: var(--resume-pdf-secondary);
}

.preview-sheet :deep(.rpv-page-header__role),
.preview-sheet :deep(.rpv-page-number),
.preview-sheet :deep(.rpv-section-hint),
.preview-sheet :deep(.rpv-entry-meta) {
  color: var(--resume-pdf-muted);
}

.preview-sheet :deep(.rpv-section-title) {
  color: var(--resume-pdf-primary);
}

.preview-sheet :deep(.rpv-tag),
.preview-sheet :deep(.rpv-meta-item) {
  background: var(--resume-pdf-primary-soft);
  color: var(--resume-pdf-accent-text);
}

.preview-pane-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}
</style>
