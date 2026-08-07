import { computed } from "vue";
import { $fetch } from "ofetch";
import { API_BASE_URL } from "../utils/api";
import {
  persistStoredToken,
  readStoredToken as readStoredTokenFromStorage,
} from "../utils/auth";

interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

/**
 * 模拟登录（本地体验模式）使用的 token 前缀，
 * 用于区分真实后端 JWT 与本地演示身份。
 */
const MOCK_TOKEN_PREFIX = "mock-";
const MOCK_USER_STORAGE_KEY = "aitext_mock_user";

export function useAuth() {
  const token = useState<string | null>("auth-token", () => null);
  const user = useState<AuthUser | null>("auth-user", () => null);
  const initialized = useState<boolean>("auth-initialized", () => false);

  const readMockUser = (): AuthUser | null => {
    if (typeof localStorage === "undefined") {
      return null;
    }

    const rawValue = localStorage.getItem(MOCK_USER_STORAGE_KEY);
    if (!rawValue) {
      return null;
    }

    try {
      return JSON.parse(rawValue) as AuthUser;
    } catch {
      return null;
    }
  };

  const readToken = () => {
    return typeof localStorage === "undefined"
      ? null
      : readStoredTokenFromStorage(localStorage);
  };

  const persistToken = (value: string | null) => {
    persistStoredToken(
      typeof localStorage === "undefined" ? undefined : localStorage,
      value,
    );
  };

  const clearAuth = () => {
    token.value = null;
    user.value = null;
    persistToken(null);
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(MOCK_USER_STORAGE_KEY);
    }
  };

  const fetchMe = async () => {
    if (!token.value) {
      user.value = null;
      return null;
    }

    if (token.value.startsWith(MOCK_TOKEN_PREFIX)) {
      // 模拟登录身份直接从本地恢复，不请求后端。
      user.value = readMockUser();
      return user.value;
    }

    try {
      const response = await $fetch<{ data: AuthUser }>(
        `${API_BASE_URL}/auth/me`,
        {
          headers: {
            Authorization: `Bearer ${token.value}`,
          },
        },
      );

      user.value = response.data;
      return response.data;
    } catch {
      clearAuth();
      return null;
    }
  };

  const initAuth = async () => {
    if (initialized.value) {
      return;
    }

    token.value = readToken();
    initialized.value = true;

    if (token.value) {
      await fetchMe();
    }
  };

  const login = async (email: string, password: string) => {
    const response = await $fetch<{ data: LoginResponse }>(
      `${API_BASE_URL}/auth/login`,
      {
        method: "POST",
        body: {
          email,
          password,
        },
      },
    );

    token.value = response.data.accessToken;
    persistToken(token.value);
    await fetchMe();
  };

  /**
   * 模拟登录：不依赖后端，写入本地模拟身份，便于纯前端演示。
   */
  const mockLogin = (username: string) => {
    const name = username.trim() || "体验用户";
    const mockUser: AuthUser = {
      id: "mock-user",
      email: `${name}@mock.local`,
      name,
    };
    const mockToken = `${MOCK_TOKEN_PREFIX}${Date.now().toString(36)}`;

    token.value = mockToken;
    user.value = mockUser;
    persistToken(mockToken);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MOCK_USER_STORAGE_KEY, JSON.stringify(mockUser));
    }
  };

  const isMockAuth = computed(
    () => token.value?.startsWith(MOCK_TOKEN_PREFIX) ?? false,
  );

  const logout = async () => {
    if (token.value) {
      try {
        await $fetch(`${API_BASE_URL}/auth/logout`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.value}`,
          },
        });
      } catch {
        // Ignore logout failures and clear local auth state anyway.
      }
    }

    clearAuth();
  };

  return {
    token,
    user,
    initAuth,
    fetchMe,
    login,
    mockLogin,
    isMockAuth,
    logout,
    clearAuth,
  };
}
