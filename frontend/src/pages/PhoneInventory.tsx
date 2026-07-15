import {
  CopyOutlined,
  EditOutlined,
  ReloadOutlined,
  RightOutlined,
} from '@ant-design/icons';
import {
  App,
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Grid,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  createLatestRequestGuard,
  getPhoneInventory,
  refreshAllPhoneNumbers,
  syncPhoneNumbers,
  updatePhoneNumberLabel,
} from '../services/endpoints';
import type {
  PhoneInventoryGroup,
  PhoneInventoryPhone,
  PhoneInventoryRefreshResult,
  PhoneInventoryResponse,
  PhoneStatus,
} from '../types';

const EMPTY_DATA: PhoneInventoryResponse = {
  summary: { total: 0, active: 0, account_count: 0, expiring_soon: 0 },
  groups: [],
};

export default function PhoneInventory() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  const isNarrow = screens.sm === false;
  const [data, setData] = useState<PhoneInventoryResponse>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [status, setStatus] = useState<PhoneStatus | undefined>();
  const [countryCode, setCountryCode] = useState<number | undefined>();
  const [providerId, setProviderId] = useState<number | undefined>();
  const [refreshingAccountId, setRefreshingAccountId] = useState<number | null>(null);
  const [accountRefreshErrors, setAccountRefreshErrors] = useState<Record<number, string>>({});
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [lastRefreshResult, setLastRefreshResult] = useState<PhoneInventoryRefreshResult | null>(null);
  const [detailPhone, setDetailPhone] = useState<PhoneInventoryPhone | null>(null);
  const [editing, setEditing] = useState<{ accountId: number; phone: PhoneInventoryPhone } | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [noteForm] = Form.useForm<{ display_name: string }>();
  const loadRequestGuardRef = useRef(createLatestRequestGuard());

  const load = useCallback(async (force = false, notifyError = true) => {
    const requestId = loadRequestGuardRef.current.begin();
    setLoading(true);
    try {
      const nextData = await getPhoneInventory({
        keyword: appliedKeyword || undefined,
        status,
        country_code: countryCode,
        provider_id: providerId,
      }, { force });
      if (!loadRequestGuardRef.current.isLatest(requestId)) {
        return true;
      }
      setData(nextData);
      setLoadError(null);
      return true;
    } catch (error) {
      if (!loadRequestGuardRef.current.isLatest(requestId)) {
        return true;
      }
      const errorMessage = error instanceof Error ? error.message : '加载手机号失败';
      setLoadError(errorMessage);
      if (notifyError) {
        message.error(errorMessage);
      }
      return false;
    } finally {
      if (loadRequestGuardRef.current.isLatest(requestId)) {
        setLoading(false);
      }
    }
  }, [appliedKeyword, countryCode, message, providerId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const copyPhone = useCallback(async (phone: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(phone);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = phone;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand('copy')) {
            throw new Error('浏览器未允许复制');
          }
        } finally {
          document.body.removeChild(textarea);
        }
      }
      message.success('号码已复制');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复制失败');
    }
  }, [message]);

  const refreshGroup = useCallback(async (accountId: number) => {
    setRefreshingAccountId(accountId);
    try {
      await syncPhoneNumbers(accountId);
      setAccountRefreshErrors((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
      const reloaded = await load(true, false);
      if (reloaded) {
        message.success(`账户 #${accountId} 的号码已刷新`);
      } else {
        message.warning(`账户 #${accountId} 已刷新，但列表重载失败`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '刷新账户号码失败';
      setAccountRefreshErrors((current) => ({ ...current, [accountId]: errorMessage }));
    } finally {
      setRefreshingAccountId(null);
    }
  }, [load, message]);

  const refreshAll = useCallback(() => {
    modal.confirm({
      title: '刷新全部账户手机号？',
      content: '后端会以最多 2 个账户并发执行；单个账户失败不会中断其他账户。',
      okText: '确认刷新',
      cancelText: '取消',
      onOk: async () => {
        setRefreshingAll(true);
        try {
          const result = await refreshAllPhoneNumbers();
          setLastRefreshResult(result);
          const reloaded = await load(true, false);
          if (!reloaded) {
            message.warning('刷新已完成，但列表重载失败');
          }
        } catch (error) {
          message.error(error instanceof Error ? error.message : '刷新全部号码失败');
          throw error;
        } finally {
          setRefreshingAll(false);
        }
      },
    });
  }, [load, message, modal]);

  const saveNote = useCallback(async () => {
    if (!editing) {
      return;
    }
    setSavingNote(true);
    try {
      const values = await noteForm.validateFields();
      await updatePhoneNumberLabel(editing.accountId, editing.phone.id, values);
      setEditing(null);
      await load(true);
      message.success('号码备注已更新');
    } catch (error) {
      if (!isFormValidationError(error)) {
        message.error(error instanceof Error ? error.message : '修改号码备注失败');
      }
    } finally {
      setSavingNote(false);
    }
  }, [editing, load, message, noteForm]);

  const countryOptions = useMemo(
    () => uniqueOptions(data.groups, (phone) => phone.country_code, (value) => `+${value}`),
    [data.groups],
  );
  const providerOptions = useMemo(
    () => uniqueOptions(data.groups, (phone) => phone.provider_id),
    [data.groups],
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
        <div>
          <Typography.Title level={2} style={{ marginBottom: 0 }}>手机号管理</Typography.Title>
          <Typography.Text type="secondary">按账户查看所有已购手机号；页面默认只读取本地数据库。</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} loading={refreshingAll} onClick={refreshAll}>刷新全部</Button>
      </Space>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
        <Card><Statistic title="全部号码" value={data.summary.total} /></Card>
        <Card><Statistic title="正常号码" value={data.summary.active} /></Card>
        <Card><Statistic title="所属账户" value={data.summary.account_count} /></Card>
        <Card><Statistic title="30 天内到期" value={data.summary.expiring_soon} /></Card>
      </div>

      {lastRefreshResult && (
        <Alert
          showIcon
          closable
          type={lastRefreshResult.failed > 0 ? 'warning' : 'success'}
          message={`全量刷新完成：成功 ${lastRefreshResult.success}，失败 ${lastRefreshResult.failed}，跳过 ${lastRefreshResult.skipped}`}
          description={(
            <Space direction="vertical" size={2}>
              {lastRefreshResult.results.map((item) => (
                <Typography.Text key={item.account_id} type={item.status === 'failed' ? 'danger' : 'secondary'}>
                  账户 #{item.account_id}：{refreshStatusLabel(item.status)}
                  {item.status === 'success' ? `（${item.phone_count} 个号码）` : item.error ? `（${item.error}）` : ''}
                </Typography.Text>
              ))}
            </Space>
          )}
          onClose={() => setLastRefreshResult(null)}
        />
      )}

      <Card>
        <Space wrap style={{ width: '100%' }}>
          <div style={{ width: isNarrow ? '100%' : 300, maxWidth: '100%' }}>
            <Input.Search
              allowClear
              style={{ width: '100%' }}
              placeholder="搜索手机号、备注、账户名称或账户 ID"
              value={keyword}
              onChange={(event) => {
                const value = event.target.value;
                setKeyword(value);
                if (!value) {
                  setAppliedKeyword('');
                }
              }}
              onSearch={(value) => setAppliedKeyword(value.trim())}
            />
          </div>
          <Select<PhoneStatus>
            allowClear
            style={{ width: 140 }}
            placeholder="号码状态"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'active', label: '正常' },
              { value: 'paused', label: '已暂停' },
              { value: 'expired', label: '已到期' },
              { value: 'cancelled', label: '已取消' },
              { value: 'pending', label: '处理中' },
            ]}
          />
          <Select
            allowClear
            showSearch
            style={{ width: 140 }}
            placeholder="国家码"
            value={countryCode}
            onChange={setCountryCode}
            options={countryOptions}
          />
          <Select
            allowClear
            showSearch
            style={{ width: 160 }}
            placeholder="Provider"
            value={providerId}
            onChange={setProviderId}
            options={providerOptions}
          />
          <Button onClick={() => setAppliedKeyword(keyword.trim())}>应用搜索</Button>
        </Space>
      </Card>

      <Card loading={loading} styles={{ body: { padding: 12 } }}>
        {loadError && (
          <Alert
            showIcon
            type="error"
            message="手机号列表加载失败"
            description={loadError}
            action={<Button size="small" onClick={() => void load(true)}>重新加载</Button>}
            style={{ marginBottom: data.groups.length > 0 ? 12 : 0 }}
          />
        )}
        {!loadError && data.groups.length === 0 ? (
          <Empty description="没有符合条件的手机号" />
        ) : null}
        {data.groups.length > 0 && (
          <Collapse
            defaultActiveKey={data.groups.map((group) => String(group.account.id))}
            items={data.groups.map((group) => ({
              key: String(group.account.id),
              label: (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', width: '100%', minWidth: 0 }}>
                  <AccountGroupTitle group={group} />
                  <Space wrap onClick={(event) => event.stopPropagation()}>
                    <Button
                      size="small"
                      icon={<ReloadOutlined />}
                      loading={refreshingAccountId === group.account.id}
                      onClick={() => void refreshGroup(group.account.id)}
                    >刷新</Button>
                    <Button
                      size="small"
                      icon={<RightOutlined />}
                      onClick={() => navigate(`/accounts/${group.account.id}`)}
                    >账户详情</Button>
                  </Space>
                </div>
              ),
              children: (
                <Space direction="vertical" size={12} style={{ width: '100%', minWidth: 0 }}>
                  {accountRefreshErrors[group.account.id] && (
                    <Alert
                      showIcon
                      type="error"
                      message="刷新失败"
                      description={accountRefreshErrors[group.account.id]}
                      action={(
                        <Button size="small" onClick={() => void refreshGroup(group.account.id)}>
                          重新刷新
                        </Button>
                      )}
                    />
                  )}
                  <div style={{ display: 'grid', gridTemplateColumns: isNarrow ? 'minmax(0, 1fr)' : 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, minWidth: 0 }}>
                    {group.phones.map((phone) => (
                      <Card key={phone.id} size="small" title={<Typography.Text>{formatPhone(phone)}</Typography.Text>} style={{ minWidth: 0 }}>
                        <Space direction="vertical" size={8} style={{ width: '100%', minWidth: 0 }}>
                          <PhoneTags phone={phone} />
                          <Typography.Text type="secondary">备注：{phone.display_name || '-'}</Typography.Text>
                          <Descriptions size="small" column={isNarrow ? 1 : 2} colon={false}>
                            <Descriptions.Item label="国家">{formatCountry(phone)}</Descriptions.Item>
                            <Descriptions.Item label="Provider">{phone.provider_id ?? '-'}</Descriptions.Item>
                            <Descriptions.Item label="获得时间">{formatDate(phone.gain_time)}</Descriptions.Item>
                            <Descriptions.Item label="到期时间">{formatDate(phone.expired_time)}</Descriptions.Item>
                          </Descriptions>
                          <Space wrap>
                            <Button size="small" icon={<CopyOutlined />} onClick={() => void copyPhone(phone.phone_number)}>复制</Button>
                            <Button
                              size="small"
                              icon={<EditOutlined />}
                              onClick={() => {
                                setEditing({ accountId: group.account.id, phone });
                                noteForm.setFieldsValue({ display_name: phone.display_name ?? '' });
                              }}
                            >修改备注</Button>
                            <Button size="small" onClick={() => setDetailPhone(phone)}>完整详情</Button>
                          </Space>
                        </Space>
                      </Card>
                    ))}
                  </div>
                </Space>
              ),
            }))}
          />
        )}
      </Card>

      <Drawer title="手机号详情" open={Boolean(detailPhone)} onClose={() => setDetailPhone(null)} width={520}>
        {detailPhone && <PhoneDetails phone={detailPhone} />}
      </Drawer>

      <Modal
        title="修改号码备注"
        open={Boolean(editing)}
        confirmLoading={savingNote}
        onCancel={() => setEditing(null)}
        onOk={() => void saveNote()}
        okText="保存"
        cancelText="取消"
      >
        <Form form={noteForm} layout="vertical">
          <Form.Item name="display_name" label="备注" rules={[{ max: 100, message: '备注不能超过 100 个字符' }]}>
            <Input allowClear />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

function AccountGroupTitle({ group }: { group: PhoneInventoryGroup }) {
  const activeCount = group.phones.filter((phone) => phone.status === 'active').length;
  return (
    <Space wrap>
      <Typography.Text strong>#{group.account.id} {group.account.nickname || '未命名账户'}</Typography.Text>
      <Tag>{group.account.app_variant}</Tag>
      <Tag color={group.account.status === 'online' ? 'success' : 'default'}>{group.account.status}</Tag>
      <Tag color={group.account.monitor_enabled ? 'processing' : 'default'}>监听{group.account.monitor_enabled ? '中' : '停'}</Tag>
      <Tag color={group.account.telegram_notify ? 'blue' : 'default'}>TG{group.account.telegram_notify ? '开' : '关'}</Tag>
      <Tag>{group.phones.length} 个 / 正常 {activeCount}</Tag>
    </Space>
  );
}

function PhoneTags({ phone }: { phone: PhoneInventoryPhone }) {
  return (
    <Space wrap>
      <Tag color={statusColor(phone.status)}>{statusLabel(phone.status)}</Tag>
      {phone.is_primary && <Tag color="gold">主号码</Tag>}
      {phone.is_good_number && <Tag color="purple">靓号</Tag>}
      {phone.auto_renew && <Tag color="cyan">自动续费</Tag>}
      <Tag color={phone.allow_receive_sms === false ? 'error' : phone.allow_receive_sms === true ? 'success' : 'default'}>
        短信{phone.allow_receive_sms === false ? '关闭' : phone.allow_receive_sms === true ? '开启' : '未知'}
      </Tag>
    </Space>
  );
}

function PhoneDetails({ phone }: { phone: PhoneInventoryPhone }) {
  return (
    <Descriptions bordered size="small" column={1}>
      <Descriptions.Item label="手机号">{formatPhone(phone)}</Descriptions.Item>
      <Descriptions.Item label="备注">{phone.display_name || '-'}</Descriptions.Item>
      <Descriptions.Item label="状态">{statusLabel(phone.status)}</Descriptions.Item>
      <Descriptions.Item label="国家">{formatCountry(phone)}</Descriptions.Item>
      <Descriptions.Item label="区号">{phone.area_code ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="Provider">{phone.provider_id ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="套餐 ID">{phone.package_service_id || '-'}</Descriptions.Item>
      <Descriptions.Item label="价格">{phone.price ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="城市">{phone.city_name || '-'}</Descriptions.Item>
      <Descriptions.Item label="州/省">{phone.state_name || '-'}</Descriptions.Item>
      <Descriptions.Item label="获得时间">{formatDate(phone.gain_time)}</Descriptions.Item>
      <Descriptions.Item label="到期时间">{formatDate(phone.expired_time)}</Descriptions.Item>
      <Descriptions.Item label="有效期天数">{phone.valid_period_days ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="购买类型">{phone.purchase_type ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="支付类型">{phone.pay_type ?? '-'}</Descriptions.Item>
      <Descriptions.Item label="自动续费">{phone.auto_renew ? '是' : '否'}</Descriptions.Item>
      <Descriptions.Item label="主号码">{phone.is_primary ? '是' : '否'}</Descriptions.Item>
      <Descriptions.Item label="靓号">{phone.is_good_number ? '是' : '否'}</Descriptions.Item>
      <Descriptions.Item label="短信接收">
        {phone.allow_receive_sms === null ? '未知' : phone.allow_receive_sms ? '开启' : '关闭'}
      </Descriptions.Item>
      <Descriptions.Item label="携号转出信息">{phone.portout_info || '-'}</Descriptions.Item>
      <Descriptions.Item label="本地创建时间">{formatDate(phone.created_at)}</Descriptions.Item>
      <Descriptions.Item label="本地更新时间">{formatDate(phone.updated_at)}</Descriptions.Item>
    </Descriptions>
  );
}

function uniqueOptions(
  groups: PhoneInventoryGroup[],
  pick: (phone: PhoneInventoryPhone) => number | null,
  label: (value: number) => string = String,
) {
  return [...new Set(groups.flatMap((group) => group.phones.map(pick)).filter((value): value is number => value !== null))]
    .sort((left, right) => left - right)
    .map((value) => ({ value, label: label(value) }));
}

function formatPhone(phone: PhoneInventoryPhone) {
  return phone.country_code && !phone.phone_number.startsWith(String(phone.country_code))
    ? `+${phone.country_code} ${phone.phone_number}`
    : `+${phone.phone_number}`;
}

function formatCountry(phone: PhoneInventoryPhone) {
  const parts = [phone.iso_country_code, phone.country_code ? `+${phone.country_code}` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '-';
}

function statusColor(status: PhoneStatus) {
  return {
    active: 'success',
    paused: 'warning',
    expired: 'default',
    cancelled: 'error',
    pending: 'processing',
  }[status];
}

function statusLabel(status: PhoneStatus) {
  return {
    active: '正常',
    paused: '已暂停',
    expired: '已到期',
    cancelled: '已取消',
    pending: '处理中',
  }[status];
}

function refreshStatusLabel(status: PhoneInventoryRefreshResult['results'][number]['status']) {
  return { success: '成功', failed: '失败', skipped: '跳过' }[status];
}

function formatDate(value: string | null) {
  if (!value) {
    return '-';
  }
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function isFormValidationError(error: unknown) {
  return typeof error === 'object' && error !== null && 'errorFields' in error;
}
