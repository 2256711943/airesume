import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApiFetch } from "./useApiFetch";

const { fetchMock, clearAuthMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  clearAuthMock: vi.fn(),
}));

vi.mock("ofetch", () => ({
  $fetch: fetchMock,
}));

vi.mock("./useAuth", () => ({
  useAuth: () => ({
    token: { value: "token-123" },
    clearAuth: clearAuthMock,
  }),
}));

describe("useApiFetch", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    clearAuthMock.mockReset();
  });

  it("attaches authorization headers when token exists", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    await useApiFetch("/resume", {
      headers: {
        "X-Request-Id": "req-1",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/resume",
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );

    const [, options] = fetchMock.mock.calls[0] as [
      string,
      { headers: Headers },
    ];
    expect(options.headers.get("X-Request-Id")).toBe("req-1");
    expect(options.headers.get("Authorization")).toBe("Bearer token-123");
  });

  it("clears auth state on 401 responses", async () => {
    fetchMock.mockRejectedValueOnce({ statusCode: 401 });

    await expect(useApiFetch("/auth/me")).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(clearAuthMock).toHaveBeenCalledTimes(1);
  });
});
