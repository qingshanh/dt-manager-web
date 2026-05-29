import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
} from 'antd';
import { ApiOutlined, CloudServerOutlined, RobotOutlined } from '@ant-design/icons';
import { getSettings, testTelegram, updateSettings } from '../services/endpoints';
import type { SettingItem } from '../types';

type GatewayMode = 'mock' | 'real' | 'bridge' | 'direct';

const gatewayModeOptions: Array<{
  value: GatewayMode;
  label: string;
  description: string;
  color: string;
}> = [
  {
    value: 'mock',
    label: 'mock',
    description: '演示模式。接口会返回模拟数据，适合先跑通前后端界面。',
    color: 'orange',
  },
  {
    value: 'real',
    label: 'real',
    description: '真实模式。后端通过 helper 调用已登录 app，适合验证码登录和抓取真实登录态。',
    color: 'green',
  },
  {
    value: 'bridge',
    label: 'bridge',
    description: '桥接模式。和 real 一样走 helper，只是兼容另一种命名方式。',
    color: 'cyan',
  },
  {
    value: 'direct',
    label: 'direct',
    description: '直连模式。适合导入 dtUserId/token/deviceId 后，不再依赖 app 持续运行。',
    color: 'blue',
  },
];

function toMap(items: SettingItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.key, item.value]));
}

function toFormMap(items: SettingItem[]) {
  const map: Record<string, string | boolean> = toMap(items);
  map.telegram_bot_enabled = map.telegram_bot_enabled === 'true';
  return map;
}

