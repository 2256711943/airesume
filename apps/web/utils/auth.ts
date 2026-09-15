export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const TOKEN_KEY = "aitext_access_token";

export function createAuthHeaders(
  token: string | null,
): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) {
    return undefined;
  }

  const statusCode = Number((error as { statusCode?: unknown }).statusCode);
  return Number.isFinite(statusCode) ? statusCode : undefined;
}

export function readStoredToken(storage: TokenStorage | undefined) {
  if (!storage) {
    return null;
  }

  return storage.getItem(TOKEN_KEY);
}

export function persistStoredToken(
  storage: TokenStorage | undefined,
  value: string | null,
) {
  if (!storage) {
    return;
  }

  if (value) {
    storage.setItem(TOKEN_KEY, value);
    return;
  }

  storage.removeItem(TOKEN_KEY);
}
