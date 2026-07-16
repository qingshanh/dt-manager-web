import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, App, Button, Card, Col, Descriptions, Empty, Input, Row, Space, Statistic, Table, Tabs, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, GiftOutlined, HistoryOutlined, MailOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  getAccount,
  getAccountPointStore,
  getAccountPointStoreOrders,
  orderPointStoreProduct,
  refreshPointStoreOrder,
} from '../services/endpoints';
import type { DtAccountDetail, PointStoreData, PointStoreOrder, PointStoreProduct } from '../types';
import { resolvePointStoreHistoryView } from './point-store-view';

function formatPoints(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '-';
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: '已提交',
  submitting: '提交中',
  processing: '进行中',
  completed: '已完成',
  failed: '失败',
  unknown: '未知',
};

function orderStatusColor(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === 'completed') return 'green';
  if (normalized === 'failed') return 'red';
  if (normalized === 'processing' || normalized === 'pending' || normalized === 'submitting') return 'processing';
  return 'default';
}

function pointStoreOrderFeedback(status: string, orderId: string | number) {
  const normalized = status.toLowerCase();
  if (/complete|success|done|1/.test(normalized)) {
    return { type: 'success' as const, content: `兑换成功，订单 ID：${orderId}` };
  }
  if (/fail|cancel|error|2/.test(normalized)) {
    return { type: 'error' as const, content: `兑换失败，订单 ID：${orderId}` };
  }
  if (/process|3/.test(normalized)) {
    return { type: 'info' as const, content: `兑换处理中，订单 ID：${orderId}` };
  }
  return { type: 'info' as const, content: `兑换请求已提交，订单 ID：${orderId}` };
}

