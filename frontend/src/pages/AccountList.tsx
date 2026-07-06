import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Card, Checkbox, Input, Popconfirm, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { CheckOutlined, CopyOutlined, DownloadOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import {
  deleteAccount,
  exportFullBackup,
  exportSessions,
  getAccounts,
  importFullBackup,
  importSessions,
  startMonitor,
  stopMonitor,
  updateAccount,
} from '../services/endpoints';
import type { DtAccountListItem } from '../types';

const statusMap: Record<string, { color: string; label: string }> = {
  pending: { color: 'processing', label: '待验证' },
  online: { color: 'green', label: '在线' },
  offline: { color: 'default', label: '离线' },
  error: { color: 'red', label: '异常' },
  expired: { color: 'orange', label: '过期' },
};

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
    return <span style={{ color: '#999' }}>{fallback}</span>;
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
          <CopyOutlined style={{ color: '#999', fontSize: 12 }} />
        )}
      </Space>
    </Tooltip>
  );
}
function downloadJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AccountList() {
  const [accounts, setAccounts] = useState<DtAccountListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [validateImportedSessions, setValidateImportedSessions] = useState(false);
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();
  const { message, modal } = App.useApp();

  const fetch = useCallback(
    async (currentPage = page, currentKeyword = keyword) => {
      setLoading(true);
      try {
        const data = await getAccounts({ page: currentPage, pageSize: 20, keyword: currentKeyword || undefined });
        setAccounts(data.list);
        setTotal(data.total);
      } catch (err) {
        message.error(err instanceof Error ? err.message : '获取账户列表失败');
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
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedCell(key);
      window.setTimeout(() => setCopiedCell((current) => (current === key ? null : current)), 1400);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Copy failed');
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
      title: '导出完整备份',
      content: '备份会包含账户 token、密码、号码、消息和设置，请妥善保存。',
      okText: '导出',
      cancelText: '取消',
      onOk: async () => {
        const payload = await exportFullBackup();
        downloadJson(payload, `dt-manager-backup-${dayjs().format('YYYYMMDD-HHmmss')}.json`);
        message.success(`已导出 ${payload.accounts.length} 个账户和 ${payload.settings.length} 项设置`);
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
        const result = await importFullBackup({ accounts, settings, validate: validateImportedSessions });
        const settingsText = result.settings_imported ? `，设置 ${result.settings_imported} 项` : '';
        message.success(`已导入 ${result.imported} 个账户，失败 ${result.failed} 个${settingsText}`);
      } else {
        const directSettings = isRecord(parsed.direct_settings) ? (parsed.direct_settings as Record<string, string>) : undefined;
        const result = await importSessions({ accounts, direct_settings: directSettings, validate: validateImportedSessions });
        const settingsText = result.settings_imported ? `，直连设置 ${result.settings_imported} 项` : '';
        message.success(`已导入 ${result.imported} 个会话，失败 ${result.failed} 个${settingsText}`);
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
            maxWidth={180}
          />
        </Typography.Text>
      ),
    },
    {
      title: '类型',
      dataIndex: 'app_variant',
      width: 90,
      render: (value) => <Tag color={value === 'dingdong' ? 'blue' : 'gold'}>{value === 'dingdong' ? '叮咚' : '说道'}</Tag>,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      ellipsis: true,
      render: (value, record) => (
        <CopyableCell
          value={value}
          copied={copiedCell === `email:${record.id}`}
          onCopy={(copyValue) => void copyCellValue(`email:${record.id}`, copyValue)}
          maxWidth={220}
        />
      ),
    },
    {
      title: '手机号',
      dataIndex: 'phone',
      width: 140,
      render: (value) => (value ? <Tag color="green">{value}</Tag> : <Tag color="default">未绑定</Tag>),
    },
    {
      title: '用户 ID',
      dataIndex: 'dt_user_id',
      width: 170,
      render: (value, record) => (
        <CopyableCell
          value={value}
          copied={copiedCell === `user:${record.id}`}
          onCopy={(copyValue) => void copyCellValue(`user:${record.id}`, copyValue)}
          maxWidth={150}
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string, record) => {
        const item = statusMap[value] || { color: 'default', label: value };
        const tag = <Tag color={item.color}>{item.label}</Tag>;
        return record.last_error ? <Tooltip title={record.last_error}>{tag}</Tooltip> : tag;
      },
    },
    {
      title: '监听',
      dataIndex: 'monitor_enabled',
      width: 80,
      render: (value) => (value ? <Tag color="green">开启</Tag> : <Tag>停止</Tag>),
    },
    {
      title: 'Telegram',
      dataIndex: 'telegram_notify',
      width: 100,
      render: (value, record) => (
        <Switch size="small" checked={value} loading={actionLoading === record.id} onChange={(checked) => void handleTelegramToggle(record, checked)} />
      ),
    },
    {
      title: '未读',
      dataIndex: 'unread_count',
      width: 70,
      render: (value) => (value > 0 ? <Tag color="red">{value}</Tag> : <span style={{ color: '#999' }}>0</span>),
    },
    { title: '活跃号码', dataIndex: 'active_phone_count', width: 90 },
    {
      title: '最近登录',
      dataIndex: 'last_login_at',
      width: 140,
      render: (value) => (value ? dayjs(value).format('MM-DD HH:mm') : '-'),
    },
    {
      title: '操作',
      width: 220,
      render: (_, record) => (
        <Space size="small">
          <Button
            size="small"
            type={record.monitor_enabled ? 'default' : 'primary'}
            icon={record.monitor_enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            loading={actionLoading === record.id}
            disabled={record.status === 'pending'}
            onClick={() => void handleToggleMonitor(record.id, record.monitor_enabled)}
          >
            {record.monitor_enabled ? '停止' : '启动'}
          </Button>
          <Button size="small" onClick={() => navigate(`/accounts/${record.id}`)}>
            详情
          </Button>
          <Popconfirm
            title="确认删除此账户？相关消息和号码都会一起删除。"
            onConfirm={() => void handleDelete(record.id)}
            okText="确认删除"
            cancelText="取消"
          >
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <h2 style={{ margin: 0 }}>账户列表</h2>
        <Space wrap>
          <Input.Search
            placeholder="搜索备注 / 邮箱 / 手机号"
            allowClear
            onSearch={(value) => {
              setKeyword(value);
              setPage(1);
              void fetch(1, value);
            }}
            style={{ width: 260 }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void fetch()}>
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
      <Card>
        <Table
          columns={columns}
          dataSource={accounts}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1100 }}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            showTotal: (value) => `共 ${value} 个账户`,
            onChange: (currentPage) => {
              setPage(currentPage);
              void fetch(currentPage, keyword);
            },
          }}
        />
      </Card>
    </div>
  );
}
