import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

import { useResumePdfExport } from "./useResumePdfExport";

/**
 * @param fileName 响应头中的 PDF 文件名。
 * @param pageCount 响应头中的页数。
 * @returns 一个模拟成功导出的响应对象。
 */
function createPdfSuccessResponse(
  fileName = "高级工程师-技术版.pdf",
  pageCount = "2",
): Response {
  const encodedFileName = encodeURIComponent(fileName);
  return new Response(
    new Blob(["%PDF-1.4 mock"], { type: "application/pdf" }),
    {
      status: 200,
      headers: new Headers({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="resume.pdf"; filename*=UTF-8''${encodedFileName}`,
        "X-Pdf-Page-Count": pageCount,
      }),
    },
  );
}

/**
 * @param status 当前 HTTP 状态码。
 * @param code 错误码。
 * @param message 服务端原始消息。
 * @returns 一个模拟失败导出的响应对象。
 */
function createPdfErrorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      data: null,
      error: {
        code,
        message,
      },
      requestId: "req-1",
    }),
    {
      status,
      headers: new Headers({
        "Content-Type": "application/json",
      }),
    },
  );
}

describe("useResumePdfExport", () => {
  it("wraps the print fragment, posts to the PDF endpoint, and triggers download", async () => {
    const fetchFn = vi.fn(async () => createPdfSuccessResponse());
    const downloadBlob = vi.fn();
    const pdfExport = useResumePdfExport({
      token: ref("token-1"),
      clearAuth: vi.fn(),
      fetchFn,
      downloadBlob,
    });

    const result = await pdfExport.exportResumePdf({
      htmlFragment: '<article class="resume">简历内容</article>',
      fileName: "高级工程师-技术版",
      documentTitle: "高级工程师-技术版",
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchFn.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(requestUrl).toBe("http://127.0.0.1:3001/api/resume/export-pdf");
    expect(requestInit.method).toBe("POST");
    expect(requestInit.headers).toMatchObject({
      "Content-Type": "application/json; charset=utf-8",
      Authorization: "Bearer token-1",
    });

    const requestBody = JSON.parse(String(requestInit.body)) as {
      html: string;
      fileName: string;
      options: {
        format: string;
        displayHeaderFooter: boolean;
      };
    };
    expect(requestBody.fileName).toBe("高级工程师-技术版");
    expect(requestBody.html).toContain("<!doctype html>");
    expect(requestBody.html).toContain("@page {");
    expect(requestBody.html).toContain(
      '<article class="resume">简历内容</article>',
    );
    expect(requestBody.options).toMatchObject({
      format: "A4",
      displayHeaderFooter: false,
    });

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(downloadBlob).toHaveBeenCalledWith(
      expect.any(Blob),
      "高级工程师-技术版.pdf",
    );
    expect(result).toEqual({
      fileName: "高级工程师-技术版.pdf",
      pageCount: 2,
    });
    expect(pdfExport.exportingPdf.value).toBe(false);
  });

  it("retries once for retriable backend render errors", async () => {
    const fetchFn = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        createPdfErrorResponse(504, "PDF_RENDER_TIMEOUT", "timed out"),
      )
      .mockResolvedValueOnce(createPdfSuccessResponse("resume.pdf", "3"));
    const downloadBlob = vi.fn();
    const pdfExport = useResumePdfExport({
      token: ref("token-1"),
      clearAuth: vi.fn(),
      fetchFn,
      downloadBlob,
    });

    const result = await pdfExport.exportResumePdf({
      htmlFragment: "<article>retry</article>",
      fileName: "resume",
      documentTitle: "resume",
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(result.pageCount).toBe(3);
  });

  it("clears auth and surfaces an expiration error on 401 responses", async () => {
    const clearAuth = vi.fn();
    const fetchFn = vi.fn(async () =>
      createPdfErrorResponse(401, "AUTH_EXPIRED", "expired"),
    );
    const pdfExport = useResumePdfExport({
      token: ref("token-1"),
      clearAuth,
      fetchFn,
      downloadBlob: vi.fn(),
    });

    await expect(
      pdfExport.exportResumePdf({
        htmlFragment: "<article>unauthorized</article>",
        fileName: "resume",
        documentTitle: "resume",
      }),
    ).rejects.toMatchObject({
      message: "登录状态已过期，请重新登录。",
    });

    expect(clearAuth).toHaveBeenCalledTimes(1);
    expect(pdfExport.exportingPdf.value).toBe(false);
  });
});
