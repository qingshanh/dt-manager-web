export type PointStoreHistoryViewInput = {
  ordersCount: number;
  stale: boolean;
  syncError: string | null;
};

export type PointStoreHistoryView = {
  alert: {
    type: 'warning' | 'error';
    message: string;
    description: string;
  } | null;
  emptyText: string;
};

export function resolvePointStoreHistoryView(input: PointStoreHistoryViewInput): PointStoreHistoryView {
  if (input.stale && input.ordersCount > 0) {
    return {
      alert: {
        type: 'warning',
        message: '当前显示缓存数据',
        description: input.syncError || '远端订单同步失败，当前显示缓存数据',
      },
      emptyText: '暂无历史订单',
    };
  }
  if (input.syncError || input.stale) {
    const description = input.syncError?.replace(/，当前显示缓存数据$/, '') || '远端订单同步失败';
    return {
      alert: {
        type: 'error',
        message: '订单同步失败',
        description,
      },
      emptyText: '订单同步失败',
    };
  }
  return { alert: null, emptyText: '暂无历史订单' };
}