export default function Settings() {
  const [items, setItems] = useState<SettingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const { message } = App.useApp();

  const [telegramForm] = Form.useForm();
  const [serverForm] = Form.useForm();
  const [generalForm] = Form.useForm();

  useEffect(() => {
    getSettings()
      .then((data) => {
        setItems(data);
        const map = toFormMap(data);
        telegramForm.setFieldsValue(map);
        serverForm.setFieldsValue(map);
        generalForm.setFieldsValue(map);
      })
      .catch((err) => message.error(err.message))
      .finally(() => setLoading(false));
  }, [generalForm, message, serverForm, telegramForm]);

  const handleSave = async (values: Record<string, string | number | boolean>) => {
    setSaving(true);
    try {
      const updated = await updateSettings(values);
      setItems(updated);
      const map = toFormMap(updated);
      telegramForm.setFieldsValue(map);
      serverForm.setFieldsValue(map);
      generalForm.setFieldsValue(map);
      message.success('设置已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTestTelegram = async () => {
    setTesting(true);
    try {
      await testTelegram();
      message.success('Telegram 测试消息发送成功');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '测试失败，请检查 Bot Token 和 Chat ID');
    } finally {
      setTesting(false);
    }
  };

  const settingsMap = useMemo(() => toMap(items), [items]);
  const activeMode = (settingsMap.DT_GATEWAY_MODE || 'mock') as GatewayMode;
  const activeModeMeta = gatewayModeOptions.find((item) => item.value === activeMode) ?? gatewayModeOptions[0];

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>系统设置</h2>

      <Tabs
        defaultActiveKey="server"
        items={[
          {
            key: 'server',
            forceRender: true,
            label: (
              <span>
                <CloudServerOutlined /> 网关与连接
              </span>
            ),
            children: (
              <Card loading={loading}>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message="先选运行模式，再补对应连接项"
                  description="real/bridge 依赖 helper 和已登录 app；direct 适合导入会话后长期独立运行；mock 只用于联调演示。"
                />
                <Form
                  form={serverForm}
                  layout="vertical"
                  onFinish={(values) => handleSave(values as Record<string, string | number | boolean>)}
                >
                  <Form.Item
                    label="网关模式"
                    name="DT_GATEWAY_MODE"
                    extra="保存后会按新模式处理账户登录、刷新、号码同步和短信监听。"
                  >
                    <Select
                      options={gatewayModeOptions.map((item) => ({
                        value: item.value,
                        label: `${item.label} - ${item.description}`,
                      }))}
                    />
                  </Form.Item>

                  <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
                    <Space direction="vertical" size={4}>
                      <div>
                        当前模式：<Tag color={activeModeMeta.color}>{activeModeMeta.label}</Tag>
                      </div>
                      <div style={{ color: '#666' }}>{activeModeMeta.description}</div>
                    </Space>
                  </Card>

                  <Form.Item
                    label="helper 地址（real / bridge 用）"
                    name="dt_real_bridge_base_url"
                    help="例如 http://127.0.0.1:19091。验证码登录、抓取 app 登录态、helper 短信同步都依赖它。"
                  >
                    <Input placeholder="http://127.0.0.1:19091" />
                  </Form.Item>

                  <Form.Item
                    label="helper 鉴权令牌"
                    name="dt_real_bridge_token"
                    help="如果 helper 没有做鉴权，可以留空。"
                  >
                    <Input placeholder="optional helper token" />
                  </Form.Item>

                  <Form.Item
                    label="helper 超时（毫秒）"
                    name="dt_real_bridge_timeout_ms"
                    help="模拟器较慢或注入较慢时可适当调大。"
                  >
                    <InputNumber min={5000} max={180000} style={{ width: '100%' }} />
                  </Form.Item>

                  <Form.Item
                    label="请求代理地址（可选）"
                    name="dt_proxy_url"
                    help="只有在你自建转发或特殊网络环境下才需要填写。"
                  >
                    <Input placeholder="https://my-proxy.example.com/api" />
                  </Form.Item>

                  <Divider>直连服务器参数</Divider>

                  <Form.Item label="主服务器 IP" name="dt_server_ip">
                    <Input placeholder="139.224.25.197" />
                  </Form.Item>
                  <Form.Item label="主服务器端口" name="dt_server_port">
                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="备用服务器 IP" name="dt_backup_ip">
                    <Input placeholder="47.103.133.227" />
                  </Form.Item>
                  <Form.Item
                    label="direct 是否启用 TLS"
                    name="dt_direct_use_tls"
                    help="大多数情况下保持默认即可。"
                  >
                    <Select
                      options={[
                        { value: 'true', label: 'true - 使用 TLS' },
                        { value: 'false', label: 'false - 明文 TCP' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    label="直连监听最大并发"
                    name="direct_monitor_max_concurrent"
                    help="低配 VPS 可设为 1-3 限制同时打开的直连短信监听连接；0 表示不限制。"
                  >
                    <InputNumber min={0} max={100} style={{ width: '100%' }} />
                  </Form.Item>

                  <Divider>direct 号码模板</Divider>

                  <Form.Item
                    label="购买号码 direct API"
                    name="dt_direct_api_purchase_phone"
                    help="默认 /pstn/share/orderPrivateNumber；如后续抓包确认不同，可在这里覆盖并随会话导出。"
                  >
                    <Input placeholder="/pstn/share/orderPrivateNumber" />
                  </Form.Item>
                  <Form.Item label="续费号码 direct API" name="dt_direct_api_renew_phone">
                    <Input placeholder="/pstn/share/orderPrivateNumber" />
                  </Form.Item>
                  <Form.Item label="取消号码 direct API" name="dt_direct_api_cancel_phone">
                    <Input placeholder="/pstn/share/deletePhoneNumber" />
                  </Form.Item>
                  <Form.Item label="暂停号码 direct API" name="dt_direct_api_pause_phone">
                    <Input placeholder="/pstn/share/privateNumberSetting" />
                  </Form.Item>
                  <Form.Item label="恢复号码 direct API" name="dt_direct_api_resume_phone">
                    <Input placeholder="/pstn/share/privateNumberSetting" />
                  </Form.Item>
                  <Form.Item label="恢复暂停号码备用 API" name="dt_direct_api_reactivate_phone">
                    <Input placeholder="/pstn/share/reactivateGoogleVoiceNumber" />
                  </Form.Item>

                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="这些模板需要先从 app 抓包或 verify-direct-session 验证后再粘贴"
                    description={'支持直接填 hex，或填 {"name":"requestPhone","hex":"0107...","params":{"countryCode":"$countryCode"}} 这种 JSON。留空时该动作会明确提示未配置。'}
                  />

                  <Form.Item label="选号候选模板" name="dt_direct_template_request_phone">
                    <Input.TextArea rows={3} placeholder='{"name":"requestPhone","hex":"0107...","params":{"countryCode":"$countryCode"}}' />
                  </Form.Item>
                  <Form.Item label="购买号码模板" name="dt_direct_template_purchase_phone">
                    <Input.TextArea rows={3} placeholder='{"name":"purchasePhone","hex":"0107...","params":{"phoneNumber":"$phoneNumber","countryCode":"$countryCode"}}' />
                  </Form.Item>
                  <Form.Item label="续费号码模板" name="dt_direct_template_renew_phone">
                    <Input.TextArea rows={3} placeholder='{"name":"renewPhone","hex":"0107...","params":{"phoneNumber":"$phoneNumber"}}' />
                  </Form.Item>
                  <Form.Item label="取消号码模板" name="dt_direct_template_cancel_phone">
                    <Input.TextArea rows={3} placeholder='{"name":"cancelPhone","hex":"0107...","params":{"phoneNumber":"$phoneNumber"}}' />
                  </Form.Item>
                  <Form.Item label="暂停号码模板" name="dt_direct_template_pause_phone">
                    <Input.TextArea rows={3} placeholder='{"name":"pausePhone","hex":"0107...","params":{"phoneNumber":"$phoneNumber","suspendFlag":"$suspendFlag"}}' />
                  </Form.Item>
                  <Form.Item label="恢复号码模板" name="dt_direct_template_resume_phone">
                    <Input.TextArea rows={3} placeholder='{"name":"resumePhone","hex":"0107...","params":{"phoneNumber":"$phoneNumber","suspendFlag":"$suspendFlag"}}' />
                  </Form.Item>
                  <Form.Item
                    label="暂停/恢复共用模板"
                    name="dt_direct_template_phone_setting"
                    help="如果暂停和恢复是同一个 app 接口，可以只填这里，动作里会传 action 和 suspendFlag。"
                  >
                    <Input.TextArea rows={3} placeholder='{"name":"phoneSetting","hex":"0107...","params":{"phoneNumber":"$phoneNumber","action":"$action","suspendFlag":"$suspendFlag"}}' />
                  </Form.Item>
                  <Form.Item
                    label="离线短信拉取模板"
                    name="dt_direct_template_offline_messages"
                    help="可粘贴 app 登录后 requestAllOfflineMessage / getWebOfflineMessage 的直连帧。监听新短信前会先发送该模板，用于关掉模拟器后补拉离线消息。"
                  >
                    <Input.TextArea rows={3} placeholder='{"name":"offlineMessages","hex":"0107..."}' />
                  </Form.Item>

                  <Button type="primary" htmlType="submit" loading={saving}>
                    保存
                  </Button>
                </Form>
              </Card>
            ),
          },
          {
            key: 'telegram',
            forceRender: true,
            label: (
              <span>
                <RobotOutlined /> Telegram 通知
              </span>
            ),
            children: (
              <Card loading={loading}>
                <Form
                  form={telegramForm}
                  layout="vertical"
                  onFinish={(values) => handleSave(values as Record<string, string | number | boolean>)}
                >
                  <Form.Item label="Bot Token" name="telegram_bot_token">
                    <Input.Password placeholder="123456:ABC-DEF1234ghiklm..." />
                  </Form.Item>
                  <Form.Item label="Chat ID" name="telegram_chat_id">
                    <Input placeholder="-1001234567890" />
                  </Form.Item>
                  <Form.Item
                    label="Telegram API 地址"
                    name="telegram_api_base_url"
                    help="留空默认走官方接口；如果你有反代，可以填反代基础地址。"
                  >
                    <Input placeholder="https://your-proxy.example.com/telegram" />
                  </Form.Item>
                  <Form.Item label="机器人控制面板" name="telegram_bot_enabled" valuePropName="checked">
                    <Switch checkedChildren="启用" unCheckedChildren="停用" />
                  </Form.Item>
                  <Form.Item
                    label="机器人白名单"
                    name="telegram_allowed_chat_ids"
                    help="填写允许控制机器人的 Telegram user_id、群组 ID 或频道 ID，多个用逗号、空格或换行分隔。"
                  >
                    <Input.TextArea rows={3} placeholder="-1001234567890, 123456789" />
                  </Form.Item>
                  <Form.Item label="机器人轮询间隔（秒）" name="telegram_bot_poll_interval_seconds">
                    <InputNumber min={5} max={120} style={{ width: '100%' }} />
                  </Form.Item>
                  <Space>
                    <Button type="primary" htmlType="submit" loading={saving}>
                      保存
                    </Button>
                    <Button onClick={handleTestTelegram} loading={testing}>
                      发送测试消息
                    </Button>
                  </Space>
                </Form>
              </Card>
            ),
          },
          {
            key: 'general',
            forceRender: true,
            label: (
              <span>
                <ApiOutlined /> 通用设置
              </span>
            ),
            children: (
              <Card loading={loading}>
                <Form
                  form={generalForm}
                  layout="vertical"
                  onFinish={(values) => handleSave(values as Record<string, string | number | boolean>)}
                >
                  <Form.Item label="消息轮询间隔（秒）" name="message_poll_interval">
                    <InputNumber min={10} max={600} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="Direct 短信监听窗口（秒）" name="direct_message_listen_seconds">
                    <InputNumber min={10} max={1800} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="Direct 手动刷新等待（秒）" name="direct_message_refresh_wait_seconds">
                    <InputNumber min={10} max={120} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="自动刷新间隔（秒）" name="auto_refresh_interval">
                    <InputNumber min={60} max={3600} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="最大重试次数" name="max_retry_count">
                    <InputNumber min={1} max={20} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="启动监听恢复间隔（秒）" name="monitor_restore_delay">
                    <InputNumber min={1} max={300} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item label="日志级别" name="log_level">
                    <Select
                      options={[
                        { value: 'debug', label: 'Debug' },
                        { value: 'info', label: 'Info' },
                        { value: 'warn', label: 'Warn' },
                        { value: 'error', label: 'Error' },
                      ]}
                    />
                  </Form.Item>
                  <Button type="primary" htmlType="submit" loading={saving}>
                    保存
                  </Button>
                </Form>
              </Card>
            ),
          },
          {
            key: 'about',
            label: '关于',
            children: (
              <Card>
                <Descriptions bordered column={1} size="small">
                  <Descriptions.Item label="项目名称">说道多账户管理平台</Descriptions.Item>
                  <Descriptions.Item label="后端">Node.js + Express + Prisma + SQLite</Descriptions.Item>
                  <Descriptions.Item label="前端">React + TypeScript + Ant Design</Descriptions.Item>
                  <Descriptions.Item label="当前网关模式">
                    <Tag color={activeModeMeta.color}>{activeModeMeta.label}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="模式说明">{activeModeMeta.description}</Descriptions.Item>
                  <Descriptions.Item label="API 端口">{settingsMap.PORT || '3000'}</Descriptions.Item>
                </Descriptions>
              </Card>
            ),
          },
        ]}
      />
    </div>
  );
}
