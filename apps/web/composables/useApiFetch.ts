import { $fetch } from 'ofetch';
import { createAuthHeaders, getStatusCode } from '../utils/auth';
import { useAuth } from './useAuth';

const API_BASE_URL = 'http://127.0.0.1:3001';

export async function useApiFetch<T>(path: string, options: Parameters<typeof $fetch<T>>[1] = {}) {
  const { token, clearAuth } = useAuth();

  try {
    const headers = new Headers(options.headers as HeadersInit | undefined);
    const authHeaders = createAuthHeaders(token.value);
    Object.entries(authHeaders).forEach(([key, value]) => {
      headers.set(key, value);
    });

    return await $fetch<T>(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
    });
  } catch (error: unknown) {
    const statusCode = getStatusCode(error);

    if (statusCode === 401) {
      clearAuth();
    }

    throw error;
  }
}
