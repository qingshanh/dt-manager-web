import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Checkbox, Dropdown, Grid, Input, Pagination, Popconfirm, Space, Switch, Table, Tag, Tooltip, Typography, theme as antdTheme } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  NotificationOutlined,
  InfoCircleOutlined,
  LoginOutlined,
  MoreOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import {
  CACHE_TTL_MS,
  cacheKeys,
  bulkAccountAction,
  deleteAccount,
  exportFullBackup,
  exportSessions,
  getAccounts,
  isCachedDataFresh,
  readCachedData,
  reorderAccount,
  importFullBackup,
  importSessions,
  startMonitor,
  stopMonitor,
  updateAccount,
} from '../services/endpoints';
import type { BulkAccountAction, DtAccountListItem, PagedData } from '../types';
import { notifyMessageReadStateChanged } from '../services/ui-events';
import VerificationReloginModal from '../components/accounts/VerificationReloginModal';

const statusMap: Record<string, { color: string; label: string }> = {
  pending: { color: 'processing', label: '待验证' },
  online: { color: 'green', label: '在线' },
  offline: { color: 'default', label: '离线' },
  error: { color: 'red', label: '异常' },
  expired: { color: 'orange', label: '授权失效' },
};

function monitorStateLabel(state: DtAccountListItem['monitor_state'], enabled: boolean) {
  if (state === 'retrying') return '监听重试中';
  return enabled ? '监听中' : '未监听';
}

function canVerificationRelogin(account: DtAccountListItem) {
  const usesCode = account.login_type === 'email_code' || account.login_type === 'phone_code';
  return usesCode && (account.requires_relogin || account.status !== 'online' || !account.monitor_enabled);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type CopyableCellProps = {
  value: string | null | undefined;
  copied: boolean;
  onCopy: (value: string) => void;
  fallback?: string;
  maxWidth?: number;
};

function CopyableCell({ value, copied, onCopy, fallback = '-', maxWidth = 220 }: CopyableCellProps) {
  const text = value?.trim();
  if (!text) {
    return <Typography.Text type="secondary">{fallback}</Typography.Text>;
  }
  return (
    <Tooltip title="Click to copy">
      <Space
        size={6}
        onClick={(event) => {
          event.stopPropagation();
          onCopy(text);
        }}
        style={{ cursor: 'pointer', maxWidth, minHeight: 24 }}
      >
        <Typography.Text ellipsis style={{ maxWidth }}>
          {text}
        </Typography.Text>
        {copied ? (
          <Typography.Text type="success" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            <CheckOutlined /> copied
          </Typography.Text>
        ) : (
          <CopyOutlined style={{ fontSize: 12 }} />
        )}
      </Space>
    </Tooltip>
  );
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson(payload: unknown, filename: string) {
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), filename);
}

