import { ref, type Ref } from "vue";

import { API_BASE_URL } from "../utils/api";
import { createAuthHeaders } from "../utils/auth";
import type { ApiEnvelope } from "../utils/resume";
import { RESUME_PRINT_STYLE_BASELINE } from "../utils/resume-print-style";
import {
  DEFAULT_RESUME_PDF_TEMPLATE_ID,
  DEFAULT_RESUME_PDF_THEME_ID,
  resolveResumePdfDesignSelection,
} from "../utils/resume-pdf-design";

const PDF_EXPORT_TIMEOUT_MS = 60_000;
const PDF_EXPORT_RETRIABLE_CODES = new Set([
  "PDF_RENDER_TIMEOUT",
  "PDF_FONT_NOT_READY",
]);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
type DownloadBlobFn = (blob: Blob, fileName: string) => void;

interface ExportResumePdfOptions {
  format: "A4";
  margin: {
    top: string;
    right: string;
    bottom: string;
    left: string;
  };
  printBackground: boolean;
  preferCSSPageSize: boolean;
  displayHeaderFooter: boolean;
  headerTemplate: string;
  footerTemplate: string;
}

interface ExportResumePdfPayload {
  html: string;
  fileName: string;
  templateId: string;
  templateVersion: string;
  themeId: string;
  themeVersion: string;
  options: ExportResumePdfOptions;
}

interface ExportResumePdfErrorEnvelope extends Partial<ApiEnvelope<null>> {
  error?: {
    code?: string;
    message?: string;
  } | null;
}

interface UseResumePdfExportOptions {
  token: Ref<string | null>;
  clearAuth: () => void;
  fetchFn?: FetchFn;
  downloadBlob?: DownloadBlobFn;
  timeoutMs?: number;
}

interface ExportResumePdfParams {
  htmlFragment: string;
  fileName: string;
  documentTitle: string;
  templateId?: string;
  themeId?: string;
}

interface ExportResumePdfResult {
  fileName: string;
  pageCount: number | null;
}

const DEFAULT_EXPORT_OPTIONS: ExportResumePdfOptions = {
  format: "A4",
  margin: {
    top: "20px",
    right: "20px",
    bottom: "20px",
    left: "20px",
  },
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: false,
  headerTemplate: "",
  footerTemplate: "",
};

class ResumePdfExportClientError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResumePdfExportClientError";
  }
}

/**
 * @param value 原始文本。
 * @returns 可安全放入 HTML 文本节点中的转义结果。
 */
function escapeHtmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * @param htmlFragment 打印视图根节点序列化结果。
 * @param documentTitle 当前文档标题。
 * @returns 可直接发送给后端渲染的完整 HTML 文档。
 */
