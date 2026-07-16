import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadRootEnv() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }
  return Object.fromEntries(
    fs.readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .map((rawLine) => rawLine.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        const key = line.slice(0, index).trim();
        let value = line.slice(index + 1).trim();
        if (value.length >= 2 && value[0] === value[value.length - 1] && ['"', "'"].includes(value[0])) {
          value = value.slice(1, -1);
        }
        return [key, value];
      }),
  );
}

export default defineConfig(({ mode }) => {
  void mode;
  const rootEnv = loadRootEnv();
  const env = { ...rootEnv, ...process.env };
  const devPort = Number(env.VITE_DEV_PORT ?? env.FRONTEND_PORT ?? 5173);
  const previewPort = Number(env.VITE_PREVIEW_PORT ?? env.FRONTEND_PREVIEW_PORT ?? 5176);
  const backendTarget = env.VITE_BACKEND_URL ?? env.BACKEND_URL ?? 'http://localhost:5174';
  const appVersion = env.VITE_APP_VERSION || env.APP_VERSION || '0.2.9';

  return {
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom', 'zustand'],
            antd: ['antd', '@ant-design/icons'],
            utils: ['axios', 'dayjs'],
          },
        },
      },
    },
    server: {
      host: env.VITE_DEV_HOST ?? env.FRONTEND_HOST ?? '127.0.0.1',
      port: devPort,
      proxy: {
        '/api': {
          target: backendTarget,
          changeOrigin: true,
        },
        '/health': {
          target: backendTarget,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: env.VITE_PREVIEW_HOST ?? env.FRONTEND_PREVIEW_HOST ?? '127.0.0.1',
      port: previewPort,
    },
  };
});
