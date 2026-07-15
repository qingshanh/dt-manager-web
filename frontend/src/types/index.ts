// 閫氱敤鍝嶅簲鏍煎紡
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

export interface PagedData<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

// 璁よ瘉
export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResult {
  token: string;
  user: AdminUser;
}

export interface AdminUser {
  id: number;
  username: string;
  created_at: string;
}

// 璇撮亾璐︽埛
export type LoginType = 'email_code' | 'phone_code' | 'email_password' | 'phone_password' | 'manual_session';
export type AppVariant = 'dingtone' | 'dingdong';
export type AccountStatus = 'pending' | 'offline' | 'online' | 'error' | 'expired';

export interface DtAccountListItem {
  id: number;
  nickname: string;
  app_variant: AppVariant;
  email: string | null;
  phone: string | null;
  dt_user_id: string | null;
  dt_device_id: string;
  status: AccountStatus;
  monitor_enabled: boolean;
  telegram_notify: boolean;
  sort_order: number;
  last_error: string | null;
  unread_count: number;
  active_phone_count: number;
  last_login_at: string | null;
  created_at: string;
}

export interface AccountSnapshot {
  id: number;
  account_id: number;
  dt_dingtone_id: string | null;
  full_name: string | null;
  avatar_url: string | null;
  gender: number | null;
  birthday: string | null;
  email: string | null;
  phone: string | null;
  about_me: string | null;
  feeling: string | null;
  company: string | null;
  school: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  primary_balance: number | null;
  user_grade: number | null;
  valid_point: number | null;
  progress_point: number | null;
  membership_type: string | null;
  membership_expire_at: string | null;
  profile_ver_code: string | null;
  raw_json: string | null;
  updated_at: string;
}

export interface DtAccountDetail {
  id: number;
  nickname: string;
  app_variant: AppVariant;
  login_type: LoginType;
  email: string | null;
  phone: string | null;
  dt_user_id: string | null;
  dt_device_id: string;
  status: AccountStatus;
  monitor_enabled: boolean;
  telegram_notify: boolean;
  proxy_enabled: boolean;
  last_login_at: string | null;
  last_error: string | null;
  snapshot: AccountSnapshot | null;
  phone_number_count: number;
  active_phone_count: number;
  total_messages: number;
  unread_messages: number;
  today_messages: number;
  latest_monitor: {
    id: number;
    status: 'running' | 'stopped' | 'error';
    route_address: string | null;
    heartbeat_count: number;
    msg_received_count: number;
    error_message: string | null;
    started_at: string;
    stopped_at: string | null;
  } | null;
}

export interface CreateAccountRequest {
  nickname?: string;
  app_variant?: AppVariant;
  login_type: LoginType;
  email?: string;
  phone?: string;
  password?: string;
  device_id?: string;
  telegram_notify?: boolean;
  proxy_enabled?: boolean;
}

export interface DirectSessionValidation {
  ok: boolean;
  host: string;
  device_id: string;
  calls: Array<{
    name: string;
    ok: boolean;
    duration_ms: number;
  }>;
}

export interface ValidateSessionRequest {
  dt_user_id?: string;
  token?: string;
  device_id?: string;
  device_id_candidates?: string[];
  app_variant?: AppVariant;
  package_name?: string;
  phone_preview_country_code?: number;
}

export interface ValidateSessionResult {
  dt_user_id: string;
  dt_device_id: string;
  status: string;
  validation: DirectSessionValidation | null;
  validation_error?: string | null;
  snapshot: AccountSnapshot | null;
  refresh_error: string | null;
}

export interface AccessCodeProbeCall {
  name: string;
  ok: boolean;
  duration_ms: number;
  payload: unknown;
  error: string | null;
}

export interface AccessCodeProbeCapability {
  mode: 'probe_only';
  verified_calls: string[];
  login_token_completed: boolean;
  requires_external_capture_for_login_token: boolean;
  note: string;
}

export interface AccessCodeProbeDryRunCapability {
  mode: 'probe_only';
  verifiedCalls: string[];
  loginTokenCompleted: boolean;
  requiresExternalCaptureForLoginToken: boolean;
  note: string;
}

export interface AccessCodeProbeResult {
  ok: boolean;
  host: string;
  dt_user_id: string;
  device_id: string | null;
  kind: 'email' | 'phone';
  target: string;
  capability: AccessCodeProbeCapability;
  recover_password: AccessCodeProbeCall | null;
  verify_access_code: AccessCodeProbeCall | null;
  trace: Array<{
    received_at: string;
    frame_type: number;
    status?: number;
    route_hex?: string;
    raw_length: number;
    body_length: number;
    json_payload?: unknown;
  }>;
}