export default function PointStore() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const [account, setAccount] = useState<DtAccountDetail | null>(null);
  const [store, setStore] = useState<PointStoreData | null>(null);
  const [orders, setOrders] = useState<PointStoreOrder[]>([]);
  const [activeTab, setActiveTab] = useState('products');
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersStale, setOrdersStale] = useState(false);
  const [ordersSyncError, setOrdersSyncError] = useState<string | null>(null);
  const [ordersSyncedAt, setOrdersSyncedAt] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [defaultEmail, setDefaultEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [orderingId, setOrderingId] = useState<string | null>(null);
  const [refreshingOrderId, setRefreshingOrderId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accountData, storeData] = await Promise.all([
        getAccount(accountId),
        getAccountPointStore(accountId),
      ]);
      setAccount(accountData);
      setStore(storeData);
      const nextDefaultEmail = storeData.email || accountData.snapshot?.email || accountData.email || '';
      setDefaultEmail(nextDefaultEmail);
      setEmail(nextDefaultEmail);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '加载积分商城失败');
    } finally {
      setLoading(false);
    }
  }, [accountId, message]);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const result = await getAccountPointStoreOrders(accountId);
      setOrders(result.orders);
      setOrdersStale(result.stale);
      setOrdersSyncError(result.sync_error);
      setOrdersSyncedAt(result.synced_at);
      setOrdersLoaded(true);
    } catch (err) {
      setOrdersStale(false);
      setOrdersSyncError(err instanceof Error ? err.message : '订单同步失败');
      setOrdersSyncedAt(null);
      setOrdersLoaded(true);
    } finally {
      setOrdersLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (Number.isFinite(accountId) && accountId > 0) {
      setActiveTab('products');
      setOrders([]);
      setOrdersLoaded(false);
      setOrdersStale(false);
      setOrdersSyncError(null);
      setOrdersSyncedAt(null);
      void load();
    }
  }, [accountId, load]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    if (key === 'orders' && !ordersLoaded && !ordersLoading) {
      void loadOrders();
    }
  };

  const validEmail = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()), [email]);

  const canRedeem = (product: PointStoreProduct) => {
    return validEmail &&
      product.price !== null &&
      store?.valid_point !== null &&
      store?.valid_point !== undefined &&
      store.valid_point >= product.price &&
      (product.stock === null || product.stock > 0);
  };

  const handleRedeem = (product: PointStoreProduct) => {
    modal.confirm({
      title: '确认兑换商品',
      okText: '确认兑换',
      cancelText: '取消',
      content: (
        <Descriptions column={1} size="small" style={{ marginTop: 16 }}>
          <Descriptions.Item label="账户">{account?.nickname || account?.email || accountId}</Descriptions.Item>
          <Descriptions.Item label="商品">{product.name}</Descriptions.Item>
          <Descriptions.Item label="消耗积分">{formatPoints(product.price)}</Descriptions.Item>
          <Descriptions.Item label="兑换邮箱">{email.trim()}</Descriptions.Item>
          <Descriptions.Item label="当前积分">{formatPoints(store?.valid_point)}</Descriptions.Item>
        </Descriptions>
      ),
      onOk: async () => {
        setOrderingId(product.product_id);
        try {
          const result = await orderPointStoreProduct(accountId, product.product_id, email.trim());
          setStore(result.point_store);
          setOrders((items) => [result.history_order, ...items.filter((item) => item.id !== result.history_order.id)]);
          setEmail(defaultEmail);
          message.open(pointStoreOrderFeedback(
            result.history_order.status,
            result.order_id || result.history_order.id,
          ));
        } catch (err) {
          message.error(err instanceof Error ? err.message : '兑换失败');
          throw err;
        } finally {
          setOrderingId(null);
        }
      },
    });
  };

  const handleRefreshOrder = async (orderId: number) => {
    setRefreshingOrderId(orderId);
    try {
      const updated = await refreshPointStoreOrder(accountId, orderId);
      setOrders((items) => items.map((item) => item.id === updated.id ? updated : item));
      message.open(pointStoreOrderFeedback(updated.status, updated.remote_order_id || updated.id));
    } catch (err) {
      message.error(err instanceof Error ? err.message : '刷新订单状态失败');
    } finally {
      setRefreshingOrderId(null);
    }
  };

  const productColumns: ColumnsType<PointStoreProduct> = [
    { title: '商品', dataIndex: 'name', ellipsis: true },
    { title: '所需积分', dataIndex: 'price', width: 120, render: formatPoints },
    { title: '库存', dataIndex: 'stock', width: 100, render: (value) => value === null ? '未返回' : value },
    {
      title: '兑换条件',
      width: 130,
      render: (_, product) => canRedeem(product) ? <Tag color="green">积分充足</Tag> : <Tag color="orange">暂不可兑换</Tag>,
    },
    {
      title: '操作',
      width: 110,
      render: (_, product) => (
        <Button
          type="primary"
          size="small"
          icon={<GiftOutlined />}
          disabled={!canRedeem(product)}
          loading={orderingId === product.product_id}
          onClick={() => handleRedeem(product)}
        >
          兑换
        </Button>
      ),
    },
  ];

  const orderColumns: ColumnsType<PointStoreOrder> = [
    { title: '订单 ID', dataIndex: 'remote_order_id', width: 180, render: (value, order) => value || `本地-${order.id}` },
    { title: '商品', dataIndex: 'product_name', ellipsis: true },
    { title: '邮箱', dataIndex: 'email', width: 220, ellipsis: true },
    { title: '积分', dataIndex: 'product_price', width: 90, render: formatPoints },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: string) => <Tag color={orderStatusColor(value)}>{ORDER_STATUS_LABELS[value] ?? ORDER_STATUS_LABELS.unknown}</Tag>,
    },
    { title: '实际时间', dataIndex: 'order_time', width: 170, render: (value, order) => dayjs(value || order.created_at).format('YYYY-MM-DD HH:mm:ss') },
    { title: '来源', dataIndex: 'source', width: 110, render: (value) => value === 'panel' ? '本地审计' : '远端订单' },
    {
      title: '操作',
      width: 90,
      render: (_, order) => (
        <Button size="small" icon={<ReloadOutlined />} loading={refreshingOrderId === order.id} onClick={() => void handleRefreshOrder(order.id)}>
          刷新
        </Button>
      ),
    },
  ];

  const orderHistoryView = resolvePointStoreHistoryView({
    ordersCount: orders.length,
    stale: ordersStale,
    syncError: ordersSyncError,
  });

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/accounts/${accountId}`)}>返回账户</Button>
        <Typography.Title level={2} style={{ margin: 0 }}>积分商城</Typography.Title>
      </Space>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}><Card size="small" loading={loading}><Statistic title="当前可用积分" value={formatPoints(store?.valid_point)} /></Card></Col>
        <Col xs={24} sm={8}><Card size="small" loading={loading}><Statistic title="历史积分" value={formatPoints(store?.history_point)} /></Card></Col>
        <Col xs={24} sm={8}><Card size="small" loading={loading}><Statistic title="年底过期积分" value={formatPoints(store?.expire_point)} /></Card></Col>
      </Row>

      <div style={{ marginBottom: 16, maxWidth: 560 }}>
        <Input
          prefix={<MailOutlined />}
          value={email}
          status={email && !validEmail ? 'error' : undefined}
          placeholder="兑换接收邮箱"
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'products',
            label: <Space><GiftOutlined />可兑换商品</Space>,
            children: <Table columns={productColumns} dataSource={store?.products ?? []} rowKey="product_id" loading={loading} pagination={false} scroll={{ x: 760 }} />,
          },
          {
            key: 'orders',
            label: <Space><HistoryOutlined />历史订单</Space>,
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space wrap>
                  <Button icon={<ReloadOutlined />} loading={ordersLoading} onClick={() => void loadOrders()}>
                    手动刷新
                  </Button>
                  {ordersSyncedAt ? (
                    <Typography.Text type="secondary">
                      最近同步：{dayjs(ordersSyncedAt).format('YYYY-MM-DD HH:mm:ss')}
                    </Typography.Text>
                  ) : null}
                </Space>
                {orderHistoryView.alert ? (
                  <Alert
                    type={orderHistoryView.alert.type}
                    showIcon
                    message={orderHistoryView.alert.message}
                    description={orderHistoryView.alert.description}
                  />
                ) : null}
                {!ordersLoading && ordersLoaded && orders.length === 0 ? (
                  <Empty description={orderHistoryView.emptyText} />
                ) : (
                  <Table
                    columns={orderColumns}
                    dataSource={orders}
                    rowKey="id"
                    loading={ordersLoading}
                    locale={{ emptyText: orderHistoryView.emptyText }}
                    pagination={{ pageSize: 10 }}
                    scroll={{ x: 1180 }}
                  />
                )}
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
