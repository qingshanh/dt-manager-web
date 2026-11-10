import api from './api';
import { generateUUID } from '../utils/uuid';
import { fetchCachedData, invalidateCachedData, isCachedDataFresh, makeCacheKey, readCachedData } from './client-cache';
import type {
  ApiResponse,
  AppVariant,
  BulkAccountAction,
  BulkAccountActionResult,
  CreateAccountRequest,
  DashboardStats,
  DtAccountDetail,
  DtAccountListItem,
  LoginRequest,
  LoginResult,
  Message,
  MonitorSession,
  PagedData,
  PhoneNumber,
  PhoneInventoryRefreshResult,
  PhoneInventoryResponse,
  PhoneStatus,
  PhoneActionResult,
  PhoneActionOperation,
  PhoneActionOperationEnvelope,
  PhoneSmsReceptionRepairResult,
  PhoneCountryOption,
  PhonePurchasePreview,
  PointData,
  PointStoreData,
  PointStoreOrder,
  PointStoreOrderListResult,
  PointStoreOrderResult,
  PurchasePhoneNumberBody,
  PurchasePhoneNumberResult,
  RefreshMessagesResult,
  RecentMessage,
  RequestPhoneNumberBody,
  SettingItem,
  UpdatePhoneLabelBody,
  UpdateAccountRequest,
  UnreadNotificationFeed,
  AccessCodeProbeRequest,
  AccessCodeProbeDryRunResult,
  AccessCodeProbeResult,
  ValidateSessionRequest,
  ValidateSessionResult,
  VersionInfo,
} from '../types';
type CacheOptions = { force?: boolean };
const PAGE_NAVIGATION_TIMEOUT_MS = 30_000;

export { createLatestRequestGuard } from '../utils/request-guard';

export const CACHE_TTL_MS = {
  dashboard: 60_000,
  recentMessages: 30_000,
  accounts: 60_000,
  accountDetail: 60_000,
  accountMessages: 15_000,
  phoneNumbers: 5 * 60_000,
  settings: 5 * 60_000,
} as const;

export const cacheKeys = {
  dashboardStats: 'dashboard:stats',
  recentMessages: (limit = 20) => makeCacheKey('dashboard:recent-messages', { limit }),
  accounts: (params?: { page?: number; pageSize?: number; status?: string; keyword?: string }) =>
    makeCacheKey('accounts:list', params ?? {}),
  account: (id: number) => `account:${id}:detail`,
  accountMessages: (
    accountId: number,
    params?: {
      page?: number;
      pageSize?: number;
      keyword?: string;
      msg_type?: Message['msg_type'];
      credit_only?: boolean;
      exclude_system?: boolean;
      is_read?: boolean;
    },
  ) => makeCacheKey(`account:${accountId}:messages`, params ?? {}),
  phoneNumbers: (accountId: number) => `account:${accountId}:phone-numbers`,
  phoneInventory: (params?: Record<string, unknown>) => makeCacheKey('phone-inventory:all', params ?? {}),
  settings: 'settings:all',
};

export { invalidateCachedData, isCachedDataFresh, readCachedData };

function invalidateAccountCaches(accountId?: number) {
  invalidateCachedData('dashboard:');
  invalidateCachedData('accounts:');
  invalidateCachedData('phone-inventory:');
  if (accountId !== undefined) {
    invalidateCachedData(`account:${accountId}:`);
  }
}
// 鈹€鈹€ 璁よ瘉 鈹€鈹€

export async function login(data: LoginRequest) {
  const res = await api.post<ApiResponse<LoginResult>>('/auth/login', data);
  return res.data.data;
}

export async function logout() {
  await api.post('/auth/logout');
}

export async function getMe() {
  const res = await api.get<ApiResponse<LoginResult['user']>>('/auth/me');
  return res.data.data;
}

export async function changePassword(old_password: string, new_password: string) {
  const res = await api.put<ApiResponse<null>>('/auth/password', { old_password, new_password });
  return res.data;
}

// 鈹€鈹€ 浠〃鐩?鈹€鈹€

export async function getDashboardStats(options?: CacheOptions) {
  return fetchCachedData(cacheKeys.dashboardStats, CACHE_TTL_MS.dashboard, async () => {
    const res = await api.get<ApiResponse<DashboardStats>>('/dashboard/stats');
    return res.data.data;
  }, options);
}

