import axios from 'axios';
import type { ApiResponse } from '../types';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
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
    const body = response.data as ApiResponse;
    if (body.code !== 0) {
      return Promise.reject(new Error(body.message || 'Request failed'));
    }
    return response;
  },
  (error) => {
    const message =
      error.response?.data?.message ||
      error.message ||
      '请求失败';
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(new Error(message));
  },
);

export default api;
