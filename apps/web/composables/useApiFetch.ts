import { $fetch } from "ofetch";
import { API_BASE_URL } from "../utils/api";
import { createAuthHeaders, getStatusCode } from "../utils/auth";
import { useAuth } from "./useAuth";

export async function useApiFetch<T>(
  path: string,
  options: Parameters<typeof $fetch<T>>[1] = {},
) {
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
