/**
 * PDF 浏览器管理器配置的依赖注入令牌（Token）。
 *
 * 用于在 NestJS 依赖注入容器中标识 `PdfBrowserManagerConfig` 配置对象，
 * 以便 `BrowserInstanceManagerService` 通过 `@Inject(PDF_BROWSER_MANAGER_CONFIG)`
 * 注入由 `buildPdfBrowserManagerConfig` 工厂函数生成的配置。
 */
export const PDF_BROWSER_MANAGER_CONFIG = Symbol('PDF_BROWSER_MANAGER_CONFIG');
