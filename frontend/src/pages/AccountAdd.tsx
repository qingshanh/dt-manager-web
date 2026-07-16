import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Select, Space, Steps, Tag, Typography } from 'antd';
import { MailOutlined, NumberOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { createAccount, getAccount, getSettings, sendVerificationCode, verifyCode } from '../services/endpoints';
import type { AppVariant, CreateAccountRequest, LoginType, SettingItem } from '../types';

type CreateFormValues = {
  nickname?: string;
  email?: string;
  deviceId?: string;
};

function toMap(items: SettingItem[]) {
  return Object.fromEntries(items.map((item) => [item.key, item.value]));
}

export default function AccountAdd() {
  const [step, setStep] = useState(0);
  const [loginType, setLoginType] = useState<LoginType>('email_code');
  const [appVariant, setAppVariant] = useState<AppVariant>('dingtone');
  const [accountId, setAccountId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const { message } = App.useApp();

  useEffect(() => {
    getSettings()
      .then((items) => {
        const map = toMap(items);
        setSettings(map);
        if (map.DT_GATEWAY_MODE === 'direct') {
          setLoginType('email_code');
        }
      })
      .catch(() => undefined);
  }, []);

  const isMockMode = settings.DT_GATEWAY_MODE === 'mock';
  const isDirectMode = settings.DT_GATEWAY_MODE === 'direct';
  const variantLabel = useMemo(() => (appVariant === 'dingdong' ? '叮咚' : '说道'), [appVariant]);
  const isVerificationLogin = loginType === 'email_code';
  const verificationTargetLabel = '邮箱';
  const verificationDeliveryLabel = '邮件';

  const watchPendingVerificationSend = async (id: number) => {
    for (let i = 0; i < 18; i += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5_000));
      try {
        const detail = await getAccount(id);
        if (detail.last_error) {
          message.error('验证码发送失败：' + detail.last_error, 10);
          return;
        }
      } catch {
        return;
      }
    }
  };
  const handleCreate = async (values: CreateFormValues) => {
    setLoading(true);
    try {
      const params: CreateAccountRequest = {
        nickname: values.nickname?.trim() || undefined,
        app_variant: appVariant,
        login_type: loginType,
        device_id: values.deviceId?.trim() || undefined,
      };

      if (loginType === 'email_code' || loginType === 'manual_session') {
        params.email = values.email?.trim() || undefined;
      }

      const result = await createAccount(params);

      if (isVerificationLogin) {
        const targetAccountId = result.account_id ?? result.id;
        setAccountId(targetAccountId);
        setStep(1);
        if (result.send_pending) {
          message.warning(result.message || '验证码请求已提交；如果你已经收到验证码，可以直接输入继续登录。');
          void watchPendingVerificationSend(targetAccountId);
          return;
        }
        if (result.mock && result.verification_code) {
          message.info(`当前是 mock 模式，请直接输入固定验证码：${result.verification_code}`);
        } else {
          message.success(result.message || `验证码已发送，请查收${verificationDeliveryLabel}`);
        }
        return;
      }

      if (loginType === 'manual_session') {
        message.success(result.message || '账户已创建，请继续导入直连会话');
        navigate(`/accounts/${result.id}`);
        return;
      }

      message.success(result.reused ? '已复用原账户并更新登录信息' : '账户添加成功');
      navigate(`/accounts/${result.id}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (values: { code: string }) => {
    if (!accountId) return;
    setLoading(true);
    try {
      const result = await verifyCode(accountId, values.code);
      if (result.refresh_error) {
        message.warning(`验证成功，但资料刷新未完成：${result.refresh_error}`);
      } else {
        message.success('验证成功，账户已登录并刷新资料');
      }
      navigate(`/accounts/${accountId}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '验证失败');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (!accountId) return;
    try {
      const result = await sendVerificationCode(accountId);
      const targetAccountId = result.account_id ?? accountId;
      if (result.account_id) {
        setAccountId(result.account_id);
      }
      if (result.send_pending) {
          message.warning(result.message || '验证码请求已提交；如果你已经收到验证码，可以直接输入继续登录。');
          void watchPendingVerificationSend(targetAccountId);
          return;
        }
      if (result.mock && result.verification_code) {
        message.info(`mock 模式固定验证码：${result.verification_code}`);
      } else {
        message.success(result.message || `验证码已重新发送，请查收${verificationDeliveryLabel}`);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败');
    }
  };

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <Space align="center" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>添加账户</h2>
        <Tag color={appVariant === 'dingdong' ? 'blue' : 'gold'}>{variantLabel}</Tag>
      </Space>

      {isMockMode && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="当前后端运行在 mock 模式"
          description={`不会真实连接说道/叮咚服务，也不会真实发送${verificationTargetLabel}验证码。验证码流程请使用固定验证码 123456。`}
        />
      )}

      {isDirectMode && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message="当前后端运行在 direct 直连模式"
          description="邮箱验证码登录会直接调用说道/叮咚接口，不依赖模拟器或 helper。"
        />
      )}

      <Steps
        current={step}
        items={[
          { title: '填写信息' },
          { title: '验证邮箱' },
          { title: '完成' },
        ]}
        style={{ marginBottom: 32 }}
      />

      {step === 0 && (
        <Card>
          <Form layout="vertical" onFinish={handleCreate}>
            <Form.Item label="应用类型" required>
              <Select
                value={appVariant}
                onChange={(value: AppVariant) => setAppVariant(value)}
                options={[
                  { value: 'dingtone', label: '说道 Dingtone / TalkU' },
                  { value: 'dingdong', label: '叮咚 Dingdong' },
                ]}
              />
            </Form.Item>

            <Form.Item label="接入方式" required>
              <Select
                value={loginType}
                onChange={(value: LoginType) => setLoginType(value)}
                options={[
                  { value: 'email_code', label: '邮箱 + 验证码' },
                  { value: 'manual_session', label: '手动导入直连会话' },
                ]}
              />
            </Form.Item>

            <Form.Item
              label="备注名称"
              name="nickname"
              extra="可以不填；留空时，登录成功后默认显示账户邮箱、手机号或资料名称。"
            >
              <Input maxLength={100} showCount placeholder="如：我的主号（可选）" />
            </Form.Item>

            <Form.Item
              label="设备 ID (deviceId)"
              name="deviceId"
              extra="可选。如果您希望使用特定的已在官方注册的设备，请在此处填写其设备 ID（如 And.xxxxx.dttalk）。不填时系统将自动生成。"
            >
              <Input placeholder="可选：例如 And.0123456789abcdef0123456789abcdef.dttalk" />
            </Form.Item>

            {loginType === 'manual_session' && (
              <Alert
                style={{ marginBottom: 16 }}
                type="info"
                showIcon
                message="先创建占位账户，再导入真实会话"
                description="这个入口不会触发登录。创建完成后，请到详情页导入 dtUserId、token、deviceId。"
              />
            )}

            {(loginType === 'email_code' || loginType === 'manual_session') && (
              <Form.Item
                label="邮箱"
                name="email"
                rules={
                  loginType === 'manual_session'
                    ? [{ type: 'email', message: '邮箱格式不正确' }]
                    : [
                        { required: true, message: '请输入邮箱' },
                        { type: 'email', message: '邮箱格式不正确' },
                      ]
                }
              >
                <Input prefix={<MailOutlined />} placeholder="user@example.com" />
              </Form.Item>
            )}

            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                {isVerificationLogin
                  ? '发送验证码'
                  : loginType === 'manual_session'
                    ? '创建并去导入会话'
                    : '添加账户'}
              </Button>
            </Form.Item>
          </Form>
        </Card>
      )}

      {step === 1 && (
        <Card>
          <Typography.Paragraph style={{ marginBottom: 16 }}>
            {isMockMode
              ? `当前是 mock 模式，不会收到真实${verificationDeliveryLabel}，请直接输入固定验证码 123456。`
              : '验证码已发送至邮箱，请输入收到的验证码。'}
          </Typography.Paragraph>
          <Form layout="vertical" onFinish={handleVerify}>
            <Form.Item label="验证码" name="code" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input prefix={<NumberOutlined />} placeholder="验证码" />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block>
                验证并登录
              </Button>
            </Form.Item>
            <Form.Item style={{ textAlign: 'center', marginBottom: 0 }}>
              <Button type="link" onClick={handleResend}>
                重新发送验证码
              </Button>
            </Form.Item>
          </Form>
        </Card>
      )}
    </div>
  );
}
