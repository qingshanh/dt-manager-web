import React, { useState, useEffect } from 'react';
import { Card, Table, Segmented, Tag, Typography, Space, Button, Empty, Tooltip, message, Input, Modal, Alert } from 'antd';
import {
  ReloadOutlined, MessageOutlined, ArrowUpOutlined, ArrowDownOutlined, CloseCircleOutlined,
  PhoneOutlined, QuestionCircleOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { CallRecordItem } from '../../services/endpoints';
import { getAccountCallHistory, getAccountVoicemails, dialAccountCall } from '../../services/endpoints';
import type { ColumnsType } from 'antd/es/table';

interface AccountCallsProps {
  accountId: number;
  onSelectChat?: (phoneNumber: string) => void;
}

export const AccountCalls: React.FC<AccountCallsProps> = ({ accountId, onSelectChat }) => {
  const [activeTab, setActiveTab] = useState<'history' | 'voicemail'>('history');
  const [records, setRecords] = useState<CallRecordItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialTarget, setDialTarget] = useState('');
  const [dialing, setDialing] = useState(false);
  const [helpModalOpen, setHelpModalOpen] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    try {
      if (activeTab === 'history') {
        const data = await getAccountCallHistory(accountId);
        setRecords(data || []);
      } else {
        const data = await getAccountVoicemails(accountId);
        setRecords(data || []);
      }
    } catch {
      message.error('获取通话/信箱数据失败');
    } finally {
      setLoading(false)
    }
  };

  useEffect(() => {
    fetchData();
  }, [accountId, activeTab]);

  const handleDial = async () => {
    if (!dialTarget.trim()) {
      message.warning('请输入要拨打的电话号码');
      return;
    }
    setDialing(true);
    try {
      const res = await dialAccountCall(accountId, { to: dialTarget.trim() });
      message.success(res.message);
      setDialTarget('');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发起呼叫失败');
    } finally {
      setDialing(false);
    }
  };

  const historyColumns: ColumnsType<CallRecordItem> = [
    {
      title: '类型',
      dataIndex: 'direction',
      width: 100,
      render: (dir: string) => {
        if (dir === 'outbound') return <Tag color="blue" icon={<ArrowUpOutlined />}>呼出</Tag>;
        if (dir === 'missed') return <Tag color="red" icon={<CloseCircleOutlined />}>未接</Tag>;
        return <Tag color="green" icon={<ArrowDownOutlined />}>呼入</Tag>;
      }
    },
    {
      title: '对方号码',
      dataIndex: 'peer_number',
      width: 180,
      render: (phone: string) => (
        <Typography.Text copyable={{ text: phone, tooltips: ['复制号码', '已复制'] }}>
          {phone}
        </Typography.Text>
      )
    },
    {
      title: '我方号码',
      dataIndex: 'my_number',
      width: 170,
      render: (phone?: string | null) => phone || '-'
    },
    {
      title: '呼叫时间',
      dataIndex: 'call_time',
      width: 180,
      render: (time: string) => dayjs(time).format('YYYY-MM-DD HH:mm:ss')
    },
    {
      title: '通话时长',
      dataIndex: 'duration_label',
      width: 120,
      render: (label: string, r) => (
        <span style={{ color: r.duration === 0 ? '#8c8c8c' : '#262626' }}>{label}</span>
      )
    },
    {
      title: '扣费',
      dataIndex: 'cost_credits',
      width: 110,
      render: (cost?: number | null) => (
        <span>{cost && cost > 0 ? (cost.toFixed(2) + ' 币') : '免费'}</span>
      )
    },
    {
      title: '操作',
      width: 120,
      render: (_, r) => (
        <Button
          size="small"
          icon={<MessageOutlined />}
          onClick={() => onSelectChat?.(r.peer_number)}
        >
          发短信
        </Button>
      )
    }
  ];

  const voicemailColumns: ColumnsType<CallRecordItem> = [
    {
      title: '来电号码',
      dataIndex: 'peer_number',
      width: 180,
      render: (phone: string) => (
        <Typography.Text copyable={{ text: phone, tooltips: ['复制号码', '已复制'] }}>
          {phone}
        </Typography.Text>
      )
    },
    {
      title: '留言时间',
      dataIndex: 'call_time',
      width: 180,
      render: (time: string) => dayjs(time).format('YYYY-MM-DD HH:mm:ss')
    },
    {
      title: '留言时长',
      dataIndex: 'duration_label',
      width: 110,
      render: (label: string) => <Tag color="purple">{label}</Tag>
    },
    {
      title: '在线试听',
      dataIndex: 'voicemail_url',
      render: (url?: string | null) => {
        if (!url) return <Typography.Text type="secondary">暂无音频文件</Typography.Text>;
        return (
          <audio controls src={url} style={{ height: 32, verticalAlign: 'middle', maxWidth: 260 }}>
            您的浏览器不支持在线音频播放
          </audio>
        );
      }
    },
    {
      title: '操作',
      width: 120,
      render: (_, r) => (
        <Button
          size="small"
          icon={<MessageOutlined />}
          onClick={() => onSelectChat?.(r.peer_number)}
        >
          发短信
        </Button>
      )
    }
  ];

  return (
    <Card size="small" style={{ minHeight: 520 }}>
      <div style={{ padding: '12px 16px', background: '#fafafa', borderRadius: 8, marginBottom: 16, border: '1px solid #f0f0f0' }}>
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space align="center">
              <PhoneOutlined style={{ color: '#1677ff', fontSize: 16 }} />
              <Typography.Text strong>📞 拨打电话 / 发起外呼</Typography.Text>
            </Space>
            <Button size="small" icon={<QuestionCircleOutlined />} type="link" onClick={() => setHelpModalOpen(true)}>
              接打电话说明
            </Button>
          </div>
          <Space.Compact style={{ width: '100%', maxWidth: 460 }}>
            <Input
              placeholder="输入目标电话号码 (含国家码，如 +16699998659)"
              value={dialTarget}
              onChange={(e) => setDialTarget(e.target.value)}
              onPressEnter={handleDial}
            />
            <Button type="primary" icon={<PhoneOutlined />} loading={dialing} onClick={handleDial}>
              发起呼叫
            </Button>
          </Space.Compact>
        </Space>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Segmented
          value={activeTab}
          options={[
            { label: '📞 通话记录', value: 'history' },
            { label: '🎙️ 语音信箱与录音', value: 'voicemail' },
          ]}
          onChange={(v) => setActiveTab(v as 'history' | 'voicemail')}
        />
        <Space>
          <Tooltip title="刷新"><Button size="small" icon={<ReloadOutlined />} onClick={fetchData} /></Tooltip>
        </Space>
      </div>

      <Table
        dataSource={records}
        columns={activeTab === 'history' ? historyColumns : voicemailColumns}
        rowKey="id"
        loading={loading}
        size="middle"
        pagination={{ pageSize: 15, showTotal: (t) => '共 ' + t + ' 条记录' }}
        locale={{ emptyText: <Empty description={activeTab === 'history' ? '暂无通话记录' : '暂无语音信箱留言'} /> }}
      />

      <Modal
        title="📞 说道/叮咚接打电话机制说明"
        open={helpModalOpen}
        onOk={() => setHelpModalOpen(false)}
        onCancel={() => setHelpModalOpen(false)}
        footer={[<Button key="ok" type="primary" onClick={() => setHelpModalOpen(false)}>知道了</Button>]}
      >
        <div style={{ lineHeight: 1.8 }}>
          <Alert
            type="info"
            showIcon
            message="当前接打电话的核心工作模式"
            description={
              <div>
                <div>1. <b>呼出电话 (外呼)</b>：输入目标号码并点击“发起呼叫”，若已连接模拟器或真机，将即时调起客户端拨号外呼；也可触发 PSTN 双向回拨（服务器先呼叫您的绑定手机，接通后再呼叫目标手机）。</div>
                <div>2. <b>呼入电话 (接听)</b>：说道/叮咚采用私有加密 VoIP 流媒体协议（位于客户端 <code>libtalkyou.so</code> 底层），在浏览器 Web 端暂无法直接进行麦克风双向实时语音。建议在手机或模拟器端接听来电。</div>
                <div>3. <b>语音信箱 (Voicemail) 自动接收</b>：当有人呼叫您的号码且无人接听时，对方可留言，录音音频会实时同步至本面板的“语音信箱与录音”中，支持<b>在线播放试听与下载</b>！</div>
              </div>
            }
            style={{ marginBottom: 12 }}
          />
        </div>
      </Modal>
    </Card>
  );
};
export default AccountCalls;
