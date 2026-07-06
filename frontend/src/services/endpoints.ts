import api from './api';
import type {
  ApiResponse,
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
  PhoneActionResult,
  PhoneCountryOption,
  PhonePurchasePreview,
  PointData,
  PointStoreData,
  PointStoreOrderResult,
  PurchasePhoneNumberBody,
  PurchasePhoneNumberResult,
  RefreshMessagesResult,
  RecentMessage,
  RequestPhoneNumberBody,
  SettingItem,
  UpdatePhoneLabelBody,
  UpdateAccountRequest,
  AccessCodeProbeRequest,
  AccessCodeProbeDryRunResult,
  AccessCodeProbeResult,
  ValidateSessionRequest,
  ValidateSessionResult,
} from '../types';

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

export async function getDashboardStats() {
  const res = await api.get<ApiResponse<DashboardStats>>('/dashboard/stats');
  return res.data.data;
}

export async function getRecentMessages(limit = 20) {
  const res = await api.get<ApiResponse<RecentMessage[]>>('/dashboard/recent-messages', {
    params: { limit },
  });
  return res.data.data;
}

// 鈹€鈹€ 璐︽埛绠＄悊 鈹€鈹€

export async function getAccounts(params?: {
  page?: number;
  pageSize?: number;
  status?: string;
  keyword?: string;
}) {
  const res = await api.get<ApiResponse<PagedData<DtAccountListItem>>>('/accounts', { params });
  return res.data.data;
}

export async function createAccount(data: CreateAccountRequest) {
  const res = await api.post<
    ApiResponse<{
      id: number;
      account_id?: number;
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
  return res.data.data;
}

export async function getAccount(id: number) {
  const res = await api.get<ApiResponse<DtAccountDetail>>(`/accounts/${id}`, { timeout: 10_000 });
  return res.data.data;
}

export async function updateAccount(id: number, data: UpdateAccountRequest) {
  const res = await api.put<ApiResponse<DtAccountListItem>>(`/accounts/${id}`, data);
  return res.data.data;
}

export async function deleteAccount(id: number) {
  const res = await api.delete<ApiResponse<null>>(`/accounts/${id}`, {
    params: { confirm: 'true' },
  });
  return res.data;
}

export async function sendVerificationCode(id: number, options?: { fresh_device?: boolean }) {
  const res = await api.post<ApiResponse<{ account_id?: number; message: string; mock?: boolean; verification_code?: string | null; verification_flow?: 'recover' | 'register' | null; send_pending?: boolean }>>(
    `/accounts/${id}/send-verification-code`,
    options ?? undefined,
    { timeout: 90_000 },
  );
  return res.data.data;
}

export async function verifyCode(id: number, code: string) {
  const res = await api.post<ApiResponse<{ dt_user_id: string; dt_token: string; status: string; snapshot?: DtAccountDetail['snapshot']; refresh_error?: string | null }>>(
    `/accounts/${id}/verify-code`,
    { code },
    { timeout: 120_000 },
  );
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
  return res.data.data;
}

export async function stopMonitor(id: number) {
  const res = await api.post<ApiResponse<{ status: string; stopped_at: string }>>(`/accounts/${id}/stop`);
  return res.data.data;
}

export async function restartMonitor(id: number) {
  const res = await api.post<ApiResponse<MonitorSession>>(`/accounts/${id}/restart`);
  return res.data.data;
}

export async function reLogin(id: number) {
  const res = await api.post<ApiResponse<{ dt_user_id: string; status: string }>>(`/accounts/${id}/re-login`);
  return res.data.data;
}

export async function refreshAccount(id: number) {
  const res = await api.post<ApiResponse<{ snapshot: DtAccountDetail['snapshot']; refresh_error: string | null; cached: boolean }>>(
    `/accounts/${id}/refresh`,
    undefined,
    { timeout: 12_000 },
  );
  return res.data.data;
}

export async function captureSession(id: number) {
  const res = await api.post<ApiResponse<ValidateSessionResult>>(`/accounts/${id}/capture-session`);
  return res.data.data;
}

export async function validateSession(id: number, data: ValidateSessionRequest) {
  const res = await api.post<ApiResponse<ValidateSessionResult>>(`/accounts/${id}/validate-session`, data);
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
    exclude_system?: boolean;
    is_read?: boolean;
  },
) {
  const isReadParam = params?.is_read === undefined ? undefined : String(params.is_read);
  const excludeSystemParam = params?.exclude_system === undefined ? undefined : String(params.exclude_system);
  const res = await api.get<ApiResponse<PagedData<Message>>>(`/accounts/${accountId}/messages`, {
    params: { ...params, is_read: isReadParam, exclude_system: excludeSystemParam },
    timeout: 10_000,
  });
  return res.data.data;
}

