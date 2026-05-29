import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Card, Form, Input, Select, Space, Steps, Tag, Typography } from 'antd';
import { LockOutlined, MailOutlined, NumberOutlined, PhoneOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { createAccount, getSettings, sendVerificationCode, verifyCode } from '../services/endpoints';
import type { AppVariant, CreateAccountRequest, LoginType, SettingItem } from '../types';

type CreateFormValues = {
  nickname?: string;
  email?: string;
  phone?: string;
  password?: string;
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
          setLoginType('manual_session');
        }
      })
      .catch(() => undefined);
  }, []);

  const isMockMode = settings.DT_GATEWAY_MODE === 'mock';
  const isDirectMode = settings.DT_GATEWAY_MODE === 'direct';
  const variantLabel = useMemo(() => (appVariant === 'dingdong' ? '叮咚' : '说道'), [appVariant]);
  const isVerificationLogin = loginType === 'email_code' || loginType === 'phone_code';
  const verificationTargetLabel = loginType === 'phone_code' ? '手机号' : '邮箱';
  const verificationDeliveryLabel = loginType === 'phone_code' ? '短信' : '邮件';

  const handleCreate = async (values: CreateFormValues) => {
    setLoading(true);
    try {
      const params: CreateAccountRequest = {
        nickname: values.nickname?.trim() || undefined,
        app_variant: appVariant,
        login_type: loginType,
      };

      if (loginType === 'email_code' || loginType === 'email_password' || loginType === 'manual_session') {
        params.email = values.email?.trim() || undefined;
      }
      if (loginType === 'phone_code' || loginType === 'phone_password') {
        params.phone = values.phone?.trim() || undefined;
      }
      if (loginType === 'email_password' || loginType === 'phone_password') {
        params.password = values.password;
      }

      const result = await createAccount(params);

      if (isVerificationLogin) {
        setAccountId(result.id);
        setStep(1);
        if (result.mock && result.verification_code) {
          message.info(`当前是 mock 模式，请直接输入固定验证码 ${result.verification_code}`);
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
      await verifyCode(accountId, values.code);
      message.success('验证成功，账户已登录');
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
          description="这个模式不依赖原生 app。首次接入建议使用“手动导入直连会话”，创建后到详情页填写 dtUserId、token、deviceId，或直接从 helper 抓取已登录会话。"
        />
      )}

      <Steps
        current={step}
        items={[
          { title: '填写信息' },
          { title: loginType === 'phone_code' ? '验证手机号' : '验证邮箱' },
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
                onChange={(value) => setAppVariant(value)}
                options={[
                  { value: 'dingtone', label: '说道 Dingtone / TalkU' },
                  { value: 'dingdong', label: '叮咚 Dingdong' },
                ]}
              />
            </Form.Item>

            <Form.Item label="接入方式" required>
              <Select
                value={loginType}
                onChange={(value) => setLoginType(value)}
                options={[
                  { value: 'manual_session', label: '手动导入直连会话' },
                  { value: 'email_code', label: '邮箱 + 验证码' },
                  { value: 'phone_code', label: '手机号 + 验证码' },
                  { value: 'email_password', label: '邮箱 + 密码' },
                  { value: 'phone_password', label: '手机号 + 密码' },
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

            {loginType === 'manual_session' && (
              <Alert
                style={{ marginBottom: 16 }}
                type="info"
                showIcon
                message="先创建占位账户，再导入真实会话"
                description="这个入口不会触发登录，也不会依赖 app。创建完成后，请到详情页点击“导入直连会话”，填入 dtUserId、token、deviceId；如果你仍保留 helper，也可以点击“抓取 helper 会话”。"
              />
            )}

            {(loginType === 'email_code' || loginType === 'email_password' || loginType === 'manual_session') && (
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

            {(loginType === 'phone_code' || loginType === 'phone_password') && (
              <Form.Item label="手机号" name="phone" rules={[{ required: true, message: '请输入手机号' }]}>
                <Input prefix={<PhoneOutlined />} placeholder="+8613800138000" />
              </Form.Item>
            )}

            {(loginType === 'email_password' || loginType === 'phone_password') && (
              <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
                <Input.Password prefix={<LockOutlined />} placeholder={`${variantLabel}账户密码`} />
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
              : loginType === 'phone_code'
                ? '验证码已发送至手机号，请输入收到的验证码。'
                : '验证码已发送至您的邮箱，请输入收到的验证码。'}
          </Typography.Paragraph>
          <Form layout="vertical" onFinish={handleVerify}>
            <Form.Item label="验证码" name="code" rules={[{ required: true, message: '请输入验证码' }]}>
              <Input prefix={<NumberOutlined />} placeholder="6位验证码" />
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
