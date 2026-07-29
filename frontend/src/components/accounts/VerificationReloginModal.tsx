import { useEffect, useState } from 'react';
import { App, Button, Input, Modal, Space, Typography } from 'antd';
import { KeyOutlined, MailOutlined, ReloadOutlined } from '@ant-design/icons';
import { sendVerificationCode, verifyCode } from '../../services/endpoints';
import type { AppVariant, LoginType } from '../../types';

export type VerificationReloginAccount = {
  id: number;
  app_variant: AppVariant;
  login_type: LoginType;
  email: string | null;
  phone: string | null;
};

type Props = {
  open: boolean;
  account: VerificationReloginAccount | null;
  onCancel: () => void;
  onSuccess: () => void | Promise<void>;
};

function maskTarget(value: string | null, kind: 'email' | 'phone') {
  if (!value) return '未配置';
  if (kind === 'email') {
    const [name, domain] = value.split('@');
    if (!domain) return '邮箱';
    return `${name.slice(0, 2)}***@${domain}`;
  }
  const digits = value.replace(/\s/g, '');
  return digits.length > 4 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : '手机号';
}

export default function VerificationReloginModal({ open, account, onCancel, onSuccess }: Props) {
  const { message } = App.useApp();
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const kind = account?.login_type === 'phone_code' ? 'phone' : 'email';
  const target = kind === 'email' ? account?.email ?? null : account?.phone ?? null;

  useEffect(() => {
    if (!open) {
      setCode('');
      setSent(false);
      setSending(false);
      setVerifying(false);
      setCountdown(0);
    }
  }, [open, account?.id]);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  const handleSend = async () => {
    if (!account) return;
    setSending(true);
    try {
      const result = await sendVerificationCode(account.id, { fresh_device: true });
      setSent(true);
      setCountdown(60);
      if (result.send_pending) {
        message.warning(result.message || '验证码请求已提交，请检查收件箱和垃圾邮件目录');
      } else {
        message.success(result.message || '验证码已发送');
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '验证码发送失败');
    } finally {
      setSending(false);
    }
  };

  const handleVerify = async () => {
    if (!account || code.trim().length < 4) {
      message.warning('请输入收到的验证码');
      return;
    }
    setVerifying(true);
    try {
      const result = await verifyCode(account.id, code.trim());
      if (result.monitor_started) {
        message.success('重新授权成功，监听已恢复');
      } else {
        message.warning(`重新授权成功，但监听恢复失败：${result.monitor_error || '请稍后手动启动监听'}`);
      }
      await onSuccess();
      onCancel();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '验证码校验失败');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Modal
      title="验证码重新登录"
      open={open}
      onCancel={onCancel}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button
          key="send"
          icon={<ReloadOutlined />}
          loading={sending}
          disabled={!account || countdown > 0}
          onClick={() => void handleSend()}
        >
          {countdown > 0 ? `${countdown} 秒后重发` : sent ? '重新发送验证码' : '发送验证码'}
        </Button>,
        <Button
          key="verify"
          type="primary"
          icon={<KeyOutlined />}
          loading={verifying}
          disabled={!sent || code.trim().length < 4}
          onClick={() => void handleVerify()}
        >
          验证并恢复监听
        </Button>,
      ]}
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          将向此账户绑定的{kind === 'email' ? '邮箱' : '手机号'}发送验证码。验证成功后会替换失效会话并自动恢复监听。
        </Typography.Text>
        <Input
          prefix={<MailOutlined />}
          value={maskTarget(target, kind)}
          readOnly
          aria-label="验证码接收目标"
        />
        <Input
          prefix={<KeyOutlined />}
          value={code}
          maxLength={8}
          inputMode="numeric"
          placeholder="请输入验证码"
          onChange={(event) => setCode(event.target.value.replace(/\s/g, ''))}
          onPressEnter={() => void handleVerify()}
        />
      </Space>
    </Modal>
  );
}
