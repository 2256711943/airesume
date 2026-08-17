export type ResumePdfPageSize = "A4";

export interface ResumePdfPageMargin {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

export interface ResumePdfTemplateSection {
  slot: "header" | "summary" | "experience" | "projects" | "skills" | "footer";
  order: number;
  label: string;
}

export interface ResumePdfTemplateDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  previewLabel: string;
  pageSize: ResumePdfPageSize;
  margin: ResumePdfPageMargin;
  columns: 1 | 2;
  sectionOrder: ResumePdfTemplateSection[];
  typography: {
    fontFamily: string[];
    baseFontSize: number;
    lineHeight: number;
    headingScale: number;
  };
  layout: {
    accentPlacement: "top-rule" | "left-rail" | "header-band";
    contentDensity: "comfortable" | "balanced" | "compact";
  };
}

export interface ResumePdfThemeTokens {
  primary: string;
  primarySoft: string;
  secondary: string;
  text: string;
  muted: string;
  border: string;
  background: string;
  surface: string;
  surfaceSoft: string;
  accentText: string;
}

export interface ResumePdfThemeDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  previewLabel: string;
  tokens: ResumePdfThemeTokens;
  typography: {
    fontFamily: string[];
    baseFontSize: number;
    lineHeight: number;
  };
  effects: {
    borderRadius: string;
    borderWidth: string;
    shadow: string;
    spacingScale: number;
  };
}

export interface ResumePdfDesignSelection {
  templateId: string;
  templateVersion: string;
  themeId: string;
  themeVersion: string;
}

export const RESUME_PDF_TEMPLATE_VERSION = "2026.08.07";
export const RESUME_PDF_THEME_VERSION = "2026.08.07";

