import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BrowserInstanceManagerService } from '../pdf-export/browser-instance-manager.service';
import type {
  PdfBrowserSessionLease,
  PdfBrowserSessionRequest,
} from '../pdf-export/pdf-export.types';
import {
  ExportResumePdfDto,
  type ExportResumePdfOptionsDto,
} from './dto/export-resume-pdf.dto';

export interface ResumePdfExportSuccess {
  buffer: Buffer;
  fileName: string;
  pageCount: number;
}

export interface ResumePdfExportErrorBody {
  success: false;
  data: null;
  error: {
    code: string;
    message: string;
  };
  requestId: string;
}

class ResumePdfExportError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ResumePdfExportError';
  }
}

interface RenderPageHandle {
  setContent(
    html: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' },
  ): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  pdf(options: PdfPagePdfOptions): Promise<Uint8Array | Buffer>;
  emulateMediaType?(type: 'screen' | 'print'): Promise<void> | void;
}

interface PdfPagePdfOptions {
  format: 'A4';
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

const HTML_MAX_BYTES = 500 * 1024;
const OPTIONS_MAX_BYTES = 4 * 1024;
const RENDER_TIMEOUT_MS = 45_000;

@Injectable()
export class ResumePdfExportService {
  private readonly logger = new Logger(ResumePdfExportService.name);

  constructor(
    private readonly browserInstanceManager: BrowserInstanceManagerService,
  ) {}

  /**
   * 执行一次简历 PDF 导出，并按契约返回成功结果或领域错误。
   */
  async exportPdf(
    requestId: string,
    rawPayload: unknown,
    userId?: string,
  ): Promise<ResumePdfExportSuccess> {
    const dto = this.parsePayload(rawPayload);
    const html = dto.html.trim();
    this.logger.log(
      `PDF export start requestId=${requestId} userId=${userId ?? 'unknown'} htmlBytes=${Buffer.byteLength(html, 'utf8')} fileName=${dto.fileName ?? 'undefined'}`,
    );
    if (html.length === 0) {
      throw new ResumePdfExportError(
        422,
        'PDF_EMPTY_CONTENT',
        'Resume content is empty and cannot be exported',
      );
    }

    if (Buffer.byteLength(html, 'utf8') > HTML_MAX_BYTES) {
      throw new ResumePdfExportError(
        413,
        'PDF_PAYLOAD_TOO_LARGE',
        'Payload is too large to export',
      );
    }

    if (
      Buffer.byteLength(JSON.stringify(dto.options ?? {}), 'utf8') >
      OPTIONS_MAX_BYTES
    ) {
      throw new ResumePdfExportError(
        413,
        'PDF_PAYLOAD_TOO_LARGE',
        'Payload is too large to export',
      );
    }

    const fileName = this.normalizeFileName(dto.fileName);
    const browserRequest: PdfBrowserSessionRequest = {
      requestId,
      purpose: 'resume-export-pdf',
      exportId: fileName,
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await this.browserInstanceManager.withSession(
          browserRequest,
          async (lease) =>
            await this.renderPdf(
              lease,
              html,
              dto.options,
              fileName,
              requestId,
              userId,
            ),
        );
      } catch (error) {
        const mapped = this.mapError(error);
        this.logger.error(
          `PDF export attempt ${attempt} failed requestId=${requestId} code=${mapped.code} status=${mapped.statusCode} error=${this.toErrorMessage(error)}`,
          this.toErrorStack(error),
        );
        if (attempt < 2 && this.isRetriable(mapped.code)) {
          this.logger.warn(
            `PDF export retry requestId=${requestId} attempt=${attempt}`,
          );
          continue;
        }

        throw mapped;
      }
    }

    throw new ResumePdfExportError(
      500,
      'PDF_RENDER_FAILED',
      'Export failed, please retry later',
    );
  }

  /**
   * 将导出异常规整为控制器可直接返回的 JSON 错误响应。
   */
  formatErrorResponse(
    requestId: string,
    error: unknown,
  ): { statusCode: number; body: ResumePdfExportErrorBody } {
    const mapped = this.mapError(error);
    return {
      statusCode: mapped.statusCode,
      body: {
        success: false,
        data: null,
        error: {
          code: mapped.code,
          message: mapped.message,
        },
        requestId,
      },
    };
  }

