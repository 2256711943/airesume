import type { PdfBrowserManagerConfig } from './pdf-export.types';

/** 默认的最大并发浏览器会话数 */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 2;
/** 默认的会话获取超时时间（毫秒） */
const DEFAULT_SESSION_ACQUIRE_TIMEOUT_MS = 10_000;
/** 默认的浏览器启动超时时间（毫秒） */
const DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
/** 默认的浏览器关闭超时时间（毫秒） */
const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 5_000;
export const RESUME_PDF_TEMPLATE_VERSION = '2026.08.07';
export const RESUME_PDF_THEME_VERSION = '2026.08.07';
export const RESUME_PDF_TEMPLATE_IDS = [
  'classic-single',
  'editorial-two-column',
  'compact-executive',
] as const;
export const RESUME_PDF_THEME_IDS = [
  'ocean-blue',
  'slate-gray',
  'warm-emerald',
] as const;
export const DEFAULT_RESUME_PDF_TEMPLATE_ID = RESUME_PDF_TEMPLATE_IDS[0];
export const DEFAULT_RESUME_PDF_THEME_ID = RESUME_PDF_THEME_IDS[0];

/**
 * 根据环境变量构建 PDF 浏览器管理器配置。
 *
 * 支持通过以下环境变量覆盖默认值：
 * - `PDF_BROWSER_MAX_CONCURRENT_SESSIONS`：最大并发会话数
 * - `PDF_BROWSER_SESSION_ACQUIRE_TIMEOUT_MS`：会话获取超时（毫秒）
 * - `PDF_BROWSER_LAUNCH_TIMEOUT_MS`：浏览器启动超时（毫秒）
 * - `PDF_BROWSER_CLOSE_TIMEOUT_MS`：浏览器关闭超时（毫秒）
 *
 * 当环境变量缺失或取值非法（非正数）时，会回退到对应的默认值。
 *
 * @param env 环境变量对象，默认取 `process.env`
 * @returns 完整的 PDF 浏览器管理器配置
 */
export function buildPdfBrowserManagerConfig(
  env: NodeJS.ProcessEnv = process.env,
): PdfBrowserManagerConfig {
  return {
    maxConcurrentSessions: readPositiveInteger(
      env.PDF_BROWSER_MAX_CONCURRENT_SESSIONS,
      DEFAULT_MAX_CONCURRENT_SESSIONS,
    ),
    sessionAcquireTimeoutMs: readPositiveInteger(
      env.PDF_BROWSER_SESSION_ACQUIRE_TIMEOUT_MS,
      DEFAULT_SESSION_ACQUIRE_TIMEOUT_MS,
    ),
    browserLaunchTimeoutMs: readPositiveInteger(
      env.PDF_BROWSER_LAUNCH_TIMEOUT_MS,
      DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS,
    ),
    browserCloseTimeoutMs: readPositiveInteger(
      env.PDF_BROWSER_CLOSE_TIMEOUT_MS,
      DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
    ),
  };
}

/**
 * 将环境变量的原始字符串解析为合法的正整数。
 *
 * 空值、非数字或非正数时返回 `fallback`；合法值向下取整后返回。
 *
 * @param rawValue 环境变量的原始字符串值
 * @param fallback 解析失败时的回退值
 * @returns 合法的正整数配置值
 */
function readPositiveInteger(
  rawValue: string | undefined,
  fallback: number,
): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}
