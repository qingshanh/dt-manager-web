import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/auth';

export default function Login() {
  const login = useAuthStore((s) => s.login);
  const loading = useAuthStore((s) => s.loading);
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [errorText, setErrorText] = useState('');

  const onFinish = async (values: { username: string; password: string }) => {
    setErrorText('');
    try {
      await login(values.username, values.password);
      navigate('/', { replace: true });
    } catch (err) {
      const rawText = err instanceof Error ? err.message : '登录失败';
      const text = /账号或密码错误|账户或密码错误|用户名或密码错误|invalid credentials|unauthorized/i.test(rawText)
        ? '账号或密码错误'
        : rawText || '账号或密码错误';
      setErrorText(text);
      message.error(text);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      }}
    >
      <Card style={{ width: 420, boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <h1 style={{ textAlign: 'center', marginBottom: 32, fontSize: 24 }}>说道管理平台</h1>
        <Form onFinish={onFinish} size="large">
          {errorText && (
            <Form.Item>
              <Alert type="error" showIcon message={errorText} />
            </Form.Item>
          )}
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              登录
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
