import { Module } from '@nestjs/common';
import { BrowserInstanceManagerService } from '../../pdf-export/browser-instance-manager.service';
import { PdfExportModule } from '../../pdf-export/pdf-export.module';
import { WEB_SEARCH_TOOL } from '../../resume/web-search-tool.interface';
import { ChatWebToolExecutor } from './chat-web-tool-executor';
import { WebBrowserToolService } from './web-browser-tool.service';
import { MockWebSearchTool } from './web-search-tool.mock';
import { WebUrlSecurity } from './web-url-security.util';

/**
 * Chat 联网工具模块（Phase 2）。
 *
 * 提供：
 * - `WEB_SEARCH_TOOL` 的 Mock 实现（真实服务商接入时替换 provider 即可）；
 * - `WebBrowserToolService`：`web_browser` 正文抓取，复用 pdf-export 浏览器实例；
 * - `ChatWebToolExecutor`：工具调用路由与参数校验，供 Phase 3 Agent tool loop 注入。
 *
 * 注：`WebUrlSecurity` / `WebBrowserToolService` 的构造函数含默认参数，
 * 使用 useFactory 显式构造，避免被 Nest 当作 DI 依赖解析。
 */
@Module({
  imports: [PdfExportModule],
  providers: [
    {
      provide: WebUrlSecurity,
      useFactory: (): WebUrlSecurity => new WebUrlSecurity(),
    },
    {
      provide: WEB_SEARCH_TOOL,
      useClass: MockWebSearchTool,
    },
    {
      provide: WebBrowserToolService,
      useFactory: (
        manager: BrowserInstanceManagerService,
        urlSecurity: WebUrlSecurity,
      ): WebBrowserToolService =>
        new WebBrowserToolService(manager, urlSecurity),
      inject: [BrowserInstanceManagerService, WebUrlSecurity],
    },
    ChatWebToolExecutor,
  ],
  exports: [ChatWebToolExecutor, WEB_SEARCH_TOOL, WebBrowserToolService],
})
export class ChatWebToolsModule {}
