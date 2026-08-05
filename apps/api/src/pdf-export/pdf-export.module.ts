import { Module } from '@nestjs/common';
import { BrowserInstanceManagerService } from './browser-instance-manager.service';
import {
  PdfBrowserLauncher,
  PlaywrightPdfBrowserLauncher,
} from './browser-launcher';
import { buildPdfBrowserManagerConfig } from './pdf-export.config';
import { PDF_BROWSER_MANAGER_CONFIG } from './pdf-export.constants';

/**
 * PDF export infrastructure module.
 */
@Module({
  providers: [
    {
      provide: PDF_BROWSER_MANAGER_CONFIG,
      useFactory: buildPdfBrowserManagerConfig,
    },
    {
      provide: PdfBrowserLauncher,
      useClass: PlaywrightPdfBrowserLauncher,
    },
    BrowserInstanceManagerService,
  ],
  exports: [
    PDF_BROWSER_MANAGER_CONFIG,
    PdfBrowserLauncher,
    BrowserInstanceManagerService,
  ],
})
export class PdfExportModule {}