export async function getRecentMessages(limit = 20, options?: CacheOptions) {
  return fetchCachedData(cacheKeys.recentMessages(limit), CACHE_TTL_MS.recentMessages, async () => {
    const res = await api.get<ApiResponse<RecentMessage[]>>('/dashboard/recent-messages', {
      params: { limit },
    });
    return res.data.data;
  }, options);
}

export async function getUnreadNotifications(limit = 20) {
  const res = await api.get<ApiResponse<UnreadNotificationFeed>>('/dashboard/notifications', { params: { limit } });
  return res.data.data;
}

export async function markAllDashboardMessagesRead() {
  const res = await api.put<ApiResponse<{ updated: number }>>('/dashboard/messages/read-all');
  invalidateAccountCaches();
  return res.data.data;
}

// 鈹€鈹€ 璐︽埛绠＄悊 鈹€鈹€

export async function getAccounts(params?: {
  page?: number;
  pageSize?: number;
  status?: string;
  keyword?: string;
}, options?: CacheOptions) {
  return fetchCachedData(cacheKeys.accounts(params), CACHE_TTL_MS.accounts, async () => {
    const res = await api.get<ApiResponse<PagedData<DtAccountListItem>>>('/accounts', { params });
    return res.data.data;
  }, options);
}

export async function bulkAccountAction(accountIds: number[], action: BulkAccountAction) {
  const res = await api.post<ApiResponse<BulkAccountActionResult>>('/accounts/bulk-action', {
    account_ids: accountIds,
    action,
  }, { timeout: 120_000 });
  invalidateAccountCaches();
  return res.data.data;
}

