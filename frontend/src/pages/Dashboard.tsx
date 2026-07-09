import { useEffect, useState } from 'react';
import { Card, Col, Row, Space, Statistic, Table, Tag, App } from 'antd';
import {
  UserOutlined,
  CheckCircleOutlined,
  MessageOutlined,
  PhoneOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { CACHE_TTL_MS, cacheKeys, getDashboardStats, getRecentMessages, isCachedDataFresh, readCachedData } from '../services/endpoints';
import type { DashboardStats, RecentMessage } from '../types';
import dayjs from 'dayjs';

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [messages, setMessages] = useState<RecentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { message: msg } = App.useApp();

  useEffect(() => {
    let cancelled = false;
    const statsKey = cacheKeys.dashboardStats;
    const messagesKey = cacheKeys.recentMessages(10);
    const cachedStats = readCachedData<DashboardStats>(statsKey);
    const cachedMessages = readCachedData<RecentMessage[]>(messagesKey);
    const hasCachedData = Boolean(cachedStats || cachedMessages);

    if (cachedStats) {
      setStats(cachedStats);
    }
    if (cachedMessages) {
      setMessages(cachedMessages);
    }
    if (hasCachedData) {
      setLoading(false);
    }

    const cacheFresh = isCachedDataFresh(statsKey, CACHE_TTL_MS.dashboard) && isCachedDataFresh(messagesKey, CACHE_TTL_MS.recentMessages);
    if (cacheFresh && cachedStats && cachedMessages) {
      return () => {
        cancelled = true;
      };
    }

    if (!hasCachedData) {
      setLoading(true);
    }
    Promise.all([getDashboardStats(), getRecentMessages(10)])
      .then(([s, m]) => {
        if (cancelled) return;
        setStats(s);
        setMessages(m);
      })
      .catch((err) => {
        if (!cancelled) msg.error(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [msg]);

  const msgColumns: ColumnsType<RecentMessage> = [
    {
      title: '账户',
      dataIndex: ['account', 'nickname'],
      width: 120,
      render: (text, record) => {
        const variant = record.account.app_variant ?? record.account.appVariant;
        return (
          <Space size={4}>
            <a onClick={() => navigate(`/accounts/${record.account_id}`)}>{text}</a>
            {variant ? (
              <Tag color={variant === 'dingdong' ? 'blue' : 'gold'}>
                {variant === 'dingdong' ? '叮咚' : '说道'}
              </Tag>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '来源',
      dataIndex: 'from_number',
      width: 130,
      render: (v) => v || '-',
    },
    {
      title: '内容',
      dataIndex: 'content',
      ellipsis: true,
    },
    {
      title: '类型',
      dataIndex: 'msg_type',
      width: 90,
      render: (t) => {
        const map: Record<string, { color: string; label: string }> = {
          verification: { color: 'blue', label: '验证码' },
          sms: { color: 'green', label: '短信' },
          mms: { color: 'purple', label: '彩信' },
          system: { color: 'default', label: '系统' },
        };
        const m = map[t] || { color: 'default', label: t };
        return <Tag color={m.color}>{m.label}</Tag>;
      },
    },
    {
      title: '时间',
      dataIndex: 'received_at',
      width: 160,
      render: (v) => (v ? dayjs(v).format('MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '已读',
      dataIndex: 'is_read',
      width: 60,
      render: (v) => (v ? <Tag color="default">已读</Tag> : <Tag color="red">未读</Tag>),
    },
  ];

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>仪表盘</h2>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={6}>
          <Card loading={loading}>
            <Statistic title="总账户" value={stats?.totalAccounts ?? 0} prefix={<UserOutlined />} />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={loading}>
            <Statistic
              title="在线"
              value={stats?.onlineAccounts ?? 0}
              suffix={`/ ${stats?.totalAccounts ?? 0}`}
              valueStyle={{ color: '#3f8600' }}
              prefix={<CheckCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={loading}>
            <Statistic
              title="总消息"
              value={stats?.totalMessages ?? 0}
              prefix={<MessageOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={6}>
          <Card loading={loading}>
            <Statistic
              title="活跃号码"
              value={stats?.activePhoneNumbers ?? 0}
              suffix={`/ ${stats?.totalPhoneNumbers ?? 0}`}
              prefix={<PhoneOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Card title="最近消息" style={{ marginTop: 24 }}>
        <Table
          columns={msgColumns}
          dataSource={messages}
          rowKey="id"
          loading={loading}
          pagination={false}
          size="small"
          onRow={(record) => ({
            onClick: () => navigate(`/accounts/${record.account_id}`),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>
    </div>
  );
}