export interface AccessCodeProbeDryRunResult {
  dry_run: true;
  capability: AccessCodeProbeDryRunCapability;
  kind: 'email' | 'phone';
  target: string;
  countryCode: number;
  recoverPassword: {
    apiName: 'recoverPassword';
    query: string;
    params: Record<string, string>;
  };
  verifyAccessCode?: {
    apiName: 'verifyAccessCode';
    query: string;
    params: Record<string, string>;
  };
}

export interface AccessCodeProbeRequest {
  kind?: 'email' | 'phone';
  target?: string;
  country_code?: number;
  access_code?: string;
  no_code?: number;
  dry_run?: boolean;
  confirm?: boolean;
}

export interface UpdateAccountRequest {
  nickname?: string | null;
  password?: string;
  telegram_notify?: boolean;
  proxy_enabled?: boolean;
  device_id?: string | null;
}

// 手机号
export type PhoneStatus = 'active' | 'paused' | 'expired' | 'cancelled' | 'pending';

export interface PhoneNumber {
  id: number;
  account_id: number;
  phone_number: string;
  country_code: number | null;
  provider_id: number | null;
  display_name: string | null;
  status: PhoneStatus;
  purchase_type: number | null;
  pay_type: number | null;
  valid_period_days: number | null;
  gain_time: string | null;
  expired_time: string | null;
  auto_renew: boolean;
  is_primary: boolean;
  is_good_number: boolean;
  allow_receive_sms: boolean | null;
  portout_info: string | null;
  raw_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface PhoneSmsReceptionRepairResult {
  checked: number;
  repaired: number;
  already_enabled: number;
  unknown: number;
  failed: Array<{ phone_number: string; error: string }>;
  phone_numbers: PhoneNumber[];
}

export interface UpdatePhoneLabelBody {
  display_name: string;
}

export interface RequestPhoneNumberBody {
  country_code?: number;
  iso_country_code?: string;
  country_key?: string;
  area_code?: number;
}

export interface PhoneCountryOption {
  country_key: string;
  label: string;
  country_code: number;
  iso_country_code: string;
  provider_id_list: string[];
  available: boolean;
  raw_json?: string | null;
}

export interface PhonePurchaseCandidate {
  phone_number: string;
  country_code: number | null;
  area_code: number | null;
  provider_id: number | null;
  package_service_id: string | null;
  category: number | null;
  phone_type: number | null;
  display_name: string | null;
  city_name: string | null;
  state_name: string | null;
  iso_country_code: string | null;
  good_number_level: number | null;
  use_history: number | null;
  price: number | null;
  product_id: string | null;
  raw_json?: string | null;
}

export interface PhonePurchasePreview {
  free_chance: number | null;
  candidates: PhonePurchaseCandidate[];
  raw_json?: string | null;
}

export interface PurchasePhoneNumberBody {
  country_code?: number;
  iso_country_code?: string;
  country_key?: string;
  candidate: PhonePurchaseCandidate;
  confirm?: boolean;
}

export interface PurchasePhoneNumberResult {
  phone: PhoneNumber;
  snapshot: AccountSnapshot | null;
  verification?: PhoneActionVerification;
}

export interface PointStoreProduct {
  product_id: string;
  name: string;
  stock: number | null;
  price: number | null;
  raw_json?: string | null;
}

export interface PointStoreData {
  point_uid: string;
  email: string | null;
  user_name: string | null;
  user_grade: number | null;
  valid_point: number | null;
  history_point: number | null;
  expire_point: number | null;
  expire_time: string | null;
  products: PointStoreProduct[];
  snapshot: AccountSnapshot | null;
  raw?: {
    userInfo: unknown;
    store: unknown;
  };
}

export interface PointBenefit {
  code: string;
  name: string;
  price: number | null;
  stock: number | null;
}

export interface PointData {
  point_uid: string | null;
  user_id: string | null;
  game_uid: string | null;
  app_type: number;
  game_app_id: number;
  user_name: string | null;
  user_grade: number | null;
  valid_point: number | null;
  history_point: number | null;
  expire_point: number | null;
  expire_time: string | null;
  game_benefits: PointBenefit[];
  snapshot: AccountSnapshot | null;
  raw?: {
    userInfo: unknown;
    gradeInfo: unknown;
    gameHomePage: unknown;
    gameRedeemInfo: unknown;
  };
}

export interface PointStoreOrderResult {
  product: PointStoreProduct;
  email: string;
  order_id: string | null;
  order: unknown;
  order_info: unknown;
  history_order: PointStoreOrder;
  point_store: PointStoreData;
}

export interface PointStoreOrder {
  id: number;
  account_id: number;
  remote_order_id: string | null;
  product_id: string;
  product_name: string;
  product_price: number | null;
  email: string;
  status: string;
  order_time: string | null;
  created_at: string;
  updated_at: string;
}

export type BulkAccountAction = 'start_monitor' | 'stop_monitor' | 'telegram_on' | 'telegram_off' | 'mark_read' | 'mark_unread';

export interface BulkAccountActionResult {
  action: BulkAccountAction;
  requested: number;
  succeeded: number;
  failed: number;
  messages_updated?: number;
  results: Array<{
    account_id: number;
    ok: boolean;
    error: string | null;
  }>;
}

export interface UnreadNotificationFeed {
  unread_count: number;
  list: RecentMessage[];
}

export interface VersionInfo {
  version: string;
  build_version: string;
  commit_sha: string | null;
  short_sha: string | null;
  branch: string | null;
  repository: string;
  update_branch: string;
  latest_version: VersionCommit | null;
  update_available: boolean | null;
  update_status: 'current' | 'behind' | 'ahead' | 'diverged' | 'unknown';
  check_error: string | null;
  checked_at: string;
  recent_versions: VersionCommit[];
}

export interface VersionCommit {
  sha: string;
  short_sha: string;
  title: string;
  committed_at: string | null;
  url: string | null;
}

export interface PhoneActionVerification {
  source: string;
  confirmed: boolean;
  action?: 'purchase' | 'renew' | 'cancel' | 'pause' | 'resume';
  phone_number: string;
  status: PhoneStatus;
  note?: string | null;
}

export interface PhoneActionResult {
  phone: PhoneNumber;
  verification?: PhoneActionVerification;
}

export interface RefreshMessagesResult {
  imported: number;
  background?: boolean;
  background_started?: boolean;
  scanned?: number;
  matched?: number;
  diagnostics?: Array<{
    source: string;
    scanned: number;
    imported: number;
    sampleSender: string | null;
    sampleContent: string | null;
    sampleReceivedAt: string | null;
    note?: string | null;
    offlineTemplate?: {
      attempted: boolean;
      sent: boolean;
      sendCount: number;
      status: 'sent' | 'attempted-not-sent' | 'not-attempted';
      listenStatus?: 'completed' | 'preempted';
      error?: string | null;
    } | null;
  }>;
  messages: Message[];
}

// 娑堟伅
export type MessageDirection = 'incoming' | 'outgoing';
export type MessageType = 'sms' | 'verification' | 'mms' | 'system';

export interface Message {
  id: number;
  account_id: number;
  direction: MessageDirection;
  msg_type: MessageType;
  from_number: string | null;
  to_number: string | null;
  content: string;
  raw_info: string | null;
  raw_k3: string | null;
  k5_flag: number | null;
  is_read: boolean;
  telegram_sent: boolean;
  telegram_msg_id: string | null;
  received_at: string;
  created_at: string;
}

export interface RecentMessage extends Message {
  account: {
    id: number;
    nickname: string;
    app_variant?: 'dingtone' | 'dingdong';
    appVariant?: 'dingtone' | 'dingdong';
  };
}

// 仪表盘
export interface DashboardStats {
  totalAccounts: number;
  onlineAccounts: number;
  totalMessages: number;
  unreadMessages: number;
  totalPhoneNumbers: number;
  activePhoneNumbers: number;
}

// 璁剧疆
export interface SettingItem {
  id: number;
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

// SSE 浜嬩欢
export interface SSENewMessageEvent {
  id?: number;
  accountId: number;
  accountNickname: string;
  from: string | null;
  toNumber: string | null;
  content: string;
  msgType?: string;
  receivedAt: string;
}

export interface SSEAccountStatusEvent {
  accountId: number;
  status: string;
  message?: string;
}

// 鐩戝惉浼氳瘽
export interface MonitorSession {
  session_id: number;
  status: string;
  server?: string;
  stopped_at?: string;
}
