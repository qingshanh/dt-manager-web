import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Spin } from 'antd';
import { useAuthStore } from './stores/auth';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const AccountList = lazy(() => import('./pages/AccountList'));
const AccountAdd = lazy(() => import('./pages/AccountAdd'));
const AccountDetail = lazy(() => import('./pages/AccountDetail'));
const Settings = lazy(() => import('./pages/Settings'));

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function preloadPrimaryPages() {
  void import('./pages/Dashboard');
  void import('./pages/AccountList');
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const checkAuth = useAuthStore((s) => s.checkAuth);
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const [ready, setReady] = useState(() => Boolean(useAuthStore.getState().token && useAuthStore.getState().user));
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setReady(true);
      return undefined;
    }
    if (token && user) {
      setReady(true);
    }
    void checkAuth().finally(() => {
      if (!cancelled) {
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [checkAuth, token]);

  useEffect(() => {
    if (ready && !token) {
      navigate('/login', { replace: true });
    }
  }, [ready, token, navigate]);
  useEffect(() => {
    if (ready && token) {
      const idleWindow = window as IdleWindow;
      if (idleWindow.requestIdleCallback) {
        const handle = idleWindow.requestIdleCallback(() => preloadPrimaryPages(), { timeout: 1200 });
        return () => idleWindow.cancelIdleCallback?.(handle);
      }

      const timer = window.setTimeout(preloadPrimaryPages, 0);
      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [ready, token]);

  if (!ready) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <Suspense fallback={<PageSpin />}>
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="accounts" element={<AccountList />} />
        <Route path="accounts/new" element={<AccountAdd />} />
        <Route path="accounts/:id" element={<AccountDetail />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

function PageSpin() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 240 }}>
      <Spin />
    </div>
  );
}