export async function readAllMessages(accountId: number) {
  const res = await api.put<ApiResponse<null>>(`/accounts/${accountId}/messages/read-all`);
  return res.data;
}

export async function deleteMessage(accountId: number, messageId: number) {
  const res = await api.delete<ApiResponse<null>>(`/accounts/${accountId}/messages/${messageId}`);
  return res.data;
}

export async function refreshAccountMessages(accountId: number, limit = 20, directOnly = false) {
  const res = await api.post<ApiResponse<RefreshMessagesResult>>(
    `/accounts/${accountId}/messages/refresh`,
    { limit, direct_only: directOnly },
    { timeout: 90_000 }
  );
  return res.data.data;
}

export async function syncHelperMessages(accountId: number, limit = 20) {
  const res = await api.post<ApiResponse<RefreshMessagesResult>>(
    `/accounts/${accountId}/messages/sync-helper`,
    { limit },
    { timeout: 90_000 }
  );
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
  return res.data.data;
}

export async function exportFullBackup() {
  const res = await api.get<
    ApiResponse<{
      version: number;
      kind: 'dt-manager-full-backup';
      exported_at: string;
      contains_secrets?: boolean;
      settings: unknown[];
      accounts: unknown[];
    }>
  >('/accounts/backup/export');
  return res.data.data;
}

export async function importFullBackup(data: { settings?: unknown[]; accounts?: unknown[]; validate?: boolean }) {
  const res = await api.post<
    ApiResponse<{
      imported: number;
      failed: number;
      settings_imported?: number;
      results: Array<{ ok: boolean; account_id?: number; dt_user_id?: string; nickname?: string; error?: string }>;
    }>
  >('/accounts/backup/import', data, { timeout: 180_000 });
  return res.data.data;
}

// 鈹€鈹€ 鎵嬫満鍙?鈹€鈹€

export async function getPhoneNumbers(accountId: number) {
  const res = await api.get<ApiResponse<PhoneNumber[]>>(`/accounts/${accountId}/phone-numbers`, { timeout: 10_000 });
  return res.data.data;
}

export async function syncPhoneNumbers(accountId: number) {
  const res = await api.post<ApiResponse<{ phone_numbers: PhoneNumber[]; refresh_error: string | null; cached: boolean }>>(
    `/accounts/${accountId}/phone-numbers/sync`,
    undefined,
    { timeout: 12_000 },
  );
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
  return res.data.data;
}

export async function getAccountPoint(accountId: number) {
  const res = await api.get<ApiResponse<PointData>>(`/accounts/${accountId}/point`, {
    timeout: 10_000,
  });
  return res.data.data;
}

export async function getAccountPointStore(accountId: number) {
  const res = await api.get<ApiResponse<PointStoreData>>(`/accounts/${accountId}/pointstore`, {
    timeout: 10_000,
  });
  return res.data.data;
}

export async function orderPointStoreProduct(accountId: number, productId: string) {
  const res = await api.post<ApiResponse<PointStoreOrderResult>>(
    `/accounts/${accountId}/pointstore/order`,
    { product_id: productId, confirm: true },
    { timeout: 90_000 },
  );
  return res.data.data;
}

export async function renewPhoneNumber(accountId: number, phoneId: number) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/renew`, {
    confirm: true,
  });
  return res.data.data;
}

export async function updatePhoneNumberLabel(accountId: number, phoneId: number, data: UpdatePhoneLabelBody) {
  const res = await api.put<ApiResponse<PhoneNumber>>(`/accounts/${accountId}/phone-numbers/${phoneId}/label`, data);
  return res.data.data;
}

export async function cancelPhoneNumber(accountId: number, phoneId: number) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/cancel`, {
    confirm: true,
  });
  return res.data.data;
}

export async function pausePhoneNumber(accountId: number, phoneId: number) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/pause`, {
    confirm: true,
  });
  return res.data.data;
}

export async function resumePhoneNumber(accountId: number, phoneId: number) {
  const res = await api.post<ApiResponse<PhoneActionResult>>(`/accounts/${accountId}/phone-numbers/${phoneId}/resume`, {
    confirm: true,
  });
  return res.data.data;
}

export async function deletePhoneNumber(accountId: number, phoneId: number) {
  const res = await api.delete<ApiResponse<null>>(`/accounts/${accountId}/phone-numbers/${phoneId}`, {
    params: { confirm: 'true' },
  });
  return res.data;
}

// 鈹€鈹€ 璁剧疆 鈹€鈹€

export async function getSettings() {
  const res = await api.get<ApiResponse<SettingItem[]>>('/settings');
  return res.data.data;
}

export async function updateSettings(data: Record<string, string | number | boolean>) {
  const res = await api.put<ApiResponse<SettingItem[]>>('/settings', data);
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
  return res.data.data;
}
