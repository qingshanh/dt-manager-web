import { useEffect, useState } from 'react';
import { Alert, Form, Input, Modal, Select, Space, Typography } from 'antd';

export type DirectSessionImportValues = {
  dtUserId: string;
  token: string;
  deviceId: string;
  deviceIdCandidates: string[];
  phonePreviewCountryCode?: number;
};

type DirectSessionImportFormValues = {
  dtUserId: string;
  token: string;
  deviceId: string;
  deviceCandidates?: string;
  phonePreviewCountryCode?: number;
};

export type DirectSessionImportModalProps = {
  open: boolean;
  appVariant: 'dingtone' | 'dingdong';
  initialDtUserId: string;
  initialDeviceId: string;
  countries: Array<{ country_code: number; label: string }>;
  loading: boolean;
  onCancel(): void;
  onSubmit(values: DirectSessionImportValues): Promise<void>;
};

function classifySafeImportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/unauthorized|401|token.*(?:失效|过期)|(?:失效|过期).*token/i.test(message)) {
    return 'Token 已失效或过期，请重新获取后再试。';
  }
  if (/device|设备.*不匹配|不匹配.*设备/i.test(message)) {
    return '设备参数与会话不匹配，请检查设备 ID。';
  }
  if (/timeout|超时/i.test(message)) {
    return 'Direct 会话校验超时，请稍后重试。';
  }
  return '网络或后端暂时不可用，请稍后重试。';
}

export default function DirectSessionImportModal({
  open,
  appVariant,
  initialDtUserId,
  initialDeviceId,
  countries,
  loading,
  onCancel,
  onSubmit,
}: DirectSessionImportModalProps) {
  const [form] = Form.useForm<DirectSessionImportFormValues>();
  const [safeError, setSafeError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      form.resetFields();
      setSafeError(null);
      return;
    }
    form.setFieldsValue({
      dtUserId: initialDtUserId,
      token: undefined,
      deviceId: initialDeviceId,
      deviceCandidates: undefined,
    });
    setSafeError(null);
  }, [form, initialDeviceId, initialDtUserId, open]);

  useEffect(() => {
    if (open && countries.length > 0 && !form.getFieldValue('phonePreviewCountryCode')) {
      form.setFieldValue('phonePreviewCountryCode', countries[0].country_code);
    }
  }, [countries, form, open]);

  const resetSensitiveForm = () => {
    form.resetFields();
    setSafeError(null);
  };

  const handleCancel = () => {
    if (loading) {
      return;
    }
    resetSensitiveForm();
    onCancel();
  };

  const handleFinish = async (values: DirectSessionImportFormValues) => {
    if (loading) {
      return;
    }
    setSafeError(null);
    const candidates = String(values.deviceCandidates ?? '')
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      await onSubmit({
        dtUserId: values.dtUserId.trim(),
        token: values.token.trim(),
        deviceId: values.deviceId.trim(),
        deviceIdCandidates: [...new Set(candidates)].slice(0, 8),
        phonePreviewCountryCode: values.phonePreviewCountryCode,
      });
      form.resetFields();
    } catch (error) {
      setSafeError(classifySafeImportError(error));
    }
  };

  return (
    <Modal
      open={open}
      title="导入直连会话"
      width={640}
      okText="验证并保存"
      cancelText="取消"
      confirmLoading={loading}
      closable={!loading}
      maskClosable={!loading}
      keyboard={!loading}
      cancelButtonProps={{ disabled: loading }}
      okButtonProps={{ disabled: loading }}
      destroyOnClose
      afterClose={resetSensitiveForm}
      onCancel={handleCancel}
      onOk={() => {
        if (!loading) {
          form.submit();
        }
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={`应用类型：${appVariant === 'dingdong' ? '叮咚 Dingdong' : '说道 Dingtone / TalkU'}`}
          description="系统会先进行 Direct 远端校验，只有校验成功后才保存会话；不会自动启动监听。"
        />
        {safeError ? <Alert type="error" showIcon message={safeError} /> : null}
        <Form<DirectSessionImportFormValues>
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            dtUserId: initialDtUserId,
            deviceId: initialDeviceId,
            phonePreviewCountryCode: countries[0]?.country_code,
          }}
          onFinish={handleFinish}
        >
          <Form.Item
            label="用户 ID (dtUserId)"
            name="dtUserId"
            extra="必须与 Token 所属账户一致。"
            rules={[{ required: true, whitespace: true, message: '请输入用户 ID' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="Token（敏感信息，默认隐藏）"
            name="token"
            extra="仅用于本次校验和保存；关闭窗口后立即清空。"
            rules={[{ required: true, whitespace: true, message: '请输入 Token' }]}
          >
            <Input.Password autoComplete="off" visibilityToggle />
          </Form.Item>
          <Form.Item
            label="设备 ID"
            name="deviceId"
            extra="填写该会话在官方 App 中已注册的主设备 ID。"
            rules={[{ required: true, whitespace: true, message: '请输入设备 ID' }]}
          >
            <Input autoComplete="off" placeholder="例如 And.xxxxx.dttalk" />
          </Form.Item>
          <Form.Item
            label="备用设备 ID"
            name="deviceCandidates"
            extra="可选。使用换行或逗号分隔；自动去重，最多尝试 8 个。"
          >
            <Input.TextArea rows={3} autoComplete="off" />
          </Form.Item>
          <Form.Item label="候选号预览国家" name="phonePreviewCountryCode">
            <Select
              allowClear
              disabled={countries.length === 0}
              options={countries.map((item) => ({ label: item.label, value: item.country_code }))}
              placeholder={countries.length === 0 ? '国家列表不可用，将跳过候选号预览' : '可选：附带验证候选号预览'}
            />
          </Form.Item>
          <Typography.Text type="secondary">
            失败时仅显示安全分类：Token 失效、设备不匹配、校验超时或网络不可用。
          </Typography.Text>
        </Form>
      </Space>
    </Modal>
  );
}
