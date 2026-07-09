import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { App, Badge, Button, Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import {
  BellOutlined,
  DashboardOutlined,
  LogoutOutlined,
  PlusOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/auth';
import { getRecentMessages, invalidateCachedData } from '../services/endpoints';
import type { RecentMessage, SSENewMessageEvent } from '../types';

const { Header, Sider, Content } = Layout;
const RECENT_MESSAGE_FALLBACK_POLL_MS = 30_000;

type MenuItem = Required<MenuProps>['items'][number];

const menuItems: MenuItem[] = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/accounts', icon: <UserOutlined />, label: '账户列表' },
  { key: '/accounts/new', icon: <PlusOutlined />, label: '添加账户' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
];

function buildMessageKey(item: {
  accountId?: number;
  account_id?: number;
  id?: number;
  from?: string | null;
  from_number?: string | null;
  content: string;
  receivedAt?: string;
  received_at?: string;
}) {
  return [
    item.accountId ?? item.account_id ?? '',
    item.from ?? item.from_number ?? '',
    item.content,
    item.receivedAt ?? item.received_at ?? '',
  ].join('|');
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((state) => state.logout);
  const user = useAuthStore((state) => state.user);
  const [collapsed, setCollapsed] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenMessageIdsRef = useRef<Set<number>>(new Set());
  const seenMessageKeysRef = useRef<Set<string>>(new Set());
  const recentBaselineReadyRef = useRef(false);
  const { notification } = App.useApp();
  const appVersion = __APP_VERSION__;

  const selectedKey = (() => {
    const path = location.pathname;
    if (path === '/') return '/';
    if (path.startsWith('/accounts/new')) return '/accounts/new';
    if (path.startsWith('/accounts')) return '/accounts';
    if (path.startsWith('/settings')) return '/settings';
    return '/';
  })();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const notifyIncomingMessage = useCallback(
    (data: SSENewMessageEvent) => {
      if (data.msgType === 'system') {
        return;
      }
      if (data.id && seenMessageIdsRef.current.has(data.id)) {
        return;
      }
      const key = buildMessageKey(data);
      if (seenMessageKeysRef.current.has(key)) {
        return;
      }
      if (data.id) {
        seenMessageIdsRef.current.add(data.id);
      }
      seenMessageKeysRef.current.add(key);
      setNotificationCount((count) => count + 1);
      notification.info({
        message: `新短信 - ${data.accountNickname}`,
        description: `${data.from || '-'}: ${data.content}`,
        placement: 'topRight',
        duration: 15,
      });
    },
    [notification],
  );

  const dispatchIncomingMessage = useCallback((data: SSENewMessageEvent) => {
    window.dispatchEvent(new CustomEvent<SSENewMessageEvent>('dt:new-message', { detail: data }));
  }, []);

  const handleIncomingMessage = useCallback(
    (data: SSENewMessageEvent) => {
      invalidateCachedData('dashboard:');
      invalidateCachedData('accounts:');
      if (data.accountId) {
        invalidateCachedData(`account:${data.accountId}:`);
      }
      dispatchIncomingMessage(data);
      notifyIncomingMessage(data);
    },
    [dispatchIncomingMessage, notifyIncomingMessage],
  );

  const connectSSE = useCallback(() => {
    const token = localStorage.getItem('token');
    if (!token) return;

    eventSourceRef.current?.close();
    const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    eventSourceRef.current = es;

    es.addEventListener('new_message', (event) => {
      try {
        const data: SSENewMessageEvent = JSON.parse(event.data);
        handleIncomingMessage(data);
      } catch {
        // Keep the stream alive if a malformed event appears.
      }
    });

    es.addEventListener('account_status', (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.status === 'error') {
          notification.warning({
            message: '账户状态异常',
            description: data.message || '账户连接出现问题',
            placement: 'topRight',
          });
        }
      } catch {
        // Keep the stream alive if a malformed event appears.
      }
    });

    es.onerror = () => {
      es.close();
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null;
      }
      window.setTimeout(connectSSE, 5000);
    };
  }, [handleIncomingMessage, notification]);

  useEffect(() => {
    connectSSE();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connectSSE]);

  useEffect(() => {
    let stopped = false;

    const rememberRecentMessages = (items: RecentMessage[]) => {
      for (const item of items) {
        seenMessageIdsRef.current.add(item.id);
        seenMessageKeysRef.current.add(buildMessageKey(item));
      }
    };

    const pollRecentMessages = async () => {
      if (!localStorage.getItem('token')) {
        recentBaselineReadyRef.current = false;
        return;
      }
      try {
        const items = await getRecentMessages(10, { force: recentBaselineReadyRef.current });
        if (!recentBaselineReadyRef.current) {
          rememberRecentMessages(items);
          recentBaselineReadyRef.current = true;
          return;
        }

        for (const item of [...items].reverse()) {
          if (seenMessageIdsRef.current.has(item.id)) {
            continue;
          }
          handleIncomingMessage({
            id: item.id,
            accountId: item.account_id,
            accountNickname: item.account.nickname,
            from: item.from_number,
            content: item.content,
            msgType: item.msg_type,
            receivedAt: item.received_at,
          });
        }
      } catch {
        // This is only a UI fallback for missed SSE events.
      }
    };

    void pollRecentMessages();
    const timer = window.setInterval(() => {
      if (!stopped) {
        void pollRecentMessages();
      }
    }, RECENT_MESSAGE_FALLBACK_POLL_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [handleIncomingMessage]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider collapsible collapsed={collapsed} onCollapse={setCollapsed} theme="dark">
        <div
          style={{
            height: 48,
            margin: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 'bold',
            fontSize: collapsed ? 14 : 18,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {collapsed ? '说道' : '说道管理平台'}
        </div>
        <div style={{ display: 'flex', minHeight: 'calc(100vh - 112px)', flexDirection: 'column' }}>
          <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={menuItems} onClick={({ key }) => navigate(key)} />
          <div
            style={{
              marginTop: 'auto',
              padding: collapsed ? '12px 0' : '12px 16px',
              color: 'rgba(255,255,255,0.45)',
              fontSize: 12,
              lineHeight: 1,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {collapsed ? appVersion : `v${appVersion}`}
          </div>
        </div>
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 16,
            boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          }}
        >
          <Badge count={notificationCount} onClick={() => setNotificationCount(0)}>
            <BellOutlined style={{ fontSize: 18, cursor: 'pointer' }} />
          </Badge>
          <span>{user?.username}</span>
          <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout}>
            退出
          </Button>
        </Header>
        <Content style={{ margin: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
