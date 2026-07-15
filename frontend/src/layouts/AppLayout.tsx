import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { App, Badge, Button, Empty, Grid, Layout, List, Menu, Popover, Segmented, Space, Spin, Tooltip, Typography, theme as antdTheme } from 'antd';
import type { MenuProps } from 'antd';
import {
  BellOutlined,
  DashboardOutlined,
  DesktopOutlined,
  LogoutOutlined,
  MoonOutlined,
  PhoneOutlined,
  PlusOutlined,
  SettingOutlined,
  SunOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuthStore } from '../stores/auth';
import { useThemeStore, type ThemeMode } from '../stores/theme';
import {
  getRecentMessages,
  getUnreadNotifications,
  invalidateCachedData,
  markAllDashboardMessagesRead,
} from '../services/endpoints';
import type { RecentMessage, SSENewMessageEvent } from '../types';
import { MESSAGE_READ_STATE_EVENT } from '../services/ui-events';

const { Header, Sider, Content } = Layout;
const RECENT_MESSAGE_FALLBACK_POLL_MS = 30_000;

type MenuItem = Required<MenuProps>['items'][number];

const menuItems: MenuItem[] = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/accounts', icon: <UserOutlined />, label: '账户列表' },
  { key: '/phone-numbers', icon: <PhoneOutlined />, label: '手机号管理' },
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
  const screens = Grid.useBreakpoint();
  const isNarrow = screens.lg === false;
  const siderCollapsed = isNarrow || collapsed;
  const [notificationCount, setNotificationCount] = useState(0);
  const [notificationItems, setNotificationItems] = useState<RecentMessage[]>([]);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const seenMessageIdsRef = useRef<Set<number>>(new Set());
  const seenMessageKeysRef = useRef<Set<string>>(new Set());
  const recentBaselineReadyRef = useRef(false);
  const { message, notification } = App.useApp();
  const { token } = antdTheme.useToken();
  const themeMode = useThemeStore((state) => state.mode);
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const setThemeMode = useThemeStore((state) => state.setMode);
  const appVersion = __APP_VERSION__;

  const selectedKey = (() => {
    const path = location.pathname;
    if (path === '/') return '/';
    if (path.startsWith('/phone-numbers')) return '/phone-numbers';
    if (path.startsWith('/accounts/new')) return '/accounts/new';
    if (path.startsWith('/accounts')) return '/accounts';
    if (path.startsWith('/settings')) return '/settings';
    return '/';
  })();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const loadUnreadNotifications = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setNotificationLoading(true);
    }
    try {
      const data = await getUnreadNotifications(20);
      setNotificationCount(data.unread_count);
      setNotificationItems(data.list);
    } catch (err) {
      if (showLoading) {
        message.error(err instanceof Error ? err.message : '加载未读消息失败');
      }
    } finally {
      if (showLoading) {
        setNotificationLoading(false);
      }
    }
  }, [message]);

  const handleMarkAllNotificationsRead = useCallback(async () => {
    try {
      const result = await markAllDashboardMessagesRead();
      setNotificationCount(0);
      setNotificationItems([]);
      message.success(result.updated > 0 ? `已将 ${result.updated} 条消息标记为已读` : '当前没有未读消息');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '标记已读失败');
    }
  }, [message]);

  const rememberIncomingMessage = useCallback((data: SSENewMessageEvent) => {
      if (data.id && seenMessageIdsRef.current.has(data.id)) {
        return false;
      }
      const key = buildMessageKey(data);
      if (seenMessageKeysRef.current.has(key)) {
        return false;
      }
      if (data.id) {
        seenMessageIdsRef.current.add(data.id);
      }
      seenMessageKeysRef.current.add(key);
      return true;
  }, []);

  const notifyIncomingMessage = useCallback(
    (data: SSENewMessageEvent) => {
      if (data.msgType === 'system') {
        return;
      }
      setNotificationCount((count) => count + 1);
      if (data.id) {
        const receivedAt = data.receivedAt || new Date().toISOString();
        const nextNotification: RecentMessage = {
          id: data.id!,
          account_id: data.accountId,
          direction: 'incoming',
          msg_type: data.msgType === 'verification' || data.msgType === 'mms' || data.msgType === 'system' ? data.msgType : 'sms',
          from_number: data.from,
          to_number: data.toNumber,
          content: data.content,
          raw_info: null,
          raw_k3: null,
          k5_flag: null,
          is_read: false,
          telegram_sent: false,
          telegram_msg_id: null,
          received_at: receivedAt,
          created_at: receivedAt,
          account: { id: data.accountId, nickname: data.accountNickname },
        };
        setNotificationItems((current) => [nextNotification, ...current.filter((item) => item.id !== data.id)].slice(0, 20));
      }
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
      if (!rememberIncomingMessage(data)) {
        return;
      }
      invalidateCachedData('dashboard:');
      invalidateCachedData('accounts:');
      if (data.accountId) {
        invalidateCachedData(`account:${data.accountId}:`);
      }
      dispatchIncomingMessage(data);
      notifyIncomingMessage(data);
    },
    [dispatchIncomingMessage, notifyIncomingMessage, rememberIncomingMessage],
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
    void loadUnreadNotifications();
    const timer = window.setInterval(() => void loadUnreadNotifications(), RECENT_MESSAGE_FALLBACK_POLL_MS);
    const handleReadStateChange = () => void loadUnreadNotifications();
    window.addEventListener(MESSAGE_READ_STATE_EVENT, handleReadStateChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(MESSAGE_READ_STATE_EVENT, handleReadStateChange);
    };
  }, [loadUnreadNotifications]);

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
            toNumber: item.to_number,
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

  const notificationPanel = (
    <div style={{ width: 'min(320px, calc(100vw - 48px))' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text strong>未读消息</Typography.Text>
        <Button type="link" size="small" disabled={notificationCount === 0} onClick={() => void handleMarkAllNotificationsRead()}>
          全部已读
        </Button>
      </div>
      {notificationLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spin /></div>
      ) : notificationItems.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无未读消息" />
      ) : (
        <List
          size="small"
          dataSource={notificationItems}
          style={{ maxHeight: 420, overflowY: 'auto' }}
          renderItem={(item) => (
            <List.Item
              style={{ cursor: 'pointer', alignItems: 'flex-start' }}
              onClick={() => {
                setBellOpen(false);
                navigate(`/accounts/${item.account_id}?tab=messages&messageId=${item.id}`);
              }}
            >
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Space size={6}>
                  <Typography.Text strong>{item.account.nickname || `账户 #${item.account_id}`}</Typography.Text>
                  <Typography.Text type="secondary">{item.to_number || '未知接收号码'}</Typography.Text>
                </Space>
                <Typography.Text ellipsis>{item.from_number || '-'}：{item.content}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(item.received_at).toLocaleString()}</Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
    </div>
  );

  return (
    <Layout style={{ height: '100vh', overflow: 'hidden', background: token.colorBgLayout }}>
      <Sider
        collapsible
        collapsed={siderCollapsed}
        onCollapse={(value) => {
          if (!isNarrow) setCollapsed(value);
        }}
        breakpoint="lg"
        collapsedWidth={64}
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
        style={{
          position: 'sticky',
          top: 0,
          height: '100vh',
          overflow: 'hidden',
          alignSelf: 'flex-start',
          borderRight: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <div
          style={{
            height: 48,
            margin: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: token.colorText,
            fontWeight: 'bold',
            fontSize: siderCollapsed ? 14 : 18,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {siderCollapsed ? '说道' : '说道管理平台'}
        </div>
        <div style={{ display: 'flex', minHeight: 'calc(100vh - 112px)', flexDirection: 'column' }}>
          <Menu theme={resolvedTheme === 'dark' ? 'dark' : 'light'} mode="inline" selectedKeys={[selectedKey]} items={menuItems} onClick={({ key }) => navigate(key)} />
          <div
            style={{
              marginTop: 'auto',
              padding: siderCollapsed ? '12px 0' : '12px 16px',
              color: token.colorTextSecondary,
              fontSize: 12,
              lineHeight: 1,
              textAlign: 'center',
              whiteSpace: 'nowrap',
            }}
          >
            {siderCollapsed ? appVersion : `v${appVersion}`}
          </div>
        </div>
      </Sider>
      <Layout style={{ minWidth: 0, height: '100vh', background: token.colorBgLayout }}>
        <Header
          style={{
            background: token.colorBgContainer,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 16,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Segmented<ThemeMode>
            size="small"
            value={themeMode}
            onChange={setThemeMode}
            options={[
              { value: 'light', label: <Tooltip title="白天模式"><SunOutlined /></Tooltip> },
              { value: 'dark', label: <Tooltip title="黑夜模式"><MoonOutlined /></Tooltip> },
              { value: 'system', label: <Tooltip title="跟随系统"><DesktopOutlined /></Tooltip> },
            ]}
            aria-label="主题模式"
          />
          <Popover
            content={notificationPanel}
            trigger="click"
            placement={siderCollapsed ? 'bottom' : 'bottomRight'}
            open={bellOpen}
            onOpenChange={(open) => {
              setBellOpen(open);
              if (open) void loadUnreadNotifications(true);
            }}
          >
            <Badge count={notificationCount} overflowCount={99}>
              <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} aria-label="查看未读消息" />
            </Badge>
          </Popover>
          <span>{user?.username}</span>
          <Button type="text" icon={<LogoutOutlined />} onClick={handleLogout}>
            退出
          </Button>
        </Header>
        <Content style={{ margin: isNarrow ? 12 : 24, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