export async function reorderAccount(accountId: number, action: 'move_up' | 'move_down' | 'move_top' | 'move_bottom') {
  const res = await api.post<ApiResponse<{ account_id: number; action: string; sort_order: number }>>(`/accounts/${accountId}/reorder`, { action });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function createAccount(data: CreateAccountRequest) {
  const res = await api.post<
    ApiResponse<{
      id: number;
      account_id?: number;
      app_variant?: AppVariant;
      message?: string;
      dt_user_id?: string;
      status?: string;
      requires_verification?: boolean;
      requires_session_import?: boolean;
      mock?: boolean;
      verification_code?: string | null;
      verification_flow?: 'recover' | 'register' | null;
      reused?: boolean;
      send_pending?: boolean;
    }>
  >(
    '/accounts',
    data,
    { timeout: 120_000 },
  );
  invalidateAccountCaches(res.data.data?.id);
  return res.data.data;
}

export async function getAccount(id: number, options?: CacheOptions) {
  return fetchCachedData(cacheKeys.account(id), CACHE_TTL_MS.accountDetail, async () => {
    const res = await api.get<ApiResponse<DtAccountDetail>>(`/accounts/${id}`, { timeout: PAGE_NAVIGATION_TIMEOUT_MS });
    return res.data.data;
  }, options);
}

export async function updateAccount(id: number, data: UpdateAccountRequest) {
  const res = await api.put<ApiResponse<DtAccountListItem>>(`/accounts/${id}`, data);
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function deleteAccount(id: number) {
  const res = await api.delete<ApiResponse<null>>(`/accounts/${id}`, {
    params: { confirm: 'true' },
  });
  invalidateAccountCaches(id);
  return res.data;
}

export async function sendVerificationCode(id: number, options?: { fresh_device?: boolean }) {
  const res = await api.post<ApiResponse<{ account_id?: number; app_variant?: AppVariant; message: string; mock?: boolean; verification_code?: string | null; verification_flow?: 'recover' | 'register' | null; send_pending?: boolean }>>(
    `/accounts/${id}/send-verification-code`,
    options ?? undefined,
    { timeout: 90_000 },
  );
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function verifyCode(id: number, code: string) {
  const res = await api.post<ApiResponse<{ dt_user_id: string; dt_token: string; status: string; monitor_started: boolean; monitor_error: string | null; snapshot?: DtAccountDetail['snapshot']; refresh_error?: string | null }>>(
    `/accounts/${id}/verify-code`,
    { code },
    { timeout: 120_000 },
  );
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function probeAccessCode(id: number, data: AccessCodeProbeRequest) {
  const res = await api.post<ApiResponse<AccessCodeProbeResult | AccessCodeProbeDryRunResult>>(`/accounts/${id}/probe-access-code`, data, {
    timeout: 90_000,
  });
  return res.data.data;
}

export async function startMonitor(id: number) {
  const res = await api.post<ApiResponse<MonitorSession>>(`/accounts/${id}/start`);
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function stopMonitor(id: number) {
  const res = await api.post<ApiResponse<{ status: string; stopped_at: string }>>(`/accounts/${id}/stop`);
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function restartMonitor(id: number) {
  const res = await api.post<ApiResponse<MonitorSession>>(`/accounts/${id}/restart`);
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function reLogin(id: number) {
  const res = await api.post<ApiResponse<{ dt_user_id: string; status: string }>>(`/accounts/${id}/re-login`);
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function refreshAccount(id: number) {
  const res = await api.post<ApiResponse<{
    snapshot: DtAccountDetail['snapshot'];
    refresh_error: string | null;
    cached: boolean;
    freshness: 'fresh' | 'partial' | 'cached';
    refreshed_at: string;
  }>>(
    `/accounts/${id}/refresh`,
    undefined,
    { timeout: 45_000 },
  );
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function captureSession(id: number) {
  const res = await api.post<ApiResponse<ValidateSessionResult>>(`/accounts/${id}/capture-session`);
  invalidateAccountCaches(id);
  return res.data.data;
}

export async function validateSession(id: number, data: ValidateSessionRequest) {
  const res = await api.post<ApiResponse<ValidateSessionResult>>(`/accounts/${id}/validate-session`, data);
  invalidateAccountCaches(id);
  return res.data.data;
}

// 鈹€鈹€ 娑堟伅 鈹€鈹€

export async function getAccountMessages(
  accountId: number,
  params?: {
    page?: number;
    pageSize?: number;
    keyword?: string;
    msg_type?: Message['msg_type'];
    credit_only?: boolean;
    exclude_system?: boolean;
    is_read?: boolean;
  },
  options?: CacheOptions,
) {
  return fetchCachedData(cacheKeys.accountMessages(accountId, params), CACHE_TTL_MS.accountMessages, async () => {
    const isReadParam = params?.is_read === undefined ? undefined : String(params.is_read);
    const excludeSystemParam = params?.exclude_system === undefined ? undefined : String(params.exclude_system);
    const creditOnlyParam = params?.credit_only === undefined ? undefined : String(params.credit_only);
    const res = await api.get<ApiResponse<PagedData<Message>>>(`/accounts/${accountId}/messages`, {
      params: { ...params, is_read: isReadParam, exclude_system: excludeSystemParam, credit_only: creditOnlyParam },
      timeout: PAGE_NAVIGATION_TIMEOUT_MS,
    });
    return res.data.data;
  }, options);
}

export async function getAccountMessage(accountId: number, messageId: number) {
  const res = await api.get<ApiResponse<Message>>(`/accounts/${accountId}/messages/${messageId}`, {
    timeout: PAGE_NAVIGATION_TIMEOUT_MS,
  });
  return res.data.data;
}

export async function readAllMessages(accountId: number) {
  const res = await api.put<ApiResponse<null>>(`/accounts/${accountId}/messages/read-all`);
  invalidateAccountCaches(accountId);
  return res.data;
}

export async function deleteMessage(accountId: number, messageId: number) {
  const res = await api.delete<ApiResponse<null>>(`/accounts/${accountId}/messages/${messageId}`);
  invalidateAccountCaches(accountId);
  return res.data;
}

export async function refreshAccountMessages(accountId: number, limit = 20, directOnly = false) {
  const res = await api.post<ApiResponse<RefreshMessagesResult>>(
    `/accounts/${accountId}/messages/refresh`,
    { limit, direct_only: directOnly },
    { timeout: 90_000 }
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function syncHelperMessages(accountId: number, limit = 20) {
  const res = await api.post<ApiResponse<RefreshMessagesResult>>(
    `/accounts/${accountId}/messages/sync-helper`,
    { limit },
    { timeout: 90_000 }
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function exportSessions() {
  const res = await api.get<
    ApiResponse<{
      version: number;
      exported_at: string;
      direct_settings?: Record<string, string>;
      accounts: unknown[];
    }>
  >('/accounts/sessions/export');
  return res.data.data;
}

export async function importSessions(data: { accounts: unknown[]; direct_settings?: Record<string, string>; validate?: boolean }) {
  const res = await api.post<
    ApiResponse<{
      imported: number;
      failed: number;
      settings_imported?: number;
      results: Array<{ ok: boolean; account_id?: number; dt_user_id?: string; nickname?: string; error?: string }>;
    }>
  >('/accounts/sessions/import', data, { timeout: 120_000 });
  invalidateCachedData();
  return res.data.data;
}

type FullBackupPayload = {
  version: number;
  kind: 'dt-manager-full-backup';
  exported_at: string;
  contains_secrets?: boolean;
  environment?: { files?: unknown[] } | string | null;
  admin_users?: unknown[];
  settings: unknown[];
  accounts: unknown[];
};

function filenameFromContentDisposition(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''));
  }
  const asciiMatch = value.match(/filename="?([^";]+)"?/i);
  return asciiMatch?.[1]?.trim() || null;
}

export async function exportFullBackup() {
  const res = await api.get<Blob>('/accounts/backup/export', {
    responseType: 'blob',
    timeout: 180_000,
  });
  const text = await res.data.text();
  const payload = JSON.parse(text) as FullBackupPayload;
  const filename =
    filenameFromContentDisposition(res.headers['content-disposition']) ||
    `dt-manager-full-backup-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace(/[TZ]/g, '-')}.json`;
  return {
    payload,
    filename,
    blob: new Blob([text], { type: 'application/json;charset=utf-8' }),
  };
}

export async function importFullBackup(data: {
  settings?: unknown[];
  admin_users?: unknown[];
  environment?: unknown;
  env?: unknown;
  accounts?: unknown[];
  validate?: boolean;
}) {
  const res = await api.post<
    ApiResponse<{
      imported: number;
      failed: number;
      settings_imported?: number;
      env_files_written?: number;
      admin_users_imported?: number;
      results: Array<{ ok: boolean; account_id?: number; dt_user_id?: string; nickname?: string; error?: string }>;
    }>
  >('/accounts/backup/import', data, { timeout: 180_000 });
  invalidateCachedData();
  return res.data.data;
}

// 鈹€鈹€ 鎵嬫満鍙?鈹€鈹€

export async function getPhoneNumbers(accountId: number, options?: CacheOptions) {
  return fetchCachedData(cacheKeys.phoneNumbers(accountId), CACHE_TTL_MS.phoneNumbers, async () => {
    const res = await api.get<ApiResponse<PhoneNumber[]>>(`/accounts/${accountId}/phone-numbers`, { timeout: PAGE_NAVIGATION_TIMEOUT_MS });
    return res.data.data;
  }, options);
}

export async function getPhoneInventory(
  params?: { keyword?: string; status?: PhoneStatus; country_code?: number; provider_id?: number },
  options?: CacheOptions,
) {
  return fetchCachedData(cacheKeys.phoneInventory(params), CACHE_TTL_MS.phoneNumbers, async () => {
    const res = await api.get<ApiResponse<PhoneInventoryResponse>>('/phone-numbers', {
      params,
      timeout: PAGE_NAVIGATION_TIMEOUT_MS,
    });
    return res.data.data;
  }, options);
}

export async function refreshAllPhoneNumbers() {
  const res = await api.post<ApiResponse<PhoneInventoryRefreshResult>>(
    '/phone-numbers/refresh-all',
    { confirm: true },
    { timeout: 180_000 },
  );
  invalidateAccountCaches();
  invalidateCachedData('account:');
  return res.data.data;
}

export async function syncPhoneNumbers(accountId: number) {
  const res = await api.post<ApiResponse<{
    phone_numbers: PhoneNumber[];
    refresh_error: string | null;
    cached: boolean;
    refresh_pending: boolean;
  }>>(
    `/accounts/${accountId}/phone-numbers/sync`,
    undefined,
    { timeout: 20_000 },
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function getPhoneNumberCountries(accountId: number) {
  const res = await api.get<ApiResponse<PhoneCountryOption[]>>(`/accounts/${accountId}/phone-numbers/countries`);
  return res.data.data;
}

export async function requestPhoneNumber(accountId: number, data?: RequestPhoneNumberBody) {
  const res = await api.post<ApiResponse<PhonePurchasePreview>>(`/accounts/${accountId}/phone-numbers`, data ?? {});
  return res.data.data;
}

export async function previewPhoneNumbers(accountId: number, data?: RequestPhoneNumberBody) {
  const res = await api.post<ApiResponse<PhonePurchasePreview>>(`/accounts/${accountId}/phone-numbers/preview`, data ?? {});
  return res.data.data;
}

export async function purchasePhoneNumber(accountId: number, data: PurchasePhoneNumberBody) {
  const res = await api.post<ApiResponse<PurchasePhoneNumberResult>>(`/accounts/${accountId}/phone-numbers/purchase`, data, {
    timeout: 180_000,
  });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function getAccountPoint(accountId: number) {
  const res = await api.get<ApiResponse<PointData>>(`/accounts/${accountId}/point`, {
    timeout: PAGE_NAVIGATION_TIMEOUT_MS,
  });
  return res.data.data;
}

export async function getAccountPointStore(accountId: number) {
  const res = await api.get<ApiResponse<PointStoreData>>(`/accounts/${accountId}/pointstore`, {
    timeout: PAGE_NAVIGATION_TIMEOUT_MS,
  });
  return res.data.data;
}

export async function getAccountPointStoreOrders(accountId: number) {
  const res = await api.get<ApiResponse<PointStoreOrderListResult>>(`/accounts/${accountId}/pointstore/orders`);
  return res.data.data;
}

export async function orderPointStoreProduct(accountId: number, productId: string, email?: string) {
  const res = await api.post<ApiResponse<PointStoreOrderResult>>(
    `/accounts/${accountId}/pointstore/order`,
    { product_id: productId, email, confirm: true },
    { timeout: 90_000 },
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function refreshPointStoreOrder(accountId: number, orderId: number) {
  const res = await api.post<ApiResponse<PointStoreOrder>>(`/accounts/${accountId}/pointstore/orders/${orderId}/refresh`);
  return res.data.data;
}

export async function renewPhoneNumber(accountId: number, phoneId: number, requestId = generateUUID()) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/renew`, {
    confirm: true,
    request_id: requestId,
  }, { timeout: 20_000 });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function updatePhoneNumberLabel(accountId: number, phoneId: number, data: UpdatePhoneLabelBody) {
  const res = await api.put<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/label`, {
    ...data,
    request_id: data.request_id ?? generateUUID(),
  }, { timeout: 20_000 });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function enablePhoneSmsReception(accountId: number) {
  const res = await api.post<ApiResponse<PhoneSmsReceptionRepairResult>>(
    `/accounts/${accountId}/phone-numbers/enable-sms-reception`,
    { confirm: true, request_id: generateUUID() },
    { timeout: 20_000 },
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function forceEnablePhoneSms(accountId: number, phoneId: number, requestId = generateUUID()) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(
    `/accounts/${accountId}/phone-numbers/${phoneId}/force-enable-sms`,
    { confirm: true, request_id: requestId },
    { timeout: 20_000 }
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function cancelPhoneNumber(accountId: number, phoneId: number, requestId = generateUUID()) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/cancel`, {
    confirm: true,
    request_id: requestId,
  }, { timeout: 20_000 });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function pausePhoneNumber(accountId: number, phoneId: number, requestId = generateUUID()) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/pause`, {
    confirm: true,
    request_id: requestId,
  }, { timeout: 20_000 });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function resumePhoneNumber(accountId: number, phoneId: number, requestId = generateUUID()) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/resume`, {
    confirm: true,
    request_id: requestId,
  }, { timeout: 20_000 });
  invalidateAccountCaches(accountId);
  return res.data.data;
}

export async function getPhoneActionOperation(accountId: number, operationId: number) {
  const res = await api.get<ApiResponse<PhoneActionOperationEnvelope>>(
    `/accounts/${accountId}/phone-actions/${operationId}`,
  );
  return res.data.data.operation;
}

export async function getActivePhoneActionOperation(accountId: number, phoneId: number) {
  const res = await api.get<ApiResponse<{ operation: PhoneActionOperation | null }>>(
    `/accounts/${accountId}/phone-numbers/${phoneId}/operations/active`,
  );
  return res.data.data.operation;
}

export async function deletePhoneNumber(accountId: number, phoneId: number) {
  const res = await api.delete<ApiResponse<null>>(`/accounts/${accountId}/phone-numbers/${phoneId}`, {
    params: { confirm: 'true' },
  });
  invalidateAccountCaches(accountId);
  return res.data;
}

export async function clearPhoneOperation(accountId: number, phoneId: number) {
  const res = await api.post<ApiResponse<{ cleared: boolean; phone: PhoneNumber | null }>>(
    `/accounts/${accountId}/phone-numbers/${phoneId}/clear-operation`
  );
  invalidateAccountCaches(accountId);
  return res.data.data;
}

// 鈹€鈹€ 璁剧疆 鈹€鈹€

export async function getSettings(options?: CacheOptions) {
  return fetchCachedData(cacheKeys.settings, CACHE_TTL_MS.settings, async () => {
    const res = await api.get<ApiResponse<SettingItem[]>>('/settings');
    return res.data.data;
  }, options);
}

export async function updateSettings(data: Record<string, string | number | boolean>) {
  const res = await api.put<ApiResponse<SettingItem[]>>('/settings', data);
  invalidateCachedData('settings:');
  return res.data.data;
}

export async function getVersionInfo(force = false) {
  const res = await api.get<ApiResponse<VersionInfo>>('/version', { params: force ? { refresh: 'true' } : undefined });
  return res.data.data;
}

export async function testTelegram() {
  const res = await api.post<ApiResponse<{ message_id: string }>>('/settings/test-telegram');
  return res.data;
}

export async function mockMessage(account_id: number, content: string, from_number?: string) {
  const res = await api.post<ApiResponse<Message>>('/settings/mock-message', {
    account_id,
    content,
    from_number,
  });
  invalidateAccountCaches(account_id);
  return res.data.data;
}

// ── 游戏与宠物福利 ──

export interface MemberRewardRecord {
  accountId: number;
  source: 'roulette' | 'checkin';
  sourceName: string;
  prizeName: string;
  receivedAt: string;
}

export interface FruitHarvestRecord {
  accountId: number;
  fruitId: number;
  fruitName: string;
  creditsWon: number;
  harvestedAt: string;
}

export interface TaskItemProgress {
  taskType: number;
  taskName: string;
  completed: number;
  total: number;
  rewardDesc?: string;
  isFinished: boolean;
}

export interface RankLeaderboardItem {
  ranking: number;
  nickname: string;
  countryName: string;
  bestScore: number;
  uid: string;
  seasonId?: number;
}

export interface AccountGameSummary {
  accountId: number;
  dtUserId: string | null;
  appVariant: string;
  appType: number;
  gameAppId: number;
  creditExpiry?: {
    expireCredit: number;
    expireDate: string | null;
  } | null;
  pet?: {
    petId: number | null;
    petName: string | null;
    petLevel: number | null;
    fishNum: number | null;
    growthValue: number | null;
    nextLevelRequiredGrowthValue: number | null;
    growthRate: number;
    nextFeedRemainingTime: number | null;
    treasureHuntStatus: number | null;
    treasureHuntEndRemainingTime: number | null;
    nextTreasureHuntRemainingTime: number | null;
    lotteryLeftChance: number;
    playLeftChance: number;
    tasks: TaskItemProgress[];
  } | null;
  fruit?: {
    nutritiveNumber: number | null;
    plantFruitList: Array<{
      fruitId: number;
      name: string;
      completionRate: number;
      type: number;
    }>;
    tasks: TaskItemProgress[];
    harvestHistory: FruitHarvestRecord[];
  } | null;
  knife?: {
    remainPlayTimes: number;
    fruitJuiceAmount: number;
    watchingGetPlayTimes: number;
    watchingGetPlayTimesLimit: number;
    treasureBoxOwned: boolean;
    treasureBoxOpenTime: number | null;
    canOpenTreasureBox: boolean;
  } | null;
  mathGame?: {
    uid: string | null;
    validPoint: number | null;
    expirePoint: number | null;
    chanceLeft: number | null;
    watchAdsAddChanceFrequency: number | null;
    record: number | null;
    shortUuid: string | null;
    redeemProducts: Array<{
      productId: number;
      productName: string;
      price: number;
      stock: number;
    }>;
    shareBoostToday?: {
      count: number;
      isMaxReached: boolean;
    };
    redeemedTodayProductIds?: number[];
  } | null;
  member?: {
    validTimes: number;
    addTimes: number;
    maxAddTimes: number;
    adRouletteRemainTimes: number;
    adRouletteAddedTimes: number;
    lastReward: string | null;
    history: MemberRewardRecord[];
  } | null;
}

export interface GameTaskLog {
  time: string;
  module: 'pet' | 'fruit' | 'knife' | 'math' | 'checkin' | 'system';
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
}

export interface GameExecutionResult {
  accountId: number;
  success: boolean;
  logs: GameTaskLog[];
}

export async function getAccountGameSummary(accountId: number): Promise<AccountGameSummary> {
  const res = await api.get<ApiResponse<AccountGameSummary>>(`/accounts/${accountId}/games/summary`);
  return res.data.data;
}

export async function runAccountGameDaily(accountId: number): Promise<GameExecutionResult> {
  const res = await api.post<ApiResponse<GameExecutionResult>>(`/accounts/${accountId}/games/daily`);
  return res.data.data;
}

export async function feedAccountPet(accountId: number): Promise<{ success: boolean; logs: GameTaskLog[] }> {
  const res = await api.post<ApiResponse<{ success: boolean; logs: GameTaskLog[] }>>(`/accounts/${accountId}/games/pet/feed`);
  return res.data.data;
}

export async function waterAccountFruit(accountId: number): Promise<{ success: boolean; logs: GameTaskLog[] }> {
  const res = await api.post<ApiResponse<{ success: boolean; logs: GameTaskLog[] }>>(`/accounts/${accountId}/games/fruit/water`);
  return res.data.data;
}

export async function runAccountKnifeDaily(accountId: number): Promise<{ success: boolean; logs: GameTaskLog[] }> {
  const res = await api.post<ApiResponse<{ success: boolean; logs: GameTaskLog[] }>>(`/accounts/${accountId}/games/knife/daily`);
  return res.data.data;
}

export async function redeemMathGamePoints(accountId: number, productId: number): Promise<{ success: boolean; message: string }> {
  const res = await api.post<ApiResponse<{ success: boolean; message: string }>>(`/accounts/${accountId}/games/math/redeem`, { product_id: productId });
  return res.data.data;
}

export async function getGameRankList(appId = 66): Promise<RankLeaderboardItem[]> {
  const res = await api.get<ApiResponse<RankLeaderboardItem[]>>(`/games/rank`, { params: { app_id: appId } });
  return res.data.data;
}

export async function boostAccountGameShare(accountId: number): Promise<{ count: number; logs: string[] }> {
  const res = await api.post<ApiResponse<{ count: number; logs: string[] }>>(`/accounts/${accountId}/games/boost`);
  return res.data.data;
}

export async function runAllAccountsGameDaily(): Promise<{ total: number; results: GameExecutionResult[] }> {
  const res = await api.post<ApiResponse<{ total: number; results: GameExecutionResult[] }>>(`/games/daily-all`);
  return res.data.data;
}

export async function addXiequWhitelist(ukey?: string): Promise<{ success: boolean; ip: string; message: string }> {
  const res = await api.post<ApiResponse<{ success: boolean; ip: string; message: string }>>('/games/xiequ/whitelist', { ukey });
  return res.data.data;
}

export async function runAccountMemberDaily(accountId: number): Promise<{ success: boolean; logs: GameTaskLog[] }> {
  const res = await api.post<ApiResponse<{ success: boolean; logs: GameTaskLog[] }>>(`/accounts/${accountId}/games/member/daily`);
  return res.data.data;
}

export async function getGameSchedulerStatus(): Promise<{ running: boolean; isNightQuiet: boolean; lastCycleAt: string | null; completedTodayCount: number }> {
  const res = await api.get<ApiResponse<{ running: boolean; isNightQuiet: boolean; lastCycleAt: string | null; completedTodayCount: number }>>('/games/scheduler/status');
  return res.data.data;
}


export async function getMemberRewardsHistory(accountId?: number): Promise<MemberRewardRecord[]> {
  const url = accountId ? `/accounts/${accountId}/games/member/rewards` : `/games/member/rewards`;
  const res = await api.get<ApiResponse<MemberRewardRecord[]>>(url);
  return res.data.data;
}

export async function testGameProxy(extractUrl?: string): Promise<{
  success: boolean;
  proxy?: string;
  latency_ms?: number;
  status?: number;
  message: string;
}> {
  const res = await api.post<ApiResponse<{
    success: boolean;
    proxy?: string;
    latency_ms?: number;
    status?: number;
    message: string;
  }>>('/games/proxy/test', { extract_url: extractUrl });
  return res.data.data;
}


export async function runAccountMathDaily(accountId: number): Promise<{ success: boolean; logs: GameTaskLog[] }> {
  const res = await api.post<ApiResponse<{ success: boolean; logs: GameTaskLog[] }>>(`/accounts/${accountId}/games/math/daily`);
  return res.data.data;
}
