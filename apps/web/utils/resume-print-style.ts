/**
 * 打印简历视图的样式基线常量，后续由组件根节点内联为 `<style>` 使用。
 */
export const RESUME_PRINT_STYLE_CLASS = {
  root: "rpv-print-root",
  page: "rpv-page",
  header: "rpv-page-header",
  footer: "rpv-page-footer",
  headerName: "rpv-page-header__name",
  headerRole: "rpv-page-header__role",
  pageNumber: "rpv-page-number",
  section: "rpv-section",
  sectionTitle: "rpv-section-title",
  sectionHint: "rpv-section-hint",
  summary: "rpv-summary",
  summaryText: "rpv-summary-text",
  meta: "rpv-meta",
  metaItem: "rpv-meta-item",
  list: "rpv-list",
  listItem: "rpv-list-item",
  entry: "rpv-entry",
  entryTitle: "rpv-entry-title",
  entryMeta: "rpv-entry-meta",
  entryBody: "rpv-entry-body",
  tagList: "rpv-tag-list",
  tag: "rpv-tag",
  divider: "rpv-divider",
  avoidBreak: "rpv-avoid-break",
  pageBreak: "rpv-page-break",
  muted: "rpv-muted",
} as const;

export const RESUME_PRINT_PAGE_SIZE = "A4";
export const RESUME_PRINT_PAGE_MARGIN = "20px";
export const RESUME_PRINT_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export const RESUME_PRINT_STYLE_BASELINE = String.raw`
@page {
  size: ${RESUME_PRINT_PAGE_SIZE};
  margin: ${RESUME_PRINT_PAGE_MARGIN};
}

.${RESUME_PRINT_STYLE_CLASS.root} {
  box-sizing: border-box;
  width: 100%;
  color: #1f2a44;
  background: #ffffff;
  font-family: ${RESUME_PRINT_FONT_FAMILY};
  font-size: 12px;
  line-height: 1.5;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.${RESUME_PRINT_STYLE_CLASS.root},
.${RESUME_PRINT_STYLE_CLASS.root} * {
  box-sizing: border-box;
}

.${RESUME_PRINT_STYLE_CLASS.root} h1,
.${RESUME_PRINT_STYLE_CLASS.root} h2,
.${RESUME_PRINT_STYLE_CLASS.root} h3,
.${RESUME_PRINT_STYLE_CLASS.root} p {
  margin: 0;
}

.${RESUME_PRINT_STYLE_CLASS.root} a {
  color: inherit;
  text-decoration: none;
}

.${RESUME_PRINT_STYLE_CLASS.root} img {
  max-width: 100%;
  display: block;
}

.${RESUME_PRINT_STYLE_CLASS.root} ul,
.${RESUME_PRINT_STYLE_CLASS.root} ol {
  margin: 0;
  padding-left: 18px;
}

.${RESUME_PRINT_STYLE_CLASS.root} li {
  margin: 0;
  break-inside: avoid;
  page-break-inside: avoid;
}

.${RESUME_PRINT_STYLE_CLASS.page} {
  display: grid;
  gap: 16px;
  padding: 0;
}

.${RESUME_PRINT_STYLE_CLASS.header},
.${RESUME_PRINT_STYLE_CLASS.footer} {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.${RESUME_PRINT_STYLE_CLASS.header} {
  padding-bottom: 10px;
  border-bottom: 1px solid #dfe5f1;
}

.${RESUME_PRINT_STYLE_CLASS.footer} {
  padding-top: 10px;
  border-top: 1px solid #dfe5f1;
}

.${RESUME_PRINT_STYLE_CLASS.headerName} {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.${RESUME_PRINT_STYLE_CLASS.headerRole} {
  color: #5f6880;
  font-size: 12px;
  font-weight: 600;
}

.${RESUME_PRINT_STYLE_CLASS.pageNumber} {
  min-width: 48px;
  text-align: right;
  color: #667085;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.${RESUME_PRINT_STYLE_CLASS.section} {
  display: grid;
  gap: 10px;
}

.${RESUME_PRINT_STYLE_CLASS.sectionTitle} {
  color: #1f2a44;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.${RESUME_PRINT_STYLE_CLASS.sectionHint} {
  color: #667085;
  font-size: 11px;
  line-height: 1.4;
}

.${RESUME_PRINT_STYLE_CLASS.summary} {
  display: grid;
  gap: 6px;
}

.${RESUME_PRINT_STYLE_CLASS.summaryText} {
  color: #334155;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.${RESUME_PRINT_STYLE_CLASS.meta} {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.${RESUME_PRINT_STYLE_CLASS.metaItem} {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 11px;
  font-weight: 700;
}

.${RESUME_PRINT_STYLE_CLASS.list} {
  display: grid;
  gap: 8px;
}

.${RESUME_PRINT_STYLE_CLASS.listItem} {
  break-inside: avoid;
  page-break-inside: avoid;
}

.${RESUME_PRINT_STYLE_CLASS.entry} {
  display: grid;
  gap: 6px;
  padding: 10px 0;
  break-inside: avoid;
  page-break-inside: avoid;
}

.${RESUME_PRINT_STYLE_CLASS.entryTitle} {
  color: #1f2a44;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.5;
}

.${RESUME_PRINT_STYLE_CLASS.entryMeta} {
  color: #667085;
  font-size: 11px;
  line-height: 1.5;
}

.${RESUME_PRINT_STYLE_CLASS.entryBody} {
  color: #455164;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.${RESUME_PRINT_STYLE_CLASS.tagList} {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.${RESUME_PRINT_STYLE_CLASS.tag} {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: #eef2ff;
  color: #355bff;
  font-size: 11px;
  font-weight: 700;
}

.${RESUME_PRINT_STYLE_CLASS.divider} {
  height: 1px;
  background: #e5ebf7;
}

.${RESUME_PRINT_STYLE_CLASS.avoidBreak} {
  break-inside: avoid;
  page-break-inside: avoid;
}

.${RESUME_PRINT_STYLE_CLASS.pageBreak} {
  break-before: page;
  page-break-before: always;
}

.${RESUME_PRINT_STYLE_CLASS.muted} {
  color: #667085;
}

@media print {
  .${RESUME_PRINT_STYLE_CLASS.root} {
    background: #ffffff;
  }
}
`;
