import { describe, expect, it } from 'vitest';

import {
  createAuthHeaders,
  getStatusCode,
  persistStoredToken,
  readStoredToken,
  TOKEN_KEY,
} from './auth';

describe('auth utils', () => {
  it('creates bearer auth headers only when token exists', () => {
    expect(createAuthHeaders(null)).toEqual({});
    expect(createAuthHeaders('abc123')).toEqual({
      Authorization: 'Bearer abc123',
    });
  });

  it('extracts numeric status codes from error objects', () => {
    expect(getStatusCode({ statusCode: 401 })).toBe(401);
    expect(getStatusCode({ statusCode: '403' })).toBe(403);
    expect(getStatusCode(new Error('boom'))).toBeUndefined();
  });

  it('reads and persists tokens in storage', () => {
    const storage = {
      values: new Map<string, string>(),
      getItem(key: string) {
        return this.values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        this.values.set(key, value);
      },
      removeItem(key: string) {
        this.values.delete(key);
      },
    };

    expect(readStoredToken(storage)).toBeNull();

    persistStoredToken(storage, 'token-1');
    expect(storage.values.get(TOKEN_KEY)).toBe('token-1');
    expect(readStoredToken(storage)).toBe('token-1');

    persistStoredToken(storage, null);
    expect(storage.values.has(TOKEN_KEY)).toBe(false);
  });
});
