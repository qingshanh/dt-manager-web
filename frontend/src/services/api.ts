import axios from 'axios';
import type { ApiResponse } from '../types';

type ApiErrorKind = 'unauthorized' | 'timeout' | 'network' | 'request';

export class ApiClientError extends Error {
  status: number | null;
  code: string | null;
  apiCode: number | string | null;
  kind: 'unauthorized' | 'timeout' | 'network' | 'request';

  constructor(message: string, options: { status?: number | null; code?: string | null; apiCode?: number | string | null; kind?: ApiErrorKind } = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.apiCode = options.apiCode ?? null;
    this.kind = options.kind ?? 'request';
  }
}

export function isUnauthorizedError(error: unknown) {
  return error instanceof ApiClientError
    ? error.kind === 'unauthorized' || error.apiCode === 40101
    : Boolean(error && typeof error === 'object' && 'apiCode' in error && (error as { apiCode?: unknown }).apiCode === 40101);
}

function clearUnauthorizedSession() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

const api = axios.create({
  baseURL: '/api',
  timeout: 60000,
});

// 请求拦截器 — 附加 JWT token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器 — 统一错误处理
api.interceptors.response.use(
  (response) => {
    if (response.data instanceof Blob) {
      return response;
    }
    const body = response.data as ApiResponse;
    if (body.code !== 0) {
      const unauthorized = body.code === 40101;
      const error = new ApiClientError(body.message || '请求失败', {
        status: unauthorized ? 401 : response.status,
        apiCode: body.code,
        kind: unauthorized ? 'unauthorized' : 'request',
      });
      if (unauthorized) {
        clearUnauthorizedSession();
      }
      return Promise.reject(error);
    }
    return response;
  },
  (error: unknown) => {
    if (!axios.isAxiosError(error)) {
      return Promise.reject(error instanceof Error ? error : new ApiClientError('请求失败'));
    }
    const status = error.response?.status ?? null;
    const code = error.code ?? null;
    const apiCode = error.response?.data?.code ?? null;
    const timedOut = code === 'ECONNABORTED' || /timeout/i.test(error.message);
    const kind: ApiErrorKind = status === 401 && apiCode === 40101 ? 'unauthorized' : timedOut ? 'timeout' : error.response ? 'request' : 'network';
    const message =
      error.response?.data?.message ||
      (timedOut ? '请求超时，请稍后重试' : kind === 'network' ? '网络连接失败，请检查后端服务后重试' : error.message) ||
      '请求失败';
    const clientError = new ApiClientError(message, { status, code, apiCode, kind });
    if (kind === 'unauthorized') {
      clearUnauthorizedSession();
    }
    return Promise.reject(clientError);
  },
);

export default api;