function buildResumePdfDocumentHtml(
  htmlFragment: string,
  documentTitle: string,
): string {
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtmlText(documentTitle)}</title>`,
    `<style>${RESUME_PRINT_STYLE_BASELINE}</style>`,
    "<style>html,body{margin:0;padding:0;background:#ffffff;}body{min-width:0;}</style>",
    "</head>",
    "<body>",
    htmlFragment,
    "</body>",
    "</html>",
  ].join("");
}

/**
 * @param fileName 文件名候选值。
 * @returns 保证带有 `.pdf` 扩展名的文件名。
 */
function ensurePdfExtension(fileName: string): string {
  return /\.pdf$/iu.test(fileName) ? fileName : `${fileName}.pdf`;
}

/**
 * @param disposition `Content-Disposition` 响应头原始值。
 * @returns 解析后的下载文件名；无法解析时返回 `null`。
 */
function parseContentDispositionFileName(
  disposition: string | null,
): string | null {
  if (!disposition) {
    return null;
  }

  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    return ensurePdfExtension(decodeURIComponent(utf8Match[1]));
  }

  const plainMatch = disposition.match(/filename="?([^"]+)"?/iu);
  if (plainMatch?.[1]) {
    return ensurePdfExtension(plainMatch[1]);
  }

  return null;
}

/**
 * @param headers 响应头对象。
 * @returns 解析后的页数；缺失或非法时返回 `null`。
 */
function parsePdfPageCount(headers: Headers): number | null {
  const rawValue = headers.get("X-Pdf-Page-Count");
  if (!rawValue) {
    return null;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.trunc(parsed);
}

/**
 * @param code 服务端返回的 PDF 错误码。
 * @param statusCode 当前 HTTP 状态码。
 * @param fallbackMessage 服务端返回的兜底消息。
 * @returns 面向用户的可读错误文案。
 */
function resolvePdfExportErrorMessage(
  code: string,
  statusCode: number,
  fallbackMessage?: string,
): string {
  const codeMessageMap: Record<string, string> = {
    PDF_INVALID_INPUT: "导出参数有误，请刷新后重试。",
    PDF_PAYLOAD_TOO_LARGE: "当前内容过大，暂时无法导出 PDF。",
    PDF_EMPTY_CONTENT: "当前简历内容为空，无法导出 PDF。",
    PDF_RENDER_TIMEOUT: "PDF 导出超时，请稍后重试。",
    PDF_RENDER_FAILED: "PDF 导出失败，请稍后重试。",
    PDF_FONT_NOT_READY: "打印字体尚未就绪，请稍后重试。",
    PDF_BROWSER_UNAVAILABLE: "导出服务正忙，请稍后再试。",
    PDF_DOWNLOAD_FAILED: "PDF 文件生成失败，请稍后重试。",
  };

  if (codeMessageMap[code]) {
    return codeMessageMap[code];
  }

  if (statusCode === 401) {
    return "登录状态已过期，请重新登录。";
  }

  if (statusCode >= 500) {
    return "PDF 导出失败，请稍后重试。";
  }

  return fallbackMessage?.trim() || "PDF 导出失败，请稍后重试。";
}

/**
 * @param response 当前失败响应对象。
 * @returns 结构化后的客户端错误对象。
 */
async function toPdfExportClientError(
  response: Response,
): Promise<ResumePdfExportClientError> {
  let code = "PDF_EXPORT_REQUEST_FAILED";
  let message = "";

  try {
    const body = (await response.json()) as ExportResumePdfErrorEnvelope;
    code = body.error?.code?.trim() || code;
    message = body.error?.message?.trim() || "";
  } catch {
    code = response.status === 401 ? "AUTH_EXPIRED" : code;
  }

  return new ResumePdfExportClientError(
    response.status,
    code,
    resolvePdfExportErrorMessage(code, response.status, message),
  );
}

/**
 * @param blob 服务端返回的 PDF 二进制数据。
 * @param fileName 触发下载时使用的文件名。
 * @returns 无返回值。
 */
function downloadPdfBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

/**
 * @param task 实际的异步请求任务。
 * @param timeoutMs 超时时长。
 * @returns 请求结果。
 */
async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await task(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ResumePdfExportClientError(
        408,
        "PDF_REQUEST_TIMEOUT",
        "PDF 导出请求超时，请稍后重试。",
      );
    }

    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/**
 * @param options PDF 导出依赖项。
 * @returns 管理导出状态与下载行为的组合式函数集合。
 */
export function useResumePdfExport(options: UseResumePdfExportOptions) {
  const exportingPdf = ref(false);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const downloadBlob = options.downloadBlob ?? downloadPdfBlob;
  const timeoutMs = options.timeoutMs ?? PDF_EXPORT_TIMEOUT_MS;

  /**
   * @param params 当前导出的 HTML 与文件信息。
   * @returns 下载结果摘要，供页面展示状态提示。
   */
  const exportResumePdf = async (
    params: ExportResumePdfParams,
  ): Promise<ExportResumePdfResult> => {
    if (!options.token.value) {
      options.clearAuth();
      throw new ResumePdfExportClientError(
        401,
        "AUTH_EXPIRED",
        "登录状态已过期，请重新登录。",
      );
    }

    if (exportingPdf.value) {
      throw new ResumePdfExportClientError(
        409,
        "PDF_EXPORT_IN_PROGRESS",
        "PDF 正在导出中，请稍候。",
      );
    }

    const payload: ExportResumePdfPayload = {
      html: buildResumePdfDocumentHtml(
        params.htmlFragment,
        params.documentTitle,
      ),
      fileName: params.fileName,
      ...resolveResumePdfDesignSelection(
        params.templateId?.trim() || DEFAULT_RESUME_PDF_TEMPLATE_ID,
        params.themeId?.trim() || DEFAULT_RESUME_PDF_THEME_ID,
      ),
      options: DEFAULT_EXPORT_OPTIONS,
    };

    exportingPdf.value = true;
    const startedAt = Date.now();

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const url = `${API_BASE_URL}/resume/export-pdf`;
        console.debug("[resume-pdf-export] request start", {
          attempt,
          url,
          fileName: params.fileName,
          htmlBytes: new Blob([payload.html]).size,
        });

        const response = await runWithTimeout(
          async (signal) =>
            await fetchFn(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                ...createAuthHeaders(options.token.value),
              },
              body: JSON.stringify(payload),
              signal,
            }),
          timeoutMs,
        );

        console.debug("[resume-pdf-export] request done", {
          attempt,
          status: response.status,
          elapsedMs: Date.now() - startedAt,
        });

        if (response.status === 401) {
          options.clearAuth();
          throw new ResumePdfExportClientError(
            401,
            "AUTH_EXPIRED",
            "登录状态已过期，请重新登录。",
          );
        }

        if (!response.ok) {
          const requestError = await toPdfExportClientError(response);
          console.error("[resume-pdf-export] request failed", {
            attempt,
            status: response.status,
            code: requestError.code,
            message: requestError.message,
            elapsedMs: Date.now() - startedAt,
          });
          if (
            attempt < 2 &&
            PDF_EXPORT_RETRIABLE_CODES.has(requestError.code)
          ) {
            continue;
          }

          throw requestError;
        }

        const pdfBlob = await response.blob();
        const resolvedFileName =
          parseContentDispositionFileName(
            response.headers.get("Content-Disposition"),
          ) ?? ensurePdfExtension(params.fileName);

        console.debug("[resume-pdf-export] download", {
          attempt,
          fileName: resolvedFileName,
          blobBytes: pdfBlob.size,
          pageCount: parsePdfPageCount(response.headers),
          elapsedMs: Date.now() - startedAt,
        });

        downloadBlob(pdfBlob, resolvedFileName);

        return {
          fileName: resolvedFileName,
          pageCount: parsePdfPageCount(response.headers),
        };
      }

      throw new ResumePdfExportClientError(
        500,
        "PDF_RENDER_FAILED",
        "PDF 导出失败，请稍后重试。",
      );
    } catch (error) {
      console.error("[resume-pdf-export] export failed", {
        fileName: params.fileName,
        code:
          error instanceof ResumePdfExportClientError ? error.code : "UNKNOWN",
        statusCode:
          error instanceof ResumePdfExportClientError
            ? error.statusCode
            : undefined,
        message: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    } finally {
      exportingPdf.value = false;
    }
  };

  return {
    exportingPdf,
    exportResumePdf,
  };
}
