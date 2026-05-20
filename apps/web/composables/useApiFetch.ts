const API_BASE_URL = 'http://127.0.0.1:3001';
import { useAuth } from './useAuth';

export async function useApiFetch<T>(path: string, options: Parameters<typeof $fetch<T>>[1] = {}) {
  const { token, clearAuth } = useAuth();

  try {
    return await $fetch<T>(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(token.value ? { Authorization: `Bearer ${token.value}` } : {}),
      },
    });
  } catch (error: unknown) {
    const statusCode = typeof error === 'object' && error && 'statusCode' in error
      ? Number(error.statusCode)
      : undefined;

    if (statusCode === 401) {
      clearAuth();
    }

    throw error;
  }
}