export const RESUME_PDF_TEMPLATES: ResumePdfTemplateDefinition[] = [
  {
    id: "classic-single",
    version: RESUME_PDF_TEMPLATE_VERSION,
    name: "经典单栏",
    description: "适合通用求职场景的单栏排版，信息密度均衡。",
    previewLabel: "Classic",
    pageSize: "A4",
    margin: { top: "18px", right: "18px", bottom: "18px", left: "18px" },
    columns: 1,
    sectionOrder: [
      { slot: "header", order: 1, label: "标题区" },
      { slot: "summary", order: 2, label: "个人总结" },
      { slot: "experience", order: 3, label: "工作经历" },
      { slot: "projects", order: 4, label: "项目经历" },
      { slot: "skills", order: 5, label: "核心技能" },
      { slot: "footer", order: 6, label: "页脚" },
    ],
    typography: {
      fontFamily: ["Inter", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      baseFontSize: 12,
      lineHeight: 1.62,
      headingScale: 1.12,
    },
    layout: {
      accentPlacement: "top-rule",
      contentDensity: "balanced",
    },
  },
  {
    id: "editorial-two-column",
    version: RESUME_PDF_TEMPLATE_VERSION,
    name: "编辑风双栏",
    description: "左侧摘要与技能，右侧经历与项目，适合重点突出能力。",
    previewLabel: "Editorial",
    pageSize: "A4",
    margin: { top: "16px", right: "16px", bottom: "16px", left: "16px" },
    columns: 2,
    sectionOrder: [
      { slot: "header", order: 1, label: "标题区" },
      { slot: "summary", order: 2, label: "个人总结" },
      { slot: "skills", order: 3, label: "核心技能" },
      { slot: "experience", order: 4, label: "工作经历" },
      { slot: "projects", order: 5, label: "项目经历" },
      { slot: "footer", order: 6, label: "页脚" },
    ],
    typography: {
      fontFamily: ["Inter", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      baseFontSize: 11.5,
      lineHeight: 1.56,
      headingScale: 1.08,
    },
    layout: {
      accentPlacement: "left-rail",
      contentDensity: "comfortable",
    },
  },
  {
    id: "compact-executive",
    version: RESUME_PDF_TEMPLATE_VERSION,
    name: "紧凑执行版",
    description: "更高信息密度的排版，适合内容较多的资深候选人。",
    previewLabel: "Compact",
    pageSize: "A4",
    margin: { top: "14px", right: "14px", bottom: "14px", left: "14px" },
    columns: 1,
    sectionOrder: [
      { slot: "header", order: 1, label: "标题区" },
      { slot: "experience", order: 2, label: "工作经历" },
      { slot: "projects", order: 3, label: "项目经历" },
      { slot: "summary", order: 4, label: "个人总结" },
      { slot: "skills", order: 5, label: "核心技能" },
      { slot: "footer", order: 6, label: "页脚" },
    ],
    typography: {
      fontFamily: ["Inter", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      baseFontSize: 11.5,
      lineHeight: 1.5,
      headingScale: 1.06,
    },
    layout: {
      accentPlacement: "header-band",
      contentDensity: "compact",
    },
  },
];

export const RESUME_PDF_THEMES: ResumePdfThemeDefinition[] = [
  {
    id: "ocean-blue",
    version: RESUME_PDF_THEME_VERSION,
    name: "海洋蓝",
    description: "清爽理性，适合技术与通用求职场景。",
    previewLabel: "Ocean",
    tokens: {
      primary: "#2f5cff",
      primarySoft: "#e8efff",
      secondary: "#0f172a",
      text: "#111827",
      muted: "#5b6475",
      border: "#dbe2f0",
      background: "#ffffff",
      surface: "#f8fbff",
      surfaceSoft: "#eef4ff",
      accentText: "#0e7490",
    },
    typography: {
      fontFamily: ["Inter", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      baseFontSize: 12,
      lineHeight: 1.62,
    },
    effects: {
      borderRadius: "14px",
      borderWidth: "1px",
      shadow: "0 8px 24px rgba(15, 23, 42, 0.06)",
      spacingScale: 1,
    },
  },
  {
    id: "slate-gray",
    version: RESUME_PDF_THEME_VERSION,
    name: "石墨灰",
    description: "克制专业，适合管理、运营和商务岗位。",
    previewLabel: "Slate",
    tokens: {
      primary: "#334155",
      primarySoft: "#e8ecf1",
      secondary: "#111827",
      text: "#0f172a",
      muted: "#64748b",
      border: "#d9e0ea",
      background: "#ffffff",
      surface: "#fbfcfd",
      surfaceSoft: "#f3f6f9",
      accentText: "#1f2937",
    },
    typography: {
      fontFamily: [
        "Source Han Sans SC",
        "PingFang SC",
        "Microsoft YaHei",
        "sans-serif",
      ],
      baseFontSize: 12,
      lineHeight: 1.6,
    },
    effects: {
      borderRadius: "12px",
      borderWidth: "1px",
      shadow: "0 6px 20px rgba(15, 23, 42, 0.05)",
      spacingScale: 0.96,
    },
  },
  {
    id: "warm-emerald",
    version: RESUME_PDF_THEME_VERSION,
    name: "暖绿",
    description: "更具亲和力，适合产品、设计与内容岗位。",
    previewLabel: "Warm",
    tokens: {
      primary: "#0f9d7a",
      primarySoft: "#e7f7f2",
      secondary: "#0f172a",
      text: "#1f2937",
      muted: "#667085",
      border: "#d8e3de",
      background: "#ffffff",
      surface: "#f9fdfb",
      surfaceSoft: "#eefaf6",
      accentText: "#047857",
    },
    typography: {
      fontFamily: ["Inter", "PingFang SC", "Microsoft YaHei", "sans-serif"],
      baseFontSize: 12,
      lineHeight: 1.64,
    },
    effects: {
      borderRadius: "16px",
      borderWidth: "1px",
      shadow: "0 10px 24px rgba(15, 118, 110, 0.08)",
      spacingScale: 1.02,
    },
  },
];

export const DEFAULT_RESUME_PDF_TEMPLATE_ID =
  RESUME_PDF_TEMPLATES[0]?.id ?? "classic-single";
export const DEFAULT_RESUME_PDF_THEME_ID =
  RESUME_PDF_THEMES[0]?.id ?? "ocean-blue";

export const RESUME_PDF_TEMPLATE_IDS = RESUME_PDF_TEMPLATES.map(
  (template) => template.id,
);

export const RESUME_PDF_THEME_IDS = RESUME_PDF_THEMES.map((theme) => theme.id);

export function getResumePdfTemplate(
  templateId: string | null | undefined,
): ResumePdfTemplateDefinition {
  return (
    RESUME_PDF_TEMPLATES.find((template) => template.id === templateId) ??
    RESUME_PDF_TEMPLATES[0]!
  );
}

export function getResumePdfTheme(
  themeId: string | null | undefined,
): ResumePdfThemeDefinition {
  return (
    RESUME_PDF_THEMES.find((theme) => theme.id === themeId) ??
    RESUME_PDF_THEMES[0]!
  );
}

export function resolveResumePdfDesignSelection(
  templateId?: string | null,
  themeId?: string | null,
): ResumePdfDesignSelection {
  const template = getResumePdfTemplate(templateId);
  const theme = getResumePdfTheme(themeId);

  return {
    templateId: template.id,
    templateVersion: template.version,
    themeId: theme.id,
    themeVersion: theme.version,
  };
}

export function buildResumePdfThemeCssVariables(
  theme: ResumePdfThemeDefinition,
): string {
  const { tokens, typography, effects } = theme;
  const fontFamily = typography.fontFamily
    .map((family) =>
      family.includes(" ") ? `"${family.replaceAll('"', '\\"')}"` : family,
    )
    .join(", ");

  return [
    `--resume-pdf-primary:${tokens.primary};`,
    `--resume-pdf-primary-soft:${tokens.primarySoft};`,
    `--resume-pdf-secondary:${tokens.secondary};`,
    `--resume-pdf-text:${tokens.text};`,
    `--resume-pdf-muted:${tokens.muted};`,
    `--resume-pdf-border:${tokens.border};`,
    `--resume-pdf-background:${tokens.background};`,
    `--resume-pdf-surface:${tokens.surface};`,
    `--resume-pdf-surface-soft:${tokens.surfaceSoft};`,
    `--resume-pdf-accent-text:${tokens.accentText};`,
    `--resume-pdf-font-family:${fontFamily};`,
    `--resume-pdf-font-size:${typography.baseFontSize}px;`,
    `--resume-pdf-line-height:${typography.lineHeight};`,
    `--resume-pdf-radius:${effects.borderRadius};`,
    `--resume-pdf-border-width:${effects.borderWidth};`,
    `--resume-pdf-shadow:${effects.shadow};`,
  ].join("");
}