export default function AccountList() {
  const [accounts, setAccounts] = useState<DtAccountListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [validateImportedSessions, setValidateImportedSessions] = useState(false);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const [verificationAccount, setVerificationAccount] = useState<DtAccountListItem | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const { token } = antdTheme.useToken();
  const screens = Grid.useBreakpoint();
  const compactAccountRows = screens.xxl === false;

  const fetch = useCallback(
    async (currentPage = page, currentKeyword = keyword, options?: { force?: boolean }) => {
      const params = { page: currentPage, pageSize: 20, keyword: currentKeyword || undefined };
      const cacheKey = cacheKeys.accounts(params);
      const cached = !options?.force ? readCachedData<PagedData<DtAccountListItem>>(cacheKey) : null;

      if (cached) {
        setAccounts(cached.list);
        setTotal(cached.total);
        setLoading(false);
        if (isCachedDataFresh(cacheKey, CACHE_TTL_MS.accounts)) {
          return;
        }
      } else {
        setLoading(true);
      }

      try {
        const data = await getAccounts(params, { force: options?.force });
        setAccounts(data.list);
        setTotal(data.total);
      } catch (err) {
        message.error(err instanceof Error ? err.message : 'Failed to load account list');
      } finally {
        setLoading(false);
      }
    },
    [page, keyword, message],
  );

  useEffect(() => {
    fetch();
  }, [fetch]);

  const copyCellValue = async (key: string, value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        if (!document.execCommand('copy')) {
          throw new Error('Copy failed');
        }
        document.body.removeChild(textarea);
      }
      setCopiedCell(key);
      message.success('copied');
      window.setTimeout(() => setCopiedCell((current) => (current === key ? null : current)), 1400);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Copy failed');
    }
  };

  const handleBulkAction = async (action: BulkAccountAction, successLabel: string) => {
    if (selectedAccountIds.length === 0) {
      return;
    }
    setBulkLoading(true);
    try {
      const result = await bulkAccountAction(selectedAccountIds, action);
      if (result.failed > 0) {
        const details = result.results.filter((item) => !item.ok).map((item) => `#${item.account_id}: ${item.error || '失败'}`).join('; ');
        message.warning(`${successLabel}：成功 ${result.succeeded}，失败 ${result.failed}${details ? `。${details}` : ''}`);
      } else {
        message.success(`${successLabel}：已处理 ${result.succeeded} 个账户`);
      }
      if (action === 'mark_read' || action === 'mark_unread') {
        notifyMessageReadStateChanged();
      }
      await fetch(page, keyword, { force: true });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '批量操作失败');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleReorder = async (accountId: number, action: 'move_up' | 'move_down' | 'move_top' | 'move_bottom') => {
    if (actionLoading !== null) {
      return;
    }
    setActionLoading(accountId);
    try {
      await reorderAccount(accountId, action);
      await fetch(page, keyword, { force: true });
    } catch (err) {
      message.error(err instanceof Error ? err.message : '账户排序失败');
    } finally {
      setActionLoading(null);
    }
  };
  const handleToggleMonitor = async (id: number, enabled: boolean) => {
    setActionLoading(id);
    try {
      if (enabled) {
        await stopMonitor(id);
        message.success('已停止监听');
      } else {
        await startMonitor(id);
        message.success('已启动监听');
      }
      await fetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteAccount(id);
      setSelectedAccountIds((items) => items.filter((item) => item !== id));
      message.success('账户已删除');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
      return;
    }

    try {
      await fetch();
    } catch (err) {
      message.warning(err instanceof Error ? `账户已删除，但列表刷新失败：${err.message}` : '账户已删除，但列表刷新失败');
    }
  };
  const handleUpdateNickname = async (record: DtAccountListItem, value: string) => {
    const nickname = value.trim().slice(0, 100);
    setActionLoading(record.id);
    try {
      await updateAccount(record.id, { nickname: nickname || null });
      message.success('备注已保存');
      await fetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存备注失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleTelegramToggle = async (record: DtAccountListItem, checked: boolean) => {
    setActionLoading(record.id);
    try {
      await updateAccount(record.id, { telegram_notify: checked });
      message.success(checked ? '已开启 Telegram 通知' : '已关闭 Telegram 通知');
      await fetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修改 Telegram 通知失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleExportBackup = () => {
    modal.confirm({
      title: 'Export full backup',
      content: 'The backup includes panel password hashes, environment variables, account tokens, phone numbers, messages, settings, and monitor state. Store it only in a trusted location.',
      okText: 'Export',
      cancelText: 'Cancel',
      onOk: async () => {
        const result = await exportFullBackup();
        const payload = result.payload;
        downloadBlob(result.blob, result.filename);
        const envCount = typeof payload.environment === 'object' && payload.environment && Array.isArray(payload.environment.files) ? payload.environment.files.length : 0;
        message.success(
          'Exported ' + payload.accounts.length + ' accounts, ' + payload.settings.length + ' settings, ' + (payload.admin_users?.length ?? 0) + ' panel users, ' + envCount + ' environment files',
        );
      },
    });
  };
  const handleExportSessions = async () => {
    try {
      const payload = await exportSessions();
      downloadJson(payload, `dt-sessions-${dayjs().format('YYYYMMDD-HHmmss')}.json`);
      message.success(`已导出 ${payload.accounts.length} 个会话`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导出会话失败');
    }
  };

  const handleImportFile = async (file: File | null) => {
    if (!file) {
      return;
    }
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (!isRecord(parsed)) {
        message.warning('备份文件格式不正确');
        return;
      }

      const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      if (accounts.length === 0) {
        message.warning('文件里没有可导入的账户');
        return;
      }

      if (parsed.kind === 'dt-manager-full-backup') {
        const settings = Array.isArray(parsed.settings) ? parsed.settings : [];
        const adminUsers = Array.isArray(parsed.admin_users) ? parsed.admin_users : [];
        const environment = parsed.environment ?? parsed.env;
        const result = await importFullBackup({
          accounts,
          settings,
          admin_users: adminUsers,
          environment,
          validate: validateImportedSessions,
        });
        const settingsText = result.settings_imported ? ', settings ' + result.settings_imported : '';
        const adminText = result.admin_users_imported ? ', panel users ' + result.admin_users_imported : '';
        const envText = result.env_files_written ? ', environment files ' + result.env_files_written + ' (restart backend to apply)' : '';
        message.success('Imported ' + result.imported + ' accounts, failed ' + result.failed + settingsText + adminText + envText);
      } else {
        const directSettings = isRecord(parsed.direct_settings) ? (parsed.direct_settings as Record<string, string>) : undefined;
        const result = await importSessions({ accounts, direct_settings: directSettings, validate: validateImportedSessions });
        const settingsText = result.settings_imported ? ', direct settings ' + result.settings_imported : '';
        message.success('Imported ' + result.imported + ' sessions, failed ' + result.failed + settingsText);
      }
      await fetch();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '导入备份失败');
    } finally {
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
    }
  };

  const columns: ColumnsType<DtAccountListItem> = [
    {
      title: '备注',
      dataIndex: 'nickname',
      width: 116,
      ellipsis: true,
      render: (text, record) => (
        <Typography.Text
          editable={{
            text: text || '',
            tooltip: '编辑备注',
            maxLength: 100,
            onChange: (value) => void handleUpdateNickname(record, value),
          }}
        >
          <CopyableCell
            value={text || 'Unnamed account'}
            copied={copiedCell === `nickname:${record.id}`}
            onCopy={(value) => void copyCellValue(`nickname:${record.id}`, value)}
            maxWidth={98}
          />
        </Typography.Text>
      ),
    },
    {
      title: '类型',
      dataIndex: 'app_variant',
      width: 80,
      render: (value) => <Tag color={value === 'dingdong' ? 'blue' : 'gold'}>{value === 'dingdong' ? '叮咚' : '说道'}</Tag>,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      width: 196,
      ellipsis: true,
      render: (value, record) => (
        <CopyableCell
          value={value}
          copied={copiedCell === `email:${record.id}`}
          onCopy={(copyValue) => void copyCellValue(`email:${record.id}`, copyValue)}
          maxWidth={180}
        />
      ),
    },
    {
      title: '用户 ID',
      dataIndex: 'dt_user_id',
      width: 120,
      render: (value, record) => (
        <CopyableCell
          value={value}
          copied={copiedCell === `user:${record.id}`}
          onCopy={(copyValue) => void copyCellValue(`user:${record.id}`, copyValue)}
          maxWidth={128}
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 82,
      render: (value: string, record) => {
        const item = statusMap[value] || { color: 'default', label: value };
        const tags = (
          <Space direction="vertical" size={2}>
            <Tag color={item.color} style={{ marginInlineEnd: 0 }}>{item.label}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>{monitorStateLabel(record.monitor_state, record.monitor_enabled)}</Typography.Text>
          </Space>
        );
        return record.last_error ? <Tooltip title={record.last_error}>{tags}</Tooltip> : tags;
      },
    },
    {
      title: '电报',
      dataIndex: 'telegram_notify',
      width: 58,
      render: (value, record) => (
        <Switch size="small" checked={value} loading={actionLoading === record.id} onChange={(checked) => void handleTelegramToggle(record, checked)} />
      ),
    },
    {
      title: '未读',
      dataIndex: 'unread_count',
      width: 48,
      render: (value) => (value > 0 ? <Tag color="red" style={{ marginInlineEnd: 0 }}>{value}</Tag> : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: '排序',
      width: 48,
      render: (_, record) => (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'move_top', icon: <VerticalAlignTopOutlined />, label: '置顶' },
              { key: 'move_up', icon: <ArrowUpOutlined />, label: '上移' },
              { key: 'move_down', icon: <ArrowDownOutlined />, label: '下移' },
              { key: 'move_bottom', icon: <VerticalAlignBottomOutlined />, label: '置底' },
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation();
              void handleReorder(record.id, key as 'move_up' | 'move_down' | 'move_top' | 'move_bottom');
            },
          }}
        >
          <Tooltip title="调整排序">
            <Button type="text" size="small" icon={<MoreOutlined />} disabled={actionLoading !== null} loading={actionLoading === record.id} onClick={(event) => event.stopPropagation()} />
          </Tooltip>
        </Dropdown>
      ),
    },
    {
      title: '最近登录',
      dataIndex: 'last_login_at',
      width: 78,
      render: (value) => (value ? dayjs(value).format('MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      width: 124,
      render: (_, record) => (
        <Space size={2}>
          {canVerificationRelogin(record) ? (
            <Tooltip title="验证码重新登录">
              <Button type="text" size="small" icon={<LoginOutlined />} onClick={() => setVerificationAccount(record)} />
            </Tooltip>
          ) : null}
          <Tooltip title={record.monitor_enabled ? '停止监听' : '启动监听'}>
            <Button
              size="small"
              type="text"
              icon={record.monitor_enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              loading={actionLoading === record.id}
              disabled={record.status === 'pending'}
              onClick={() => void handleToggleMonitor(record.id, record.monitor_enabled)}
            />
          </Tooltip>
          <Tooltip title="账户详情">
            <Button type="text" size="small" icon={<InfoCircleOutlined />} onClick={() => navigate(`/accounts/${record.id}`)} />
          </Tooltip>
          <Popconfirm
            title="确认删除此账户？相关消息和号码都会一起删除。"
            onConfirm={() => void handleDelete(record.id)}
            okText="确认删除"
            cancelText="取消"
          >
            <Tooltip title="删除账户">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const pagination = {
    current: page,
    total,
    pageSize: 20,
    showTotal: (value: number) => `共 ${value} 个账户`,
    onChange: (currentPage: number) => {
      setPage(currentPage);
      void fetch(currentPage, keyword);
    },
  };

  const selectionToolbar = selectedAccountIds.length > 0 ? (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '0 0 12px',
        marginBottom: 12,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Typography.Text strong>已选择 {selectedAccountIds.length} 个账户</Typography.Text>
      <Button icon={<PlayCircleOutlined />} loading={bulkLoading} onClick={() => void handleBulkAction('start_monitor', '启动监听')}>监听</Button>
      <Button icon={<PauseCircleOutlined />} loading={bulkLoading} onClick={() => void handleBulkAction('stop_monitor', '停止监听')}>停止监听</Button>
      <Button icon={<NotificationOutlined />} loading={bulkLoading} onClick={() => void handleBulkAction('telegram_on', '开启 Telegram 通知')}>开启通知</Button>
      <Button icon={<NotificationOutlined />} loading={bulkLoading} onClick={() => void handleBulkAction('telegram_off', '关闭 Telegram 通知')}>关闭通知</Button>
      <Button icon={<EyeOutlined />} loading={bulkLoading} onClick={() => void handleBulkAction('mark_read', '标记已读')}>已读</Button>
      <Button icon={<EyeInvisibleOutlined />} loading={bulkLoading} onClick={() => void handleBulkAction('mark_unread', '标记未读')}>未读</Button>
      <Button type="link" onClick={() => setSelectedAccountIds([])}>取消选择</Button>
    </div>
  ) : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, gap: 12 }}>
        <h2 style={{ margin: 0, whiteSpace: 'nowrap', flexShrink: 0 }}>账户列表</h2>
        <Space wrap style={{ maxWidth: '100%' }}>
          <Input.Search
            placeholder="搜索备注 / 邮箱"
            allowClear
            onSearch={(value) => {
              setKeyword(value);
              setPage(1);
              void fetch(1, value);
            }}
            style={{ width: 260, maxWidth: '100%' }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void fetch(page, keyword, { force: true })}>
            刷新
          </Button>
          <Button icon={<DownloadOutlined />} onClick={handleExportBackup}>
            导出完整备份
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => void handleExportSessions()}>
            导出会话
          </Button>
          <Checkbox checked={validateImportedSessions} onChange={(event) => setValidateImportedSessions(event.target.checked)}>
            导入后验证直连
          </Checkbox>
          <Button icon={<UploadOutlined />} onClick={() => importInputRef.current?.click()}>
            导入备份
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => void handleImportFile(event.target.files?.[0] ?? null)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/accounts/new')}>
            添加账户
          </Button>
        </Space>
      </div>
      {selectionToolbar}
      {compactAccountRows ? (
        <div>
          <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
            {accounts.map((record) => {
              const status = statusMap[record.status] || { color: 'default', label: record.status };
              const selected = selectedAccountIds.includes(record.id);
              return (
                <div key={record.id} style={{ padding: '12px 0', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <Checkbox
                      checked={selected}
                      onChange={(event) => setSelectedAccountIds((items) => event.target.checked ? [...new Set([...items, record.id])] : items.filter((id) => id !== record.id))}
                    />
                    <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>{record.nickname || 'Unnamed account'}</Typography.Text>
                    <Tag color={record.app_variant === 'dingdong' ? 'blue' : 'gold'} style={{ marginInlineEnd: 0 }}>{record.app_variant === 'dingdong' ? '叮咚' : '说道'}</Tag>
                    <Tag color={status.color} style={{ marginInlineEnd: 0 }}>{status.label}</Tag>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '8px 16px', margin: '10px 0', alignItems: 'center' }}>
                    <CopyableCell value={record.email} copied={copiedCell === `email:${record.id}`} onCopy={(value) => void copyCellValue(`email:${record.id}`, value)} maxWidth={360} />
                    <Typography.Text type="secondary">{monitorStateLabel(record.monitor_state, record.monitor_enabled)} · 未读 {record.unread_count}</Typography.Text>
                    <CopyableCell value={record.dt_user_id} copied={copiedCell === `user:${record.id}`} onCopy={(value) => void copyCellValue(`user:${record.id}`, value)} maxWidth={240} />
                    <Typography.Text type="secondary">{record.last_login_at ? dayjs(record.last_login_at).format('MM-DD HH:mm') : '未登录'}</Typography.Text>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <Space size={8}>
                      <Typography.Text type="secondary">电报</Typography.Text>
                      <Switch size="small" checked={record.telegram_notify} loading={actionLoading === record.id} onChange={(checked) => void handleTelegramToggle(record, checked)} />
                    </Space>
                    <Space size={2}>
                      <Dropdown
                        trigger={['click']}
                        menu={{
                          items: [
                            { key: 'move_top', icon: <VerticalAlignTopOutlined />, label: '置顶' },
                            { key: 'move_up', icon: <ArrowUpOutlined />, label: '上移' },
                            { key: 'move_down', icon: <ArrowDownOutlined />, label: '下移' },
                            { key: 'move_bottom', icon: <VerticalAlignBottomOutlined />, label: '置底' },
                          ],
                          onClick: ({ key }) => void handleReorder(record.id, key as 'move_up' | 'move_down' | 'move_top' | 'move_bottom'),
                        }}
                      >
                        <Tooltip title="调整排序"><Button type="text" size="small" icon={<MoreOutlined />} /></Tooltip>
                      </Dropdown>
                      {canVerificationRelogin(record) ? (
                        <Tooltip title="验证码重新登录"><Button type="text" size="small" icon={<LoginOutlined />} onClick={() => setVerificationAccount(record)} /></Tooltip>
                      ) : null}
                      <Tooltip title={record.monitor_enabled ? '停止监听' : '启动监听'}><Button type="text" size="small" icon={record.monitor_enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />} disabled={record.status === 'pending'} onClick={() => void handleToggleMonitor(record.id, record.monitor_enabled)} /></Tooltip>
                      <Tooltip title="账户详情"><Button type="text" size="small" icon={<InfoCircleOutlined />} onClick={() => navigate(`/accounts/${record.id}`)} /></Tooltip>
                      <Popconfirm title="确认删除此账户？相关消息和号码都会一起删除。" onConfirm={() => void handleDelete(record.id)} okText="确认删除" cancelText="取消">
                        <Tooltip title="删除账户"><Button type="text" size="small" danger icon={<DeleteOutlined />} /></Tooltip>
                      </Popconfirm>
                    </Space>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination style={{ marginTop: 16 }} {...pagination} />
        </div>
      ) : (
        <Card styles={{ body: { padding: 16 } }}>
          <Table
            columns={columns}
            dataSource={accounts}
            rowKey="id"
            rowSelection={{
              selectedRowKeys: selectedAccountIds,
              preserveSelectedRowKeys: true,
              onChange: (keys) => setSelectedAccountIds(keys.map(Number)),
            }}
            loading={loading}
            size="small"
            tableLayout="fixed"
            className="account-table"
            pagination={pagination}
          />
        </Card>
      )}
      <VerificationReloginModal
        open={verificationAccount !== null}
        account={verificationAccount}
        onCancel={() => setVerificationAccount(null)}
        onSuccess={() => fetch(page, keyword, { force: true })}
      />
    </div>
  );
}
