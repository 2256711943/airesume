import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESUME_PDF_TEMPLATE_ID,
  DEFAULT_RESUME_PDF_THEME_ID,
  RESUME_PDF_TEMPLATE_IDS,
  RESUME_PDF_THEME_IDS,
  buildResumePdfThemeCssVariables,
  getResumePdfTemplate,
  getResumePdfTheme,
  resolveResumePdfDesignSelection,
} from "./resume-pdf-design";

describe("resume pdf design", () => {
  it("exposes default template and theme ids", () => {
    expect(DEFAULT_RESUME_PDF_TEMPLATE_ID).toBe("classic-single");
    expect(DEFAULT_RESUME_PDF_THEME_ID).toBe("ocean-blue");
    expect(RESUME_PDF_TEMPLATE_IDS).toContain("classic-single");
    expect(RESUME_PDF_THEME_IDS).toContain("ocean-blue");
  });

  it("resolves fallback template and theme definitions", () => {
    expect(getResumePdfTemplate("missing").id).toBe("classic-single");
    expect(getResumePdfTheme("missing").id).toBe("ocean-blue");
  });

  it("builds a normalized selection", () => {
    expect(
      resolveResumePdfDesignSelection("compact-executive", "warm-emerald"),
    ).toEqual({
      templateId: "compact-executive",
      templateVersion: "2026.08.07",
      themeId: "warm-emerald",
      themeVersion: "2026.08.07",
    });
  });

  it("serializes css variables for the theme", () => {
    expect(
      buildResumePdfThemeCssVariables(getResumePdfTheme("slate-gray")),
    ).toContain("--resume-pdf-primary:#334155;");
  });
});
