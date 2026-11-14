import React, { useState, useEffect } from 'react';
import { Card, Form, Select, Switch, Input, Button, Space, Tag, Typography, List, Empty, Popconfirm, Divider, message, Spin } from 'antd';
import {
  SaveOutlined, StopOutlined, ReloadOutlined, PlusOutlined
} from '@ant-design/icons';
import type { AccountPhoneSettings as SettingsType } from '../../services/endpoints';
import {
  getAccountPhoneSettings, updateAccountPhoneSettings, updateConversationSetting
} from '../../services/endpoints';
import type { PhoneNumber } from '../../types';

interface AccountPhoneSettingsProps {
  accountId: number;
  accountPhones?: PhoneNumber[];
}

export const AccountPhoneSettings: React.FC<AccountPhoneSettingsProps> = ({ accountId, accountPhones }) => {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [blockInput, setBlockInput] = useState('');
  const [form] = Form.useForm();

  const phonesList = (settings?.phones && settings.phones.length > 0)
    ? settings.phones
    : (accountPhones || []);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const data = await getAccountPhoneSettings(accountId);
      setSettings(data);
      const candidateCallerId = data.caller_id
        || (data.phones[0]?.phone_number || (data.phones[0] as any)?.phoneNumber)
        || (accountPhones?.[0]?.phone_number);
      form.setFieldsValue({
        caller_id: candidateCallerId || '',
        call_forward_enabled: data.call_forward_enabled,
        forward_number: data.forward_number,
        voicemail_enabled: data.voicemail_enabled
      });
    } catch {
      message.error('获取电话设置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, [accountId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      await updateAccountPhoneSettings(accountId, values);
      message.success('电话与通话设置保存成功');
      fetchSettings();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleUnblock = async (peer: string) => {
    try {
      await updateAccountPhoneSettings(accountId, { unblock_number: peer });
      message.success('已解除对 ' + peer + ' 的拦截');
      fetchSettings();
    } catch {
      message.error('解除拦截失败');
    }
  };

  const handleAddBlock = async () => {
    if (!blockInput.trim()) {
      message.warning('请输入要拦截的电话号码');
      return;
    }
    const peer = blockInput.trim();
    try {
      await updateConversationSetting(accountId, peer, { is_blocked: true });
      message.success('号码 ' + peer + ' 已加入黑名单拦截');
      setBlockInput('');
      fetchSettings();
    } catch {
      message.error('加入黑名单失败');
    }
  };

  if (loading && !settings) {
    return <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>;
  }

  return (
    <div style={{ maxWidth: 800 }}>
      <Card title="⚙️ 通信与号码设置" size="small" extra={<Button icon={<ReloadOutlined />} size="small" onClick={fetchSettings} />} style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical" onFinish={handleSave}>
          <Form.Item
            name="caller_id"
            label="主叫外呼显号 (Caller ID)"
            tooltip="选择外呼或发短信时对方手机上展示的主叫号码"
          >
            <Select style={{ width: '100%' }} placeholder="请选择外呼主叫号码">
              {phonesList.map((p) => {
                const num = (p as any).phone_number || (p as any).phoneNumber || '';
                const name = (p as any).display_name || (p as any).displayName || '';
                const isPrimary = Boolean((p as any).is_primary || (p as any).isPrimary);
                if (!num) return null;
                return (
                  <Select.Option key={num} value={num}>
                    {num} {name ? ('(' + name + ')') : ''} {isPrimary ? '🌟 默认主号' : ''}
                  </Select.Option>
                );
              })}
            </Select>
          </Form.Item>

          <Divider style={{ margin: '16px 0' }} />

          <Form.Item
            name="call_forward_enabled"
            label="呼叫转移 (Call Forwarding)"
            valuePropName="checked"
            tooltip="来电时自动将电话呼叫转接到您设定的目标号码"
          >
            <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.call_forward_enabled !== cur.call_forward_enabled}
          >
            {({ getFieldValue }) =>
              getFieldValue('call_forward_enabled') ? (
                <Form.Item name="forward_number" label="转接目标号码" rules={[{ required: true, message: '请输入转接目标电话号码' }]}>
                  <Input placeholder="包含国家码，如 +8613800000000 或 +14163424870" />
                </Form.Item>
              ) : null
            }
          </Form.Item>

          <Divider style={{ margin: '16px 0' }} />

          <Form.Item
            name="voicemail_enabled"
            label="语音信箱 (Voicemail)"
            valuePropName="checked"
            tooltip="无人接听或占线时自动转入语音信箱留言"
          >
            <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
          </Form.Item>

          <Form.Item style={{ marginTop: 24 }}>
            <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={saving}>
              保存设置
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="🚫 黑名单与防骚扰拦截管理" size="small">
        <div style={{ marginBottom: 16 }}>
          <Space.Compact style={{ width: '100%', maxWidth: 400 }}>
            <Input
              placeholder="输入要拦截的电话号码，如 +1234567890"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              onPressEnter={handleAddBlock}
            />
            <Button type="primary" danger icon={<PlusOutlined />} onClick={handleAddBlock}>
              添加拦截
            </Button>
          </Space.Compact>
        </div>

        <List
          size="small"
          bordered
          dataSource={settings?.blocked_numbers || []}
          locale={{ emptyText: <Empty description="当前暂无被拦截的号码" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(num) => (
            <List.Item
              actions={[
                <Popconfirm title="确认解除对该号码的拦截？" onConfirm={() => handleUnblock(num)}>
                  <Button size="small" type="link">解除拦截</Button>
                </Popconfirm>
              ]}
            >
              <Space>
                <StopOutlined style={{ color: '#ff4d4f' }} />
                <Typography.Text strong>{num}</Typography.Text>
                <Tag color="error">已拒收短信与推送</Tag>
              </Space>
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
};
export default AccountPhoneSettings;
