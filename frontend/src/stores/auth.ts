import { create } from 'zustand';
import type { AdminUser } from '../types';
import * as api from '../services/endpoints';
import { isUnauthorizedError } from '../services/api';

function readCachedUser(): AdminUser | null {
  try {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) as AdminUser : null;
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  user: AdminUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('token'),
  user: readCachedUser(),
  loading: false,

  login: async (username, password) => {
    set({ loading: true });
    try {
      const result = await api.login({ username, password });
      localStorage.setItem('token', result.token);
      localStorage.setItem('user', JSON.stringify(result.user));
      set({ token: result.token, user: result.user });
    } finally {
      set({ loading: false });
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      // 忽略异常
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null });
  },

  checkAuth: async () => {
    const token = localStorage.getItem('token');
    if (!token) return false;
    const cachedUser = readCachedUser();
    try {
      const user = await api.getMe();
      if (user) {
        set({ user, token });
        return true;
      }
    } catch (error) {
      if (isUnauthorizedError(error)) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        set({ token: null, user: null });
        return false;
      }
      set({ token, user: cachedUser });
      return Boolean(cachedUser);
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({ token: null, user: null });
    return false;
  },
}));