  private parsePayload(rawPayload: unknown): ExportResumePdfDto {
    const dto = plainToInstance(ExportResumePdfDto, rawPayload ?? {});
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });

    if (errors.length > 0) {
      throw new ResumePdfExportError(
        400,
        'PDF_INVALID_INPUT',
        'Invalid export payload, please refresh and retry',
      );
    }

    return dto;
  }

  private async renderPdf(
    lease: PdfBrowserSessionLease,
    html: string,
    options: ExportResumePdfOptionsDto,
    fileName: string,
    requestId: string,
    userId?: string,
  ): Promise<ResumePdfExportSuccess> {
    const page = this.resolvePageHandle(lease);
    const renderOptions = this.normalizeRenderOptions(options);
    this.logger.debug(
      `PDF render start requestId=${requestId} options=${JSON.stringify(renderOptions)}`,
    );

    const renderResult = await this.runWithTimeout(async () => {
      this.logger.debug(`PDF setContent start requestId=${requestId}`);
      await page.setContent(html, { waitUntil: 'load' });
      this.logger.debug(`PDF setContent done requestId=${requestId}`);

      await this.waitForFonts(page);
      this.logger.debug(`PDF fonts ready requestId=${requestId}`);

      if (page.emulateMediaType) {
        await page.emulateMediaType('print');
      }

      this.logger.debug(`PDF generate start requestId=${requestId}`);
      const pdf = await page.pdf(renderOptions);
      this.logger.debug(`PDF generate done requestId=${requestId}`);
      const buffer = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      return {
        buffer,
        pageCount: this.estimatePageCount(buffer),
      };
    }, RENDER_TIMEOUT_MS);

    this.logger.log(
      `PDF export finished requestId=${requestId} userId=${userId ?? 'unknown'} pages=${renderResult.pageCount}`,
    );

    return {
      buffer: renderResult.buffer,
      pageCount: renderResult.pageCount,
      fileName,
    };
  }

  private resolvePageHandle(lease: PdfBrowserSessionLease): RenderPageHandle {
    if (!lease.session.page) {
      throw new ResumePdfExportError(
        503,
        'PDF_BROWSER_UNAVAILABLE',
        'Export service is busy, please retry later',
      );
    }

    return lease.session.page as RenderPageHandle;
  }

  private normalizeRenderOptions(
    options: ExportResumePdfOptionsDto,
  ): PdfPagePdfOptions {
    return {
      format: 'A4',
      margin: {
        top: options.margin?.top ?? '20px',
        right: options.margin?.right ?? '20px',
        bottom: options.margin?.bottom ?? '20px',
        left: options.margin?.left ?? '20px',
      },
      printBackground: options.printBackground ?? true,
      preferCSSPageSize: options.preferCSSPageSize ?? true,
      displayHeaderFooter: options.displayHeaderFooter ?? false,
      headerTemplate: options.headerTemplate ?? '',
      footerTemplate: options.footerTemplate ?? '',
    };
  }

  private normalizeFileName(fileName: string | undefined): string {
    const fallback = `resume-${Date.now()}`;
    const raw = fileName?.trim() || fallback;
    return raw
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }

  private async waitForFonts(page: RenderPageHandle): Promise<void> {
    try {
      await this.runWithTimeout(async () => {
        await page.evaluate(async () => {
          const fonts = (
            globalThis as {
              document?: { fonts?: { ready?: Promise<unknown> } };
            }
          ).document?.fonts;
          if (fonts?.ready) {
            await fonts.ready;
          }
        });
      }, 10_000);
    } catch (error) {
      this.logger.warn(
        `PDF font wait failed: ${this.toErrorMessage(error)}`,
        this.toErrorStack(error),
      );
      throw new ResumePdfExportError(
        422,
        'PDF_FONT_NOT_READY',
        'Font loading failed, please retry',
      );
    }
  }

  private estimatePageCount(buffer: Buffer): number {
    const text = buffer.toString('latin1');
    const matches = text.match(/\/Type\s*\/Page\b/g);
    return Math.max(1, matches?.length ?? 1);
  }

  private async runWithTimeout<T>(
    task: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new ResumePdfExportError(
            504,
            'PDF_RENDER_TIMEOUT',
            'PDF render timed out, please retry',
          ),
        );
      }, timeoutMs);

      task()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(
            error instanceof Error
              ? error
              : new Error(this.toErrorMessage(error)),
          );
        });
    });
  }

  private mapError(error: unknown): ResumePdfExportError {
    if (error instanceof ResumePdfExportError) {
      return error;
    }

    const message = this.toErrorMessage(error);
    if (message.includes('PDF_INVALID_INPUT')) {
      return new ResumePdfExportError(
        400,
        'PDF_INVALID_INPUT',
        'Invalid export payload, please refresh and retry',
      );
    }

    if (message.includes('PDF_PAYLOAD_TOO_LARGE')) {
      return new ResumePdfExportError(
        413,
        'PDF_PAYLOAD_TOO_LARGE',
        'Payload is too large to export',
      );
    }

    if (message.includes('PDF_EMPTY_CONTENT')) {
      return new ResumePdfExportError(
        422,
        'PDF_EMPTY_CONTENT',
        'Resume content is empty and cannot be exported',
      );
    }

    if (
      message.includes('PDF_BROWSER_UNAVAILABLE') ||
      message.includes('PDF_BROWSER_LAUNCH_TIMEOUT') ||
      message.includes('PDF_BROWSER_SESSION_POOL_EXHAUSTED')
    ) {
      return new ResumePdfExportError(
        503,
        'PDF_BROWSER_UNAVAILABLE',
        'Export service is busy, please retry later',
      );
    }

    if (message.includes('PDF_RENDER_TIMEOUT')) {
      return new ResumePdfExportError(
        504,
        'PDF_RENDER_TIMEOUT',
        'PDF render timed out, please retry',
      );
    }

    if (message.includes('PDF_FONT_NOT_READY')) {
      return new ResumePdfExportError(
        422,
        'PDF_FONT_NOT_READY',
        'Font loading failed, please retry',
      );
    }

    return new ResumePdfExportError(
      500,
      'PDF_RENDER_FAILED',
      'Export failed, please retry later',
    );
  }

  private isRetriable(code: string): boolean {
    return code === 'PDF_RENDER_TIMEOUT' || code === 'PDF_FONT_NOT_READY';
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    if (typeof error === 'string') {
      return error;
    }

    return 'UNKNOWN_ERROR';
  }

  /**
   * 提取错误的调用堆栈，便于日志定位根因。
   *
   * @param error 原始错误
   * @returns 堆栈文本；不可用时返回空字符串
   */
  private toErrorStack(error: unknown): string | undefined {
    return error instanceof Error ? error.stack : undefined;
  }
}
