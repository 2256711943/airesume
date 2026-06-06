import { $fetch } from 'ofetch';
import { persistStoredToken, readStoredToken as readStoredTokenFromStorage } from '../utils/auth';

interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

const API_BASE_URL = 'http://127.0.0.1:3001';

export function useAuth() {
  const token = useState<string | null>('auth-token', () => null);
  const user = useState<AuthUser | null>('auth-user', () => null);
  const initialized = useState<boolean>('auth-initialized', () => false);

  const readToken = () => {
    return typeof localStorage === 'undefined' ? null : readStoredTokenFromStorage(localStorage);
  };

  const persistToken = (value: string | null) => {
    persistStoredToken(typeof localStorage === 'undefined' ? undefined : localStorage, value);
  };

  const clearAuth = () => {
    token.value = null;
    user.value = null;
    persistToken(null);
  };

  const fetchMe = async () => {
    if (!token.value) {
      user.value = null;
      return null;
    }

    try {
      const response = await $fetch<{ data: AuthUser }>(`${API_BASE_URL}/auth/me`, {
        headers: {
          Authorization: `Bearer ${token.value}`,
        },
      });

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
    const response = await $fetch<{ data: LoginResponse }>(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      body: {
        email,
        password,
      },
    });

    token.value = response.data.accessToken;
    persistToken(token.value);
    await fetchMe();
  };

  const logout = async () => {
    if (token.value) {
      try {
        await $fetch(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
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
    logout,
    clearAuth,
  };
}
