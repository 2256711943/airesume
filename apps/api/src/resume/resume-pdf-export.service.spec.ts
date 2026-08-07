import { ResumePdfExportService } from './resume-pdf-export.service';
import type { BrowserInstanceManagerService } from '../pdf-export/browser-instance-manager.service';
import type {
  PdfBrowserSessionLease,
  PdfBrowserSessionRequest,
} from '../pdf-export/pdf-export.types';

interface FakePdfOptions {
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

class FakePage {
  readonly setContentCalls: Array<{
    html: string;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  }> = [];
  readonly pdfCalls: FakePdfOptions[] = [];
  readonly mediaTypes: Array<'screen' | 'print'> = [];
  evaluateError: Error | null = null;
  pdfResult: Buffer = Buffer.from('/Type /Page /Type /Page', 'latin1');

  setContent(
    html: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' },
  ): Promise<void> {
    this.setContentCalls.push({ html, waitUntil: options?.waitUntil });
    return Promise.resolve();
  }

  evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
    void fn;
    if (this.evaluateError) {
      return Promise.reject(this.evaluateError);
    }

    return Promise.resolve(undefined as T);
  }

  pdf(options: FakePdfOptions): Promise<Buffer> {
    this.pdfCalls.push(options);
    return Promise.resolve(this.pdfResult);
  }

  emulateMediaType(type: 'screen' | 'print'): Promise<void> {
    this.mediaTypes.push(type);
    return Promise.resolve();
  }
}

function createLease(page: FakePage): PdfBrowserSessionLease {
  return {
    browserVersion: 'test-browser',
    session: {
      id: 'session-1',
      page,
      close: () => Promise.resolve(),
    },
  };
}

function createService(params?: {
  leases?: PdfBrowserSessionLease[];
  thrownError?: Error;
  requestRecorder?: PdfBrowserSessionRequest[];
}) {
  const leases = [...(params?.leases ?? [])];
  const requests = params?.requestRecorder ?? [];
  const withSession = jest.fn(
    async <T>(
      request: PdfBrowserSessionRequest,
      handler: (lease: PdfBrowserSessionLease) => Promise<T>,
    ): Promise<T> => {
      requests.push(request);
      if (params?.thrownError) {
        throw params.thrownError;
      }

      const lease = leases.shift();
      if (!lease) {
        throw new Error('Missing fake lease');
      }

      return handler(lease);
    },
  );

  return {
    service: new ResumePdfExportService({
      withSession,
    } as unknown as BrowserInstanceManagerService),
    withSession,
  };
}

describe('ResumePdfExportService', () => {
  it('exports pdf successfully with normalized defaults', async () => {
    const page = new FakePage();
    const recordedRequests: PdfBrowserSessionRequest[] = [];
    const { service, withSession } = createService({
      leases: [createLease(page)],
      requestRecorder: recordedRequests,
    });

    const result = await service.exportPdf(
      'req-1',
      {
        html: '  <html><body>resume</body></html>  ',
        fileName: 'resume-tech',
      },
      'user-1',
    );

    expect(result.fileName).toBe('resume-tech');
    expect(result.pageCount).toBe(2);
    expect(page.setContentCalls).toEqual([
      { html: '<html><body>resume</body></html>', waitUntil: 'load' },
    ]);
    expect(page.mediaTypes).toEqual(['print']);
    expect(page.pdfCalls[0]).toEqual({
      format: 'A4',
      margin: {
        top: '20px',
        right: '20px',
        bottom: '20px',
        left: '20px',
      },
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      headerTemplate: '',
      footerTemplate: '',
    });
    expect(withSession).toHaveBeenCalledTimes(1);
    expect(recordedRequests[0]).toMatchObject({
      requestId: 'req-1',
      purpose: 'resume-export-pdf',
      exportId: 'resume-tech',
    });
  });

  it('returns invalid input when payload validation fails', async () => {
    const { service } = createService();

    await expect(service.exportPdf('req-2', {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'PDF_INVALID_INPUT',
    });
  });

  it('retries once when font loading is not ready', async () => {
    const firstPage = new FakePage();
    const secondPage = new FakePage();
    firstPage.evaluateError = new Error('font setup failed');
    const { service, withSession } = createService({
      leases: [createLease(firstPage), createLease(secondPage)],
    });

    const result = await service.exportPdf('req-3', {
      html: '<html><body>resume</body></html>',
    });

    expect(result.pageCount).toBe(2);
    expect(withSession).toHaveBeenCalledTimes(2);
  });

  it('maps browser pool failures to contract error response', () => {
    const { service } = createService();

    const result = service.formatErrorResponse(
      'req-4',
      new Error('PDF_BROWSER_SESSION_POOL_EXHAUSTED'),
    );

    expect(result).toEqual({
      statusCode: 503,
      body: {
        success: false,
        data: null,
        error: {
          code: 'PDF_BROWSER_UNAVAILABLE',
          message: 'Export service is busy, please retry later',
        },
        requestId: 'req-4',
      },
    });
  });

  it('maps timeout failures to contract error response', () => {
    const { service } = createService();

    const result = service.formatErrorResponse(
      'req-5',
      new Error('PDF_RENDER_TIMEOUT'),
    );

    expect(result).toEqual({
      statusCode: 504,
      body: {
        success: false,
        data: null,
        error: {
          code: 'PDF_RENDER_TIMEOUT',
          message: 'PDF render timed out, please retry',
        },
        requestId: 'req-5',
      },
    });
  });
});
