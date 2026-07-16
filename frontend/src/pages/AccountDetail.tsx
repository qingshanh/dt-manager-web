import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import {
  ArrowLeftOutlined,
  CopyOutlined,
  DeleteOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import {
  CACHE_TTL_MS,
  cacheKeys,
  captureSession,
  cancelPhoneNumber,
  deleteMessage,
  deletePhoneNumber,
  enablePhoneSmsReception,
  getAccount,
  getAccountMessage,
  getAccountMessages,
  getAccountPointStore,
  getPhoneNumberCountries,
  getPhoneNumbers,
  isCachedDataFresh,
  readCachedData,
  pausePhoneNumber,
  previewPhoneNumbers,
  probeAccessCode,
  purchasePhoneNumber,
  readAllMessages,
  refreshAccount,
  refreshAccountMessages,
  reLogin,
  renewPhoneNumber,
  resumePhoneNumber,
  startMonitor,
  stopMonitor,
  syncHelperMessages,
  syncPhoneNumbers,
  updateAccount,
  updatePhoneNumberLabel,
  validateSession,
} from '../services/endpoints';
import type {
  DtAccountDetail,
  AccessCodeProbeCall,
  AccessCodeProbeCapability,
  AccessCodeProbeDryRunCapability,
  AccessCodeProbeDryRunResult,
  AccessCodeProbeResult,
  Message,
  PagedData,
  PhoneCountryOption,
  PhoneNumber,
  PhoneActionResult,
  PhoneActionVerification,
  PhonePurchaseCandidate,
  PhonePurchasePreview,
  PhoneStatus,
  PointStoreData,
  RefreshMessagesResult,
  SSENewMessageEvent,
  ValidateSessionResult,
} from '../types';
import { notifyMessageReadStateChanged } from '../services/ui-events';
import DirectSessionImportModal, {
  type DirectSessionImportValues,
} from '../components/accounts/DirectSessionImportModal';

type SnapshotExtras = {
  dtDingtoneId: string | null;
  primaryBalance: number | null;
  validPoint: number | null;
  progressPoint: number | null;
  progressPointTotal: number | null;
  expirePoint: number | null;
  expireTime: string | null;
  membershipType: string | null;
  membershipLevelLabel: string | null;
  userGrade: number | null;
  walletPrivilege: string | null;
  membershipBenefits: Array<{ code: string; name: string; price: number | null }>;
};

type AccessCodeProbeFormValues = {
  kind: 'email' | 'phone';
  target: string;
  countryCode: number;
  accessCode: string;
  dryRun: boolean;
};

const LOCAL_MESSAGE_POLL_MS = 30_000;

const loginTypeLabelMap: Record<string, string> = {
  email_code: '邮箱验证码',
  phone_code: '手机号验证码',
  email_password: '邮箱密码',
  phone_password: '手机号密码',
  manual_session: '手动导入会话',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function collectRecords(
  value: unknown,
  depth = 0,
  bucket: Record<string, unknown>[] = [],
  visited = new Set<unknown>(),
) {
  if (depth > 5 || value === null || value === undefined || visited.has(value)) {
    return bucket;
  }
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectRecords(item, depth + 1, bucket, visited));
    return bucket;
  }
  if (!isRecord(value)) {
    return bucket;
  }
  bucket.push(value);
  Object.values(value).forEach((item) => collectRecords(item, depth + 1, bucket, visited));
  return bucket;
}

function pickStringFromRecords(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    const value = pickString(record, keys);
    if (value) {
      return value;
    }
  }
  return null;
}

function pickNumberFromRecords(records: Record<string, unknown>[], keys: string[]) {
  for (const record of records) {
    const value = pickNumber(record, keys);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function extractMembershipBenefits(value: unknown) {
  const records = collectRecords(value);
  const result: Array<{ code: string; name: string; price: number | null }> = [];
  const preferredLists: unknown[][] = [];

  if (isRecord(value) && isRecord(value.publicPoint) && Array.isArray(value.publicPoint.membershipBenefits)) {
    preferredLists.push(value.publicPoint.membershipBenefits as unknown[]);
  }

  for (const rawList of preferredLists) {
    rawList.forEach((item: unknown) => {
      if (!isRecord(item)) {
        return;
      }
      const name = pickString(item, ['name', 'label', 'title']);
      if (!name) {
        return;
      }
      result.push({
        code: pickString(item, ['code']) || '',
        name,
        price: pickNumber(item, ['price', 'cost', 'needPay', 'need_pay']),
      });
    });
    if (result.length > 0) {
      return result;
    }
  }

  for (const record of records) {
    const candidateLists = [record.membershipBenefits, record.membership_benefits, record.benefits];
    const rawList = candidateLists.find(Array.isArray) as unknown[] | undefined;
    if (!rawList) {
      continue;
    }
    rawList.forEach((item) => {
      if (!isRecord(item)) {
        return;
      }
      const name = pickString(item, ['name', 'label', 'title']);
      if (!name) {
        return;
      }
      result.push({
        code: pickString(item, ['code']) || '',
        name,
        price: pickNumber(item, ['price', 'cost', 'needPay', 'need_pay']),
      });
    });
    if (result.length > 0) {
      return result;
    }
  }

  return result;
}

function parseSnapshotExtras(rawJson?: string | null): SnapshotExtras {
  const empty: SnapshotExtras = {
    dtDingtoneId: null,
    primaryBalance: null,
    validPoint: null,
    progressPoint: null,
    progressPointTotal: null,
    expirePoint: null,
    expireTime: null,
    membershipType: null,
    membershipLevelLabel: null,
    userGrade: null,
    walletPrivilege: null,
    membershipBenefits: [],
  };

  if (!rawJson) {
    return empty;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const publicPoint = isRecord(parsed) && isRecord(parsed.publicPoint) ? parsed.publicPoint : null;
    const rawBalance = isRecord(parsed) && isRecord(parsed.balance) ? parsed.balance : null;
    const gameRedeemInfo = publicPoint && isRecord(publicPoint.gameRedeemInfo) ? publicPoint.gameRedeemInfo : null;
    const gameHomePage = publicPoint && isRecord(publicPoint.gameHomePage) ? publicPoint.gameHomePage : null;
    const balanceDisplayFallback = (() => {
      const primaryBalance = pickNumber(rawBalance ?? {}, ['primaryBalance', 'balance']);
      const creditExchangeRatio = pickNumber(rawBalance ?? {}, ['creditExchangeRatio']);
      if (
        primaryBalance === null ||
        creditExchangeRatio === null ||
        !Number.isFinite(primaryBalance) ||
        !Number.isFinite(creditExchangeRatio) ||
        creditExchangeRatio <= 0
      ) {
        return null;
      }
      return primaryBalance / creditExchangeRatio;
    })();
    const records = collectRecords(parsed);
    if (records.length === 0) {
      return empty;
    }

    return {
      dtDingtoneId: pickStringFromRecords(records, ['dtDingtoneId', 'dt_dingtone_id', 'dingtoneId', 'dingtone_id']),
      primaryBalance:
        pickNumber(publicPoint ?? {}, ['balanceDisplay', 'balance_display']) ??
        balanceDisplayFallback ??
        pickNumberFromRecords(records, [
          'balanceDisplay',
          'balance_display',
          'primaryBalance',
          'primary_balance',
          'balance',
          'balanceAmount',
          'balance_amount',
          'availableBalance',
          'available_balance',
          'walletBalance',
          'wallet_balance',
          'coinBalance',
          'coin_balance',
          'creditBalance',
          'credit_balance',
        ]),
      validPoint:
        pickNumber(publicPoint ?? {}, ['validPoint', 'valid_point']) ??
        pickNumber(gameRedeemInfo ?? {}, ['validPoint']) ??
        pickNumber(gameHomePage ?? {}, ['validPoint']) ??
        pickNumberFromRecords(records, [
          'validPoint',
          'valid_point',
          'usablePoint',
          'usable_point',
          'availablePoint',
          'available_point',
          'tokenNumber',
          'token_number',
        ]),
      progressPoint:
        pickNumber(publicPoint ?? {}, ['progressPoint', 'progress_point']) ??
        pickNumber(gameRedeemInfo ?? {}, ['validPoint']) ??
        pickNumber(gameHomePage ?? {}, ['validPoint']) ??
        pickNumberFromRecords(records, [
          'progressPoint',
          'progress_point',
          'currentPoint',
          'current_point',
          'levelPoint',
          'level_point',
          'totalPoint',
          'total_point',
          'historyPoint',
          'history_point',
        ]),
      progressPointTotal:
        pickNumber(publicPoint ?? {}, ['progressPointTotal', 'progress_point_total']) ??
        pickNumberFromRecords(records, [
          'progressPointTotal',
          'progress_point_total',
          'totalProgressPoint',
          'total_progress_point',
          'progressTotalPoint',
          'progress_total_point',
          'pointTotal',
          'point_total',
          'nextGradePoint',
          'next_grade_point',
          'nextLevelPoint',
          'next_level_point',
        ]),
      expirePoint:
        pickNumber(publicPoint ?? {}, ['expirePoint', 'expire_point']) ??
        pickNumber(gameHomePage ?? {}, ['expirePoint', 'expire_point']) ??
        pickNumberFromRecords(records, ['expirePoint', 'expire_point', 'expiringPoint', 'expiring_point']),
      expireTime:
        pickString(publicPoint ?? {}, ['expireTime', 'expire_time']) ??
        pickString(gameHomePage ?? {}, ['expireTime', 'expire_time']) ??
        pickStringFromRecords(records, ['expireTime', 'expire_time', 'expiredDate', 'expired_date']),
      membershipType: pickStringFromRecords(records, [
        'membershipType',
        'membership_type',
        'premiumType',
        'premium_type',
        'memberType',
        'member_type',
        'walletType',
        'wallet_type',
      ]),
      membershipLevelLabel:
        pickString(publicPoint ?? {}, ['membershipLevelLabel', 'membership_level_label']) ??
        pickStringFromRecords(records, [
          'membershipLevelLabel',
          'membership_level_label',
          'levelName',
          'level_name',
          'vipLevelName',
          'vip_level_name',
          'gradeName',
          'grade_name',
        ]),
      userGrade:
        pickNumber(publicPoint ?? {}, ['userGrade', 'user_grade']) ??
        pickNumberFromRecords(records, [
          'userGrade',
          'user_grade',
          'grade',
          'vipGrade',
          'vip_grade',
          'memberGrade',
          'member_grade',
          'currentGrade',
          'current_grade',
        ]),
      walletPrivilege: pickStringFromRecords(records, ['privilege']),
      membershipBenefits: extractMembershipBenefits(parsed),
    };
  } catch {
    return empty;
  }
}

function parsePhonePurchasePreview(rawJson?: string | null): PhonePurchasePreview {
  const empty: PhonePurchasePreview = {
    free_chance: null,
    candidates: [],
  };

  if (!rawJson) {
    return empty;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const records = collectRecords(parsed);
    if (records.length === 0) {
      return empty;
    }

    let rawList: unknown[] | undefined;
    for (const record of records) {
      const candidateLists = [
        record.candidates,
        record.phones,
        record.phoneNumbers,
        record.phone_numbers,
        record.items,
        record.list,
      ];
      rawList = candidateLists.find(Array.isArray) as unknown[] | undefined;
      if (rawList?.length) {
        break;
      }
    }

    const candidates = (rawList ?? [])
      .map<PhonePurchaseCandidate | null>((item) => {
        if (!isRecord(item)) {
          return null;
        }
        return {
          phone_number: pickString(item, ['phoneNumber', 'phone_number', 'number']) || '',
          country_code: pickNumber(item, ['countryCode', 'country_code']),
          area_code: pickNumber(item, ['areaCode', 'area_code']),
          provider_id: pickNumber(item, ['providerId', 'provider_id']),
          package_service_id: pickString(item, ['packageServiceId', 'package_service_id']),
          category: pickNumber(item, ['category', 'purchaseType', 'purchase_type']),
          phone_type: pickNumber(item, ['payType', 'pay_type', 'phoneType', 'phone_type']),
          display_name: pickString(item, ['displayName', 'display_name', 'cityName', 'city_name', 'stateName', 'state_name']),
          city_name: pickString(item, ['cityName', 'city_name']),
          state_name: pickString(item, ['stateName', 'state_name']),
          iso_country_code: pickString(item, ['isoCountryCode', 'iso_country_code', 'isoCC', 'iso_cc']),
          good_number_level: pickNumber(item, ['goodNumberLevel', 'good_number_level']),
          use_history: pickNumber(item, ['useHistory', 'use_history']),
          product_id: pickString(item, ['productId', 'product_id']),
          price: pickNumber(item, [
            'orderPrice',
            'order_price',
            'price',
            'creditPrice',
            'credit_price',
            'payAmount',
            'pay_amount',
            'amount',
            'coinCost',
            'coin_cost',
            'needPay',
            'need_pay',
            'needBalance',
            'need_balance',
            'cost',
            'totalPrice',
            'total_price',
          ]),
          raw_json: JSON.stringify(item),
        };
      })
      .filter((item): item is PhonePurchaseCandidate => Boolean(item?.phone_number));

    return {
      free_chance: pickNumberFromRecords(records, ['freeChance', 'free_chance']),
      candidates,
      raw_json: rawJson,
    };
  } catch {
    return empty;
  }
}

function formatPrice(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '待解析';
  }
  return `${value.toFixed(2)} 说道币`;
}

function formatNumber(value: number | null | undefined, digits: number, fallback = '未同步') {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return fallback;
  }
  return value.toFixed(digits);
}

function formatEpochTime(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  const raw = typeof value === 'string' ? Number(value) : value;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return dayjs(ms).format('YYYY-MM-DD HH:mm');
  }
  const date = dayjs(value);
  return date.isValid() ? date.format('YYYY-MM-DD HH:mm') : '-';
}

function formatPointPriceZh(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '待解析';
  }
  return `${value.toFixed(2)} 积分`;
}

function formatPhonePrice(candidate: PhonePurchaseCandidate) {
  const raw = parseJsonRecord(candidate.raw_json);
  const rawPrice = pickNumber(raw ?? {}, [
    'reserved5',
    'orderPrice',
    'order_price',
    'price',
    'payAmount',
    'pay_amount',
    'amount',
    'coinCost',
    'coin_cost',
    'needPay',
    'need_pay',
    'needBalance',
    'need_balance',
    'cost',
    'totalPrice',
    'total_price',
  ]);
  const price = candidate.price ?? rawPrice;
  const monthDollarPrice = pickNumber(raw ?? {}, ['monthDollarPrice', 'month_dollar_price']);
  const yearDollarPrice = pickNumber(raw ?? {}, ['yearDollarPrice', 'year_dollar_price']);
  const extraChargeMonthsCount = pickNumber(raw ?? {}, ['extraChargeMonthsCount', 'extra_charge_months_count']);
  const extraChargeMonthsPrice = pickNumber(raw ?? {}, ['extraChargeMonthsPrice', 'extra_charge_months_price']);
  const dollarText =
    monthDollarPrice !== null
      ? `，$${monthDollarPrice}/月`
      : yearDollarPrice !== null
        ? `，$${yearDollarPrice}/年`
        : '';
  const rawPeriod = pickNumber(raw ?? {}, ['usePeriod', 'use_period', 'validPeriodDays', 'valid_period_days']);
  const periodText = rawPeriod === null ? '3个月' : rawPeriod <= 12 ? `${rawPeriod}个月` : `${rawPeriod}天`;
  if (price !== null && price !== undefined && !Number.isNaN(price)) {
    const packageText =
      extraChargeMonthsPrice !== null && extraChargeMonthsPrice !== undefined && !Number.isNaN(extraChargeMonthsPrice)
        ? `；${extraChargeMonthsPrice} 说道币 / ${extraChargeMonthsCount || 12}个月`
        : '';
    return `${price} 说道币 / ${periodText}${packageText}${dollarText}`;
  }
  return `接口未返回价格（常见 900-1500 说道币 / ${periodText}）`;
}

function formatPointPrice(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '待解析';
  }
  return `${value.toFixed(2)} 积分`;
}

void formatPrice;
void formatPointPrice;

function buildCandidateTitle(candidate: PhonePurchaseCandidate) {
  const normalizedDisplayName =
    candidate.display_name && !['AA', 'null', 'None'].includes(candidate.display_name) ? candidate.display_name : null;
  const location =
    normalizedDisplayName ||
    [candidate.city_name, candidate.state_name, candidate.iso_country_code].filter(Boolean).join(' / ') ||
    (candidate.country_code ? `+${candidate.country_code}` : '未知地区');
  return `${formatPhoneWithCountryCode(candidate.phone_number, candidate.country_code)} / ${location}`;
}

function formatPhoneWithCountryCode(phoneNumber: string | null | undefined, countryCode: number | null | undefined) {
  const value = phoneNumber?.trim();
  if (!value) {
    return '-';
  }
  if (!countryCode) {
    return value;
  }
  const digits = value.replace(/\D/g, '');
  const prefix = String(countryCode);
  if (!digits.startsWith(prefix) || digits.length <= prefix.length) {
    return `+${countryCode} ${value.replace(/^\+/, '')}`;
  }
  return `+${countryCode} ${digits.slice(prefix.length)}`;
}

function formatPhoneForClipboard(phoneNumber: string | null | undefined, countryCode: number | null | undefined) {
  const value = phoneNumber?.trim();
  if (!value) {
    return '';
  }
  const digits = value.replace(/\D/g, '');
  if (!countryCode) {
    return value.startsWith('+') ? `+${digits}` : value;
  }
  const prefix = String(countryCode);
  const fullDigits = digits.startsWith(prefix) ? digits : `${prefix}${digits}`;
  return `+${fullDigits}`;
}

function extractVerificationCodeFromContent(content: string | null | undefined) {
  return content?.match(/\b\d{4,8}\b/)?.[0] ?? null;
}

function isVerificationMessage(record: Message) {
  return record.msg_type === 'verification' || Boolean(extractVerificationCodeFromContent(record.content));
}

function phoneActionLabel(action: 'renew' | 'cancel' | 'pause' | 'resume') {
  return {
    renew: '续费',
    cancel: '取消',
    pause: '暂停',
    resume: '恢复',
  }[action];
}

function formatPhoneVerificationSuffix(verification?: PhoneActionVerification | null) {
  if (!verification) {
    return '';
  }
  if (verification.confirmed) {
    return '，并已通过远端号码列表确认';
  }
  if (verification.source === 'helper_purchase_response' || verification.source === 'helper_action_response') {
    return '，helper 回包已写入，本次未做远端号码列表确认';
  }
  return '，未通过远端号码列表确认';
}

function inferAccessCodeCountryCode(target: string) {
  const digits = target.replace(/\D/g, '');
  if (!digits) {
    return 1;
  }
  const countryCodes = [
    1787, 420, 230, 886, 852, 86, 82, 81, 65, 62, 61, 60, 48, 46, 45, 44, 43, 40, 34, 33, 32, 31, 7, 1,
  ];
  const matched = countryCodes.find((countryCode) => digits.startsWith(String(countryCode)));
  if (!matched) {
    return 1;
  }
  if (target.trim().startsWith('+')) {
    return matched;
  }
  return looksLikeInternationalPhoneDigits(digits, matched) ? matched : 1;
}

function validateAccessCodeProbeTarget(kind: 'email' | 'phone', target: string) {
  const trimmed = target.trim();
  if (!trimmed) {
    return kind === 'phone' ? '请输入手机号' : '请输入邮箱';
  }
  if (kind === 'email') {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? null : '请输入有效邮箱';
  }
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? null : '请输入 7-15 位手机号数字';
}

function looksLikeInternationalPhoneDigits(digits: string, countryCode: number) {
  if (countryCode === 1) {
    return digits.length >= 11;
  }
  const countryLength = String(countryCode).length;
  const localLength = digits.length - countryLength;
  if (countryLength >= 4) {
    return localLength >= 7;
  }
  if (countryLength >= 3) {
    return localLength >= 7;
  }
  return localLength >= 9;
}

function AccessCodeProbeFormContent({
  initialValues,
  accountEmail,
  accountPhone,
  onChange,
}: {
  initialValues: AccessCodeProbeFormValues;
  accountEmail?: string | null;
  accountPhone?: string | null;
  onChange: (values: AccessCodeProbeFormValues) => void;
}) {
  const [values, setValues] = useState(initialValues);

  const updateValues = (next: AccessCodeProbeFormValues) => {
    setValues(next);
    onChange(next);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div style={{ color: '#666' }}>
        默认只预览 recoverPassword / verifyAccessCode 参数，不会联网。
      </div>
      {!values.dryRun && (
        <Alert
          type="warning"
          showIcon
          message="真实请求会提交 confirm=true，并复用当前直连会话请求验证码接口，可能触发验证码短信。"
        />
      )}
      <Switch
        checkedChildren="dry-run"
        unCheckedChildren="真实请求"
        checked={values.dryRun}
        onChange={(checked) => {
          updateValues({ ...values, dryRun: checked });
        }}
      />
      <Select
        value={values.kind}
        style={{ width: '100%' }}
        options={[
          { value: 'phone', label: '手机号' },
          { value: 'email', label: '邮箱' },
        ]}
        onChange={(kind) => {
          const target = kind === 'email' ? accountEmail ?? values.target : accountPhone ?? values.target;
          updateValues({
            ...values,
            kind,
            target,
            countryCode: kind === 'phone' ? inferAccessCodeCountryCode(target) : 1,
          });
        }}
      />
      <Input
        value={values.target}
        placeholder="手机号或邮箱"
        onChange={(event) => {
          const target = event.target.value;
          updateValues({
            ...values,
            target,
            countryCode: values.kind === 'phone' ? inferAccessCodeCountryCode(target) : values.countryCode,
          });
        }}
      />
      <InputNumber
        value={values.countryCode}
        min={1}
        precision={0}
        style={{ width: '100%' }}
        placeholder="手机号国家码，例如 1、86、33"
        disabled={values.kind === 'email'}
        onChange={(value) => {
          updateValues({ ...values, countryCode: typeof value === 'number' && value > 0 ? value : 1 });
        }}
      />
      <Input
        value={values.accessCode}
        placeholder="可选：收到的验证码。留空则只追踪发码请求"
        onChange={(event) => {
          updateValues({ ...values, accessCode: event.target.value });
        }}
      />
    </Space>
  );
}

function normalizePreview(preview: PhonePurchasePreview) {
  return preview.candidates.length > 0 ? preview : parsePhonePurchasePreview(preview.raw_json);
}

function parseJsonRecord(rawJson?: string | null) {
  if (!rawJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readNestedRecord(record: Record<string, unknown> | null, key: string) {
  if (!record) {
    return null;
  }
  const value = record[key];
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function getCountryDisplayName(countryCode: number | null | undefined) {
  const map: Record<number, string> = {
    1: '美国/加拿大',
    7: '俄罗斯',
    31: '荷兰',
    32: '比利时',
    33: '法国',
    34: '西班牙',
    40: '罗马尼亚',
    43: '奥地利',
    44: '英国',
    45: '丹麦',
    46: '瑞典',
    48: '波兰',
    60: '马来西亚',
    61: '澳大利亚',
    62: '印度尼西亚',
    65: '新加坡',
    81: '日本',
    82: '韩国',
    86: '中国',
    230: '毛里求斯',
    420: '捷克',
    852: '香港',
    886: '台湾',
    1787: '波多黎各',
  };
  if (!countryCode) {
    return '-';
  }
  return map[countryCode] || `+${countryCode}`;
}

function getPhoneRegionDisplay(phone: PhoneNumber) {
  const raw = parseJsonRecord(phone.raw_json);
  const countryCode = phone.country_code ?? pickNumber(raw ?? {}, ['countryCode', 'country_code']);
  const areaCode = pickNumber(raw ?? {}, ['areaCode', 'area_code']);
  const cityName = pickString(raw ?? {}, ['cityName', 'city_name']);
  const stateName = pickString(raw ?? {}, ['stateName', 'state_name']);
  const parts = [
    cityName,
    stateName,
    countryCode ? getCountryDisplayName(countryCode) : null,
    areaCode ? `区号 ${areaCode}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : '-';
}

function getPhoneRemarkDisplay(phone: PhoneNumber) {
  return phone.display_name?.trim() || '-';
}

function getStoredPhoneCost(phone: PhoneNumber) {
  const raw = parseJsonRecord(phone.raw_json);
  const nested = readNestedRecord(raw, 'reserved10');
  const price =
    pickNumber(raw ?? {}, ['reserved5', 'price', 'orderPrice', 'order_price', 'cost', 'amount']) ??
    pickNumber(nested ?? {}, ['price', 'orderPrice', 'order_price', 'cost', 'amount']);
  const usePeriod =
    pickNumber(nested ?? {}, ['usePeriod', 'use_period']) ??
    pickNumber(raw ?? {}, ['validPeriodDays', 'valid_period_days', 'usePeriod', 'use_period']);
  const periodText =
    usePeriod === null
      ? phone.valid_period_days
        ? `${Math.round(phone.valid_period_days / 31)}个月`
        : null
      : usePeriod <= 12
        ? `${usePeriod}个月`
        : `${usePeriod}天`;
  if (price === null) {
    return '未记录';
  }
  return `${price} 说道币${periodText ? ` / ${periodText}` : ''}`;
}

function getPhoneRegion(phone: PhoneNumber) {
  return getPhoneRegionDisplay(phone);
}

function buildRefreshDiagnosticsSummary(diagnostics: RefreshMessagesResult['diagnostics']) {
  if (!diagnostics || diagnostics.length === 0) {
    return '';
  }
  return diagnostics
    .map((item) => {
      const sample = item.sampleSender
        ? `${item.sampleSender}${item.sampleReceivedAt ? ` @ ${dayjs(item.sampleReceivedAt).format('MM-DD HH:mm:ss')}` : ''}`
        : item.sampleContent
          ? item.sampleContent.length > 120
            ? `${item.sampleContent.slice(0, 117)}...`
            : item.sampleContent
          : '无样本';
      const offlineTemplate = formatOfflineTemplateDiagnostic(item.offlineTemplate);
      const details = [offlineTemplate, item.note].filter(Boolean).join(' / ');
      return `${item.source}: 扫描 ${item.scanned} / 导入 ${item.imported} / ${sample}${details ? ` / ${details}` : ''}`;
    })
    .join('\n');
}

function formatOfflineTemplateDiagnostic(item: NonNullable<NonNullable<RefreshMessagesResult['diagnostics']>[number]['offlineTemplate']> | null | undefined) {
  if (!item) {
    return '';
  }
  const listen = item.listenStatus === 'preempted' ? ' / listener preempted' : '';
  const count = item.sendCount ? ` x${item.sendCount}` : '';
  if (item.status === 'sent') {
    return `offline catch-up sent${count}${listen}`;
  }
  if (item.status === 'attempted-not-sent') {
    return `offline catch-up attempted but not sent${item.error ? ` (${item.error})` : ''}${listen}`;
  }
  return `offline catch-up not attempted${listen}`;
}

function formatProbeCall(call: AccessCodeProbeCall | null) {
  if (!call) {
    return '未执行';
  }
  if (!call.ok) {
    return `失败 / ${call.duration_ms}ms / ${call.error || '无错误详情'}`;
  }
  return `成功 / ${call.duration_ms}ms`;
}

function formatProbePayload(call: AccessCodeProbeCall | null) {
  if (!call?.payload) {
    return '-';
  }
  return JSON.stringify(call.payload, null, 2);
}

function formatProbeCapability(capability: AccessCodeProbeCapability | AccessCodeProbeDryRunCapability | undefined) {
  if (!capability) {
    return '未知';
  }
  const loginCompleted =
    'login_token_completed' in capability ? capability.login_token_completed : capability.loginTokenCompleted;
  const verifiedCalls = 'verified_calls' in capability ? capability.verified_calls : capability.verifiedCalls;
  const modeLabel = capability.mode === 'probe_only' ? '仅链路探针' : capability.mode;
  return `${modeLabel} / ${verifiedCalls.join(', ')} / login token ${loginCompleted ? '已完成' : '未完成'}`;
}

function isAccessCodeDryRun(value: AccessCodeProbeResult | AccessCodeProbeDryRunResult): value is AccessCodeProbeDryRunResult {
  return 'dry_run' in value && value.dry_run === true;
}

function getPhoneRemark(phone: PhoneNumber) {
  return phone.display_name || '-';
}

void getPhoneRemark;

function PurchaseCandidatePicker(props: {
  preview: PhonePurchasePreview;
  onChange: (candidate: PhonePurchaseCandidate | null) => void;
}) {
  const { preview, onChange } = props;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const candidate = preview.candidates[selectedIndex] ?? null;

  useEffect(() => {
    onChange(candidate);
  }, [candidate, onChange]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div>
        当前共返回 {preview.candidates.length} 个候选号，免费次数：{preview.free_chance ?? '未返回'}
      </div>
      <Select
        defaultValue={0}
        style={{ width: '100%' }}
        options={preview.candidates.map((item, index) => ({
          label: `${buildCandidateTitle(item)} / ${formatPhonePrice(item)}`,
          value: index,
        }))}
        onChange={(value) => setSelectedIndex(Number(value))}
      />
      {candidate && (
        <Card size="small" title="号码详情">
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="号码">{formatPhoneWithCountryCode(candidate.phone_number, candidate.country_code)}</Descriptions.Item>
            <Descriptions.Item label="地区">
              {candidate.display_name ||
                [candidate.city_name, candidate.state_name, candidate.iso_country_code].filter(Boolean).join(' / ') ||
                '-'}
            </Descriptions.Item>
            <Descriptions.Item label="收费">{formatPhonePrice(candidate)}</Descriptions.Item>
            <Descriptions.Item label="国家码">{candidate.country_code ? `+${candidate.country_code}` : '-'}</Descriptions.Item>
            <Descriptions.Item label="区号">{candidate.area_code ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="供应商">{candidate.provider_id ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="购买分类">{candidate.category ?? '-'}</Descriptions.Item>
          </Descriptions>
        </Card>
      )}
    </Space>
  );
}

export default function AccountDetail() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { message, modal } = App.useApp();

  const [account, setAccount] = useState<DtAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [teamMessages, setTeamMessages] = useState<Message[]>([]);
  const [teamMsgTotal, setTeamMsgTotal] = useState(0);
  const [teamMsgPage, setTeamMsgPage] = useState(1);
  const [teamMessageModalOpen, setTeamMessageModalOpen] = useState(false);
  const [msgTotal, setMsgTotal] = useState(0);
  const [msgPage, setMsgPage] = useState(1);
  const [msgLoading, setMsgLoading] = useState(false);
  const [teamMsgLoading, setTeamMsgLoading] = useState(false);
  const messageRequestIdRef = useRef(0);
  const teamMessageRequestIdRef = useRef(0);
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') === 'messages' ? 'messages' : 'info');
  const focusedMessageId = useMemo(() => {
    const value = Number(searchParams.get('messageId'));
    return Number.isInteger(value) && value > 0 ? value : null;
  }, [searchParams]);
  const [syncingLatestMessages, setSyncingLatestMessages] = useState(false);
  const [syncingAppMessages, setSyncingAppMessages] = useState(false);
  const [refreshingAccountData, setRefreshingAccountData] = useState(false);
  const [refreshingLocalMessages, setRefreshingLocalMessages] = useState(false);
  const [lastRefreshDiagnostics, setLastRefreshDiagnostics] = useState<
    Array<{
      source: string;
      scanned: number;
      imported: number;
      sampleSender: string | null;
      sampleContent: string | null;
      sampleReceivedAt: string | null;
      note?: string | null;
    }> | null
  >(null);
  const [phones, setPhones] = useState<PhoneNumber[]>([]);
  const [phoneCountries, setPhoneCountries] = useState<PhoneCountryOption[]>([]);
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [directSessionImportOpen, setDirectSessionImportOpen] = useState(false);
  const [directSessionImportLoading, setDirectSessionImportLoading] = useState(false);
  const [editNickname, setEditNickname] = useState(false);
  const [nickname, setNickname] = useState('');
  const [pointStore, setPointStore] = useState<PointStoreData | null>(null);
  const [pointStoreLoading, setPointStoreLoading] = useState(false);

  const snapshot = account?.snapshot;
  const snapshotExtras = useMemo(() => parseSnapshotExtras(snapshot?.raw_json), [snapshot?.raw_json]);

  const balanceValue = snapshotExtras.primaryBalance ?? snapshot?.primary_balance ?? null;
  const validPointValue = pointStore?.valid_point ?? snapshot?.valid_point ?? snapshotExtras.validPoint ?? null;
  const userGradeValue = pointStore?.user_grade ?? snapshotExtras.userGrade ?? snapshot?.user_grade ?? null;
  const progressPointValue = pointStore?.history_point ?? snapshotExtras.progressPoint ?? snapshot?.progress_point ?? null;
  const progressPointTotalValue =
    snapshot?.progress_point_total ?? snapshotExtras.progressPointTotal ?? (userGradeValue === 4 ? 5000 : null);
  const expirePointValue = pointStore?.expire_point ?? snapshotExtras.expirePoint;
  const expireTimeValue = pointStore?.expire_time ?? snapshotExtras.expireTime;
  const dingtoneIdValue = snapshotExtras.dtDingtoneId ?? snapshot?.dt_dingtone_id ?? null;
  const membershipLevelValue =
    snapshotExtras.membershipLevelLabel ||
    (userGradeValue === 4 ? 'V4白金' : null) ||
    (userGradeValue !== null ? `V${userGradeValue}` : null) ||
    snapshot?.membership_type ||
    null;
  const boundPhoneValue = snapshot?.phone?.trim() ? snapshot.phone : null;
  const pointStoreProductCount = pointStore?.products.length ?? snapshotExtras.membershipBenefits.length;
  const pointStoreProductTags = pointStore?.products.map((item) => ({
    key: item.product_id,
    name: item.name,
    price: item.price,
    stock: item.stock,
  })) ?? snapshotExtras.membershipBenefits.map((item) => ({
    key: item.code || item.name,
    name: item.name,
    price: item.price,
    stock: null as number | null,
  }));

  const fetchAccount = useCallback(async (options?: { force?: boolean }) => {
    const cacheKey = cacheKeys.account(accountId);
    const cached = !options?.force ? readCachedData<DtAccountDetail>(cacheKey) : null;
    if (cached) {
      setAccount(cached);
      setNickname(cached.nickname);
      setLoading(false);
      if (isCachedDataFresh(cacheKey, CACHE_TTL_MS.accountDetail)) {
        return;
      }
    } else {
      setLoading(true);
    }

    try {
      const data = await getAccount(accountId, { force: options?.force });
      setAccount(data);
      setNickname(data.nickname);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取账户详情失败');
    } finally {
      setLoading(false);
    }
  }, [accountId, message]);

  const fetchMessages = useCallback(
    async (page = 1, options?: { silent?: boolean; suppressError?: boolean; force?: boolean }) => {
      const requestId = ++messageRequestIdRef.current;
      const params = { page, pageSize: 10, exclude_system: true };
      const cacheKey = cacheKeys.accountMessages(accountId, params);
      const cached = !options?.force ? readCachedData<PagedData<Message>>(cacheKey) : null;

      if (cached) {
        setMessages(cached.list);
        setMsgTotal(cached.total);
        if (isCachedDataFresh(cacheKey, CACHE_TTL_MS.accountMessages)) {
          return;
        }
      } else if (!options?.silent) {
        setMsgLoading(true);
      }

      try {
        const data = await getAccountMessages(accountId, params, { force: options?.force });
        if (requestId !== messageRequestIdRef.current) {
          return;
        }
        setMessages(data.list);
        setMsgTotal(data.total);
      } catch (err) {
        if (requestId === messageRequestIdRef.current && !options?.suppressError) {
          message.error(err instanceof Error ? err.message : '鑾峰彇娑堟伅澶辫触');
        }
      } finally {
        if (requestId === messageRequestIdRef.current && !options?.silent) {
          setMsgLoading(false);
        }
      }
    },
    [accountId, message],
  );

  const fetchPointStore = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setPointStoreLoading(true);
    }
    try {
      const data = await getAccountPointStore(accountId);
      setPointStore(data);
      if (data.snapshot) {
        setAccount((current) => (current ? { ...current, snapshot: data.snapshot } : current));
      }
    } catch (err) {
      if (!options?.silent) {
        message.error(err instanceof Error ? err.message : '刷新积分商城失败');
      }
    } finally {
      if (!options?.silent) {
        setPointStoreLoading(false);
      }
    }
  }, [accountId, message]);

  const fetchFocusedMessage = useCallback(async () => {
    if (!focusedMessageId) {
      return;
    }
    try {
      const item = await getAccountMessage(accountId, focusedMessageId);
      if (item.msg_type === 'system') {
        return;
      }
      setMessages((current) => current.some((messageItem) => messageItem.id === item.id)
        ? current
        : [item, ...current].slice(0, 10));
    } catch (err) {
      message.warning(err instanceof Error ? err.message : '未找到所选消息');
    }
  }, [accountId, focusedMessageId, message]);

  const fetchTeamMessages = useCallback(
    async (page = 1, options?: { silent?: boolean; force?: boolean }) => {
      const requestId = ++teamMessageRequestIdRef.current;
      const params = { page, pageSize: 20, msg_type: 'system' as const };
      const cacheKey = cacheKeys.accountMessages(accountId, params);
      const cached = !options?.force ? readCachedData<PagedData<Message>>(cacheKey) : null;

      if (cached) {
        setTeamMessages(cached.list);
        setTeamMsgTotal(cached.total);
        setTeamMsgPage(cached.page);
        if (isCachedDataFresh(cacheKey, CACHE_TTL_MS.accountMessages)) {
          return;
        }
      } else if (!options?.silent) {
        setTeamMsgLoading(true);
      }

      try {
        const data = await getAccountMessages(accountId, params, { force: options?.force });
        if (requestId !== teamMessageRequestIdRef.current) {
          return;
        }
        setTeamMessages(data.list);
        setTeamMsgTotal(data.total);
        setTeamMsgPage(data.page);
      } catch (err) {
        if (requestId === teamMessageRequestIdRef.current && !options?.silent) {
          message.error(err instanceof Error ? err.message : '获取团队消息失败');
        }
      } finally {
        if (requestId === teamMessageRequestIdRef.current && !options?.silent) {
          setTeamMsgLoading(false);
        }
      }
    },
    [accountId, message],
  );

  useEffect(() => {
    const handleNewMessage = (event: Event) => {
      const detail = (event as CustomEvent<SSENewMessageEvent>).detail;
      if (detail?.accountId !== accountId) {
        return;
      }
      const receivedAt = detail.receivedAt || new Date().toISOString();
      const messageType = detail.msgType === 'verification' || detail.msgType === 'mms' || detail.msgType === 'system' ? detail.msgType : 'sms';
      const nextMessage: Message = {
        id: detail.id ?? -Date.now(),
        account_id: accountId,
        direction: 'incoming',
        msg_type: messageType,
        from_number: detail.from,
        to_number: detail.toNumber,
        content: detail.content,
        raw_info: null,
        raw_k3: null,
        k5_flag: null,
        is_read: messageType === 'system',
        telegram_sent: false,
        telegram_msg_id: null,
        received_at: receivedAt,
        created_at: receivedAt,
      };
      if (detail.msgType === 'system') {
        teamMessageRequestIdRef.current += 1;
        setTeamMsgLoading(false);
        setTeamMessages((current) => [nextMessage, ...current.filter((item) => item.id !== nextMessage.id)].slice(0, 100));
        setTeamMsgTotal((current) => current + 1);
        setAccount((current) => current ? {
          ...current,
          total_messages: current.total_messages + 1,
          today_messages: current.today_messages + 1,
        } : current);
        return;
      }
      messageRequestIdRef.current += 1;
      setMsgLoading(false);
      if (msgPage === 1) {
        setMessages((current) => [nextMessage, ...current.filter((item) => item.id !== nextMessage.id)].slice(0, 10));
      }
      setMsgTotal((current) => current + 1);
      setAccount((current) => current ? {
        ...current,
        total_messages: current.total_messages + 1,
        unread_messages: current.unread_messages + 1,
        today_messages: current.today_messages + 1,
      } : current);
    };

    window.addEventListener('dt:new-message', handleNewMessage);
    return () => window.removeEventListener('dt:new-message', handleNewMessage);
  }, [accountId, msgPage]);

  useEffect(() => {
    if (activeTab !== 'messages') {
      return;
    }

    let inFlight = false;
    const pollLocalMessages = async (silent = true) => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        await fetchMessages(msgPage, { silent, suppressError: silent, force: true });
        if (!silent) {
          await fetchFocusedMessage();
        }
        await fetchTeamMessages(teamMessageModalOpen ? teamMsgPage : 1, { silent: true, force: true });
      } finally {
        inFlight = false;
      }
    };

    void pollLocalMessages(false);
    const timer = window.setInterval(() => {
      void pollLocalMessages();
    }, LOCAL_MESSAGE_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeTab, fetchFocusedMessage, fetchMessages, fetchTeamMessages, msgPage, teamMessageModalOpen, teamMsgPage]);

  const syncLatestMessages = useCallback(async () => {
    setSyncingLatestMessages(true);
    try {
      const result = await refreshAccountMessages(accountId, 50, false);
      setLastRefreshDiagnostics(result.diagnostics ?? null);
      setMsgPage(1);
      await Promise.all([fetchMessages(1, { force: true }), fetchTeamMessages(1, { force: true }), fetchAccount({ force: true })]);
      if (result.background) {
        const diagnosticsSummary = buildRefreshDiagnosticsSummary(result.diagnostics);
        message.info(diagnosticsSummary ? `Background SMS refresh started\n${diagnosticsSummary}` : 'Background SMS refresh started; messages will appear after import');
        return;
      }
      if (result.imported > 0) {
        message.success(`已导入 ${result.imported} 条新消息`);
        return;
      }
      const diagnosticsSummary = buildRefreshDiagnosticsSummary(result.diagnostics);
      message.info(diagnosticsSummary ? `短信刷新完成\n${diagnosticsSummary}` : '短信刷新完成，暂无新短信');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '刷新短信失败');
    } finally {
      setSyncingLatestMessages(false);
    }
  }, [accountId, fetchAccount, fetchMessages, fetchTeamMessages, message]);

  const syncAppMessages = useCallback(async () => {
    setSyncingAppMessages(true);
    try {
      const result = await syncHelperMessages(accountId, 50);
      setLastRefreshDiagnostics([
        {
          source: 'app-helper-db',
          scanned: result.scanned ?? result.imported,
          imported: result.imported,
          sampleSender: result.messages?.[0]?.from_number ?? null,
          sampleContent: result.messages?.[0]?.content ?? null,
          sampleReceivedAt: result.messages?.[0]?.received_at ?? null,
        },
      ]);
      setMsgPage(1);
      await Promise.all([fetchMessages(1, { force: true }), fetchTeamMessages(1, { force: true }), fetchAccount({ force: true })]);
      message.success(result.imported > 0 ? `已从 app 同步 ${result.imported} 条消息` : 'app 消息同步完成，暂无新增');
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'app 消息同步失败');
    } finally {
      setSyncingAppMessages(false);
    }
  }, [accountId, fetchAccount, fetchMessages, fetchTeamMessages, message]);

  const refreshLocalMessages = useCallback(async () => {
    setRefreshingLocalMessages(true);
    try {
      await Promise.all([
        fetchMessages(msgPage, { force: true }),
        fetchTeamMessages(teamMessageModalOpen ? teamMsgPage : 1, { force: true }),
      ]);
    } finally {
      setRefreshingLocalMessages(false);
    }
  }, [fetchMessages, fetchTeamMessages, msgPage, teamMessageModalOpen, teamMsgPage]);

  const fetchPhones = useCallback(async (options?: { force?: boolean }) => {
    const cacheKey = cacheKeys.phoneNumbers(accountId);
    const cached = !options?.force ? readCachedData<PhoneNumber[]>(cacheKey) : null;
    if (cached) {
      setPhones(cached);
      setPhoneLoading(false);
      if (isCachedDataFresh(cacheKey, CACHE_TTL_MS.phoneNumbers)) {
        return;
      }
    } else {
      setPhoneLoading(true);
    }

    try {
      const data = await getPhoneNumbers(accountId, { force: options?.force });
      setPhones(data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Failed to load phone numbers');
    } finally {
      setPhoneLoading(false);
    }
  }, [accountId, message]);

  const fetchPhoneCountries = useCallback(async () => {
    if (phoneCountries.length > 0) {
      return phoneCountries;
    }
    try {
      const data = await getPhoneNumberCountries(accountId);
      setPhoneCountries(data);
      return data;
    } catch {
      setPhoneCountries([]);
      return [];
    }
  }, [accountId, phoneCountries]);

  const syncOwnedPhones = useCallback(async () => {
    setPhoneLoading(true);
    try {
      const data = await syncPhoneNumbers(accountId);
      setPhones(data.phone_numbers);
      await fetchAccount();
      message.success('已刷新已购手机号');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '刷新手机号失败');
    } finally {
      setPhoneLoading(false);
    }
  }, [accountId, fetchAccount, message]);

  const repairSmsReception = useCallback(async () => {
    setPhoneLoading(true);
    try {
      const result = await enablePhoneSmsReception(accountId);
      setPhones(result.phone_numbers);
      await fetchAccount();
      if (result.failed.length > 0) {
        message.warning(`已修复 ${result.repaired} 个号码，${result.failed.length} 个号码未确认成功`);
      } else if (result.repaired > 0) {
        message.success(`已开启 ${result.repaired} 个号码的短信接收`);
      } else {
        message.success('没有发现短信接收已关闭的号码');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '修复短信接收失败');
    } finally {
      setPhoneLoading(false);
    }
  }, [accountId, fetchAccount, message]);

  useEffect(() => {
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return;
    }
    fetchAccount();
    const pointStoreTimer = window.setTimeout(() => {
      void fetchPointStore({ silent: true });
    }, 800);
    return () => window.clearTimeout(pointStoreTimer);
  }, [accountId, fetchAccount, fetchPointStore]);

  useEffect(() => {
    setActiveTab(searchParams.get('tab') === 'messages' ? 'messages' : 'info');
  }, [accountId, searchParams]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    if (key === 'phone-numbers') {
      fetchPhones();
    }
  };

  const handleMonitorToggle = async () => {
    try {
      if (account?.monitor_enabled) {
        await stopMonitor(accountId);
      } else {
        await startMonitor(accountId);
      }
      await fetchAccount();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleRefresh = async () => {
    setRefreshingAccountData(true);
    try {
      await refreshAccount(accountId);
      setMsgPage(1);
      await Promise.all([fetchAccount(), fetchPhones(), fetchMessages(1), fetchPointStore({ silent: true })]);
      message.success('资料和本地消息已刷新');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setRefreshingAccountData(false);
    }
  };

  const handleReLogin = async () => {
    try {
      await reLogin(accountId);
      await Promise.all([fetchAccount(), fetchPhones()]);
      message.success('重新登录成功');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重新登录失败');
    }
  };

  const showSessionImportSuccess = (result: ValidateSessionResult, successMessage: string) => {
    const successCalls = result.validation?.calls.filter((item) => item.ok).map((item) => item.name) ?? [];
    message.success(successMessage);
    modal.success({
      title: result.validation ? '会话验证成功' : '会话已保存',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>主机：{result.validation?.host ?? '未完成直连探测'}</div>
          <div>设备：{result.dt_device_id}</div>
          <div>探测：{result.validation ? (successCalls.length > 0 ? successCalls.join(', ') : '基础握手成功') : '已跳过'}</div>
          {result.validation_error ? <div style={{ color: '#d48806' }}>验证提醒：{result.validation_error}</div> : null}
          {result.refresh_error ? <div style={{ color: '#cf1322' }}>刷新提醒：{result.refresh_error}</div> : null}
        </Space>
      ),
    });
  };

  const handleImportDirectSession = async () => {
    setDirectSessionImportOpen(true);
    await fetchPhoneCountries();
  };

  const handleSubmitDirectSession = async (values: DirectSessionImportValues) => {
    setDirectSessionImportLoading(true);
    try {
      const result = await validateSession(accountId, {
        dt_user_id: values.dtUserId,
        token: values.token,
        device_id: values.deviceId,
        device_id_candidates: values.deviceIdCandidates.length > 0 ? values.deviceIdCandidates : undefined,
        app_variant: account?.app_variant,
        phone_preview_country_code: values.phonePreviewCountryCode,
      });
      await Promise.all([fetchAccount({ force: true }), fetchPhones({ force: true })]);
      setDirectSessionImportOpen(false);
      showSessionImportSuccess(result, '直连会话已导入');
    } finally {
      setDirectSessionImportLoading(false);
    }
  };

  const handleCaptureHelperSession = () => {
    const isDingdong = account?.app_variant === 'dingdong';
    const appName = isDingdong ? '叮咚' : '说道';
    const packageName = isDingdong ? 'me.dingtone.app.im' : 'me.talkyou.app.im';
    modal.confirm({
      title: `模拟器测试导入（仅逆向/测试） - ${appName}`,
      content: (
        <Space direction="vertical">
          <div>将通过 helper/ADB 连接当前模拟器里的 {appName} App，并导出已登录会话接管到面板。</div>
          <div style={{ color: '#cf1322' }}>该入口不是正式部署依赖，仅用于逆向和测试环境。</div>
          <div style={{ color: '#666' }}>目标包名：{packageName}</div>
        </Space>
      ),
      okText: '确认测试导入',
      cancelText: '取消',
      onOk: async () => {
        const result = await captureSession(accountId);
        await Promise.all([fetchAccount(), fetchPhones()]);
        showSessionImportSuccess(result, `${appName} 已登录会话已接管`);
      },
    });
  };

  const handleSaveNickname = async () => {
    const nextNickname = nickname.trim().slice(0, 100);
    try {
      await updateAccount(accountId, { nickname: nextNickname || null });
      setEditNickname(false);
      await fetchAccount();
      message.success('备注已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '更新失败');
    }
  };

  const handleTelegramToggle = async (checked: boolean) => {
    try {
      await updateAccount(accountId, { telegram_notify: checked });
      await fetchAccount();
      message.success(checked ? '已开启 Telegram 通知' : '已关闭 Telegram 通知');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const showAccessCodeProbeResult = (result: AccessCodeProbeResult | AccessCodeProbeDryRunResult) => {
    if (isAccessCodeDryRun(result)) {
      modal.info({
        title: '验证码链路参数预览',
        width: 720,
        content: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="能力边界">{formatProbeCapability(result.capability)}</Descriptions.Item>
              <Descriptions.Item label="目标">{result.kind === 'phone' ? '手机号' : '邮箱'} / {result.target}</Descriptions.Item>
              <Descriptions.Item label="国家码">{result.kind === 'phone' ? result.countryCode : '-'}</Descriptions.Item>
              <Descriptions.Item label="recoverPassword">{result.recoverPassword.query}</Descriptions.Item>
              <Descriptions.Item label="verifyAccessCode">{result.verifyAccessCode?.query ?? '未填写验证码，跳过'}</Descriptions.Item>
            </Descriptions>
            <div style={{ color: '#666' }}>
              此追踪只验证 recoverPassword / verifyAccessCode 链路，不代表首次登录 token 已完成。
            </div>
            <Card size="small" title="recoverPassword params">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result.recoverPassword.params, null, 2)}</pre>
            </Card>
            {result.verifyAccessCode ? (
              <Card size="small" title="verifyAccessCode params">
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(result.verifyAccessCode.params, null, 2)}</pre>
              </Card>
            ) : null}
          </Space>
        ),
      });
      return;
    }

    modal.info({
      title: '验证码链路追踪结果',
      width: 720,
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="能力边界">{formatProbeCapability(result.capability)}</Descriptions.Item>
            <Descriptions.Item label="目标">{result.kind === 'phone' ? '手机号' : '邮箱'} / {result.target}</Descriptions.Item>
            <Descriptions.Item label="直连主机">{result.host}</Descriptions.Item>
            <Descriptions.Item label="recoverPassword">{formatProbeCall(result.recover_password)}</Descriptions.Item>
            <Descriptions.Item label="verifyAccessCode">{formatProbeCall(result.verify_access_code)}</Descriptions.Item>
            <Descriptions.Item label="帧数量">{result.trace.length}</Descriptions.Item>
          </Descriptions>
          <div style={{ color: '#666' }}>
            此追踪只验证 recoverPassword / verifyAccessCode 链路，不代表首次登录 token 已完成。
          </div>
          <Card size="small" title="recoverPassword payload">
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{formatProbePayload(result.recover_password)}</pre>
          </Card>
          {result.verify_access_code ? (
            <Card size="small" title="verifyAccessCode payload">
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{formatProbePayload(result.verify_access_code)}</pre>
            </Card>
          ) : null}
        </Space>
      ),
    });
  };

  const handleProbeAccessCode = () => {
    const defaultKind = account?.login_type === 'email_code' || account?.login_type === 'email_password' ? 'email' : 'phone';
    const defaultTarget = defaultKind === 'email' ? account?.email ?? '' : account?.phone ?? '';
    let probeFormValues: AccessCodeProbeFormValues = {
      kind: defaultKind,
      target: defaultTarget,
      countryCode: defaultKind === 'phone' ? inferAccessCodeCountryCode(defaultTarget) : 1,
      accessCode: '',
      dryRun: true,
    };

    modal.confirm({
      title: '追踪验证码登录链路',
      width: 560,
      okText: '开始追踪',
      cancelText: '取消',
      content: (
        <AccessCodeProbeFormContent
          initialValues={probeFormValues}
          accountEmail={account?.email}
          accountPhone={account?.phone}
          onChange={(values) => {
            probeFormValues = values;
          }}
        />
      ),
      onOk: async () => {
        const targetError = validateAccessCodeProbeTarget(probeFormValues.kind, probeFormValues.target);
        if (targetError) {
          message.warning(targetError);
          return Promise.reject(new Error(targetError));
        }
        if (!probeFormValues.dryRun && !account?.dt_user_id) {
          message.warning('真实请求需要先导入可用的直连会话；请保持 dry-run 只预览参数。');
          return Promise.reject(new Error('Missing direct session for real request.'));
        }
        const result = await probeAccessCode(accountId, {
          kind: probeFormValues.kind,
          target: probeFormValues.target.trim() || undefined,
          country_code: probeFormValues.kind === 'phone' ? probeFormValues.countryCode : undefined,
          access_code: probeFormValues.accessCode.trim() || undefined,
          dry_run: probeFormValues.dryRun,
          confirm: !probeFormValues.dryRun,
        });
        showAccessCodeProbeResult(result);
      },
    });
  };

  const handleMarkAllRead = async () => {
    try {
      await readAllMessages(accountId);
      setMessages((items) => items.map((item) => ({ ...item, is_read: true })));
      setAccount((current) => current ? { ...current, unread_messages: 0 } : current);
      notifyMessageReadStateChanged();
      message.success('已全部标记为已读');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDeleteMsg = async (msgId: number) => {
    try {
      await deleteMessage(accountId, msgId);
      await Promise.all([fetchMessages(msgPage), fetchAccount()]);
      message.success('消息已删除');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const copyText = async (text: string, successText: string) => {
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      message.success(successText);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (ok) {
        message.success(successText);
      } else {
        message.error('复制失败，请手动复制');
      }
    }
  };

  const handleRequestNumber = async () => {
    const countries = await fetchPhoneCountries();
    let selectedCountry = countries[0];
    let selectedAreaCode: number | undefined;

    if (!selectedCountry) {
      modal.warning({
        title: '国家列表未加载',
        content: '当前账户还没有拿到 app 返回的可选号国家列表，请先刷新账户或稍后重试。',
      });
      return;
    }

    modal.confirm({
      title: '获取新号码',
      width: 480,
      okText: '拉取候选号',
      cancelText: '取消',
      content: (
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ color: '#666' }}>先选择国家或地区，再拉取可购买候选号与价格。</div>
          <Select
            defaultValue={selectedCountry.country_key}
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
            options={countries.map((item) => ({
              label: item.label,
              value: item.country_key,
            }))}
            onChange={(value) => {
              selectedCountry = countries.find((item) => item.country_key === value) ?? selectedCountry;
            }}
          />
          <InputNumber
            min={0}
            precision={0}
            style={{ width: '100%' }}
            placeholder="区号（留空自动随机，美国会自动尝试 213、646 等）"
            onChange={(value) => {
              selectedAreaCode = typeof value === 'number' && value > 0 ? value : undefined;
            }}
          />
        </Space>
      ),
      onOk: async () => {
        const previewResponse = await previewPhoneNumbers(accountId, {
          country_code: selectedCountry.country_code,
          iso_country_code: selectedCountry.iso_country_code,
          country_key: selectedCountry.country_key,
          area_code: selectedAreaCode,
        });
        const preview = normalizePreview(previewResponse);
        if (preview.candidates.length === 0) {
          modal.info({
            title: '暂无候选号',
            content: '当前地区没有返回可购买号码，请稍后重试或切换地区。',
          });
          return;
        }

        let selectedCandidate: PhonePurchaseCandidate | null = preview.candidates[0] ?? null;
        modal.confirm({
          title: '确认购买号码',
          width: 720,
          okText: '确认支付并获取',
          cancelText: '取消',
          content: (
            <PurchaseCandidatePicker
              preview={preview}
              onChange={(candidate) => {
                selectedCandidate = candidate;
              }}
            />
          ),
          onOk: async () => {
            if (!selectedCandidate) {
              throw new Error('请选择一个号码');
            }
            const result = await purchasePhoneNumber(accountId, {
              country_code: selectedCountry.country_code,
              iso_country_code: selectedCountry.iso_country_code,
              country_key: selectedCountry.country_key,
              candidate: selectedCandidate,
              confirm: true,
            });
            await Promise.all([fetchAccount(), fetchPhones()]);
            message.success(`已成功获取号码 ${formatPhoneWithCountryCode(result.phone.phone_number, result.phone.country_code)}${formatPhoneVerificationSuffix(result.verification)}`);
          },
        });
      },
    });
  };

  const phoneAction = async (phoneId: number, action: 'renew' | 'cancel' | 'pause' | 'resume') => {
    try {
      let result: PhoneActionResult | null = null;
      if (action === 'renew') {
        result = await renewPhoneNumber(accountId, phoneId);
      }
      if (action === 'cancel') {
        result = await cancelPhoneNumber(accountId, phoneId);
      }
      if (action === 'pause') {
        result = await pausePhoneNumber(accountId, phoneId);
      }
      if (action === 'resume') {
        result = await resumePhoneNumber(accountId, phoneId);
      }
      await Promise.all([fetchPhones(), fetchAccount()]);
      const actionText = phoneActionLabel(action);
      message.success(`${actionText}成功${formatPhoneVerificationSuffix(result?.verification)}`);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleDeletePhone = async (phoneId: number) => {
    try {
      await deletePhoneNumber(accountId, phoneId);
      await Promise.all([fetchPhones(), fetchAccount()]);
      message.success('号码已删除');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleEditPhoneLabel = (phone: PhoneNumber) => {
    let nextLabel = phone.display_name || '';
    modal.confirm({
      title: `修改备注 - ${phone.phone_number}`,
      okText: '保存备注',
      cancelText: '取消',
      content: (
        <Input
          defaultValue={nextLabel}
          maxLength={100}
          placeholder="输入备注，留空则清空"
          onChange={(event) => {
            nextLabel = event.target.value;
          }}
        />
      ),
      onOk: async () => {
        await updatePhoneNumberLabel(accountId, phone.id, { display_name: nextLabel.trim() });
        await syncOwnedPhones();
        message.success('备注已更新并同步到 app');
      },
    });
  };

  const openTeamMessageHistory = () => {
    setTeamMessageModalOpen(true);
    void fetchTeamMessages(1, { force: true });
  };

  const teamMsgColumns: ColumnsType<Message> = [
    {
      title: '发送方',
      dataIndex: 'from_number',
      width: 140,
      render: (value) => value || (account?.app_variant === 'dingdong' ? '叮咚团队' : '说道团队'),
    },
    {
      title: '消息内容',
      dataIndex: 'content',
      render: (value: string) => <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value}</div>,
    },
    {
      title: '接收时间',
      dataIndex: 'received_at',
      width: 180,
      render: (value) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '-'),
    },
  ];

  const msgColumns: ColumnsType<Message> = [
    { title: '类型', dataIndex: 'msg_type', width: 100, render: (value) => <Tag>{value}</Tag> },
    { title: '来源', dataIndex: 'from_number', width: 140, render: (value) => value || '-' },
    { title: '目标', dataIndex: 'to_number', width: 140, render: (value) => value || '-' },
    {
      title: '内容',
      dataIndex: 'content',
      ellipsis: true,
      render: (value: string, record) => {
        const code = isVerificationMessage(record) ? extractVerificationCodeFromContent(value) : null;
        return (
          <Space size={8} style={{ maxWidth: '100%' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
            {code ? (
              <Tooltip title={`复制验证码 ${code}`}>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => copyText(code, `验证码 ${code} 已复制`)}
                >
                  复制验证码
                </Button>
              </Tooltip>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '时间',
      dataIndex: 'received_at',
      width: 170,
      render: (value) => (value ? dayjs(value).format('MM-DD HH:mm:ss') : '-'),
    },
    {
      title: '状态',
      dataIndex: 'is_read',
      width: 90,
      render: (value) => (value ? <Tag>已读</Tag> : <Tag color="red">未读</Tag>),
    },
    {
      title: '操作',
      width: 90,
      render: (_, record) => (
        <Popconfirm title="确认删除这条消息？" onConfirm={() => handleDeleteMsg(record.id)}>
          <Button size="small" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const phoneColumns: ColumnsType<PhoneNumber> = [
    {
      title: '号码',
      dataIndex: 'phone_number',
      width: 190,
      render: (value, record) => {
        const displayPhone = formatPhoneWithCountryCode(value, record.country_code);
        const copyPhone = formatPhoneForClipboard(value, record.country_code);
        return (
          <Space direction="vertical" size={2}>
            <Tooltip title={`点击复制 ${copyPhone || displayPhone}`}>
              <Tag
                color="green"
                onClick={() => copyText(copyPhone || displayPhone, `号码 ${copyPhone || displayPhone} 已复制`)}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                {displayPhone}
              </Tag>
            </Tooltip>
            {record.allow_receive_sms === false && <Tag color="red">短信接收关闭</Tag>}
            {record.allow_receive_sms === true && <Tag color="success">短信接收开启</Tag>}
          </Space>
        );
      },
    },
    {
      title: '地区',
      dataIndex: 'display_name',
      width: 180,
      render: (_, record) => getPhoneRegion(record),
    },
    {
      title: '备注',
      dataIndex: 'display_name',
      width: 220,
      render: (_, record) => {
        const remark = getPhoneRemarkDisplay(record);
        return (
          <Tooltip title={remark === '-' ? undefined : remark}>
            <div
              style={{
                maxWidth: 220,
                maxHeight: 64,
                overflowY: 'auto',
                whiteSpace: 'normal',
                overflowWrap: 'anywhere',
                lineHeight: 1.35,
              }}
            >
              {remark}
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: '国家/区号',
      dataIndex: 'country_code',
      width: 120,
      render: (value) => (value ? `${getCountryDisplayName(value)} / +${value}` : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status) => {
        const statusMap: Record<string, { color: string; label: string }> = {
          active: { color: 'green', label: '使用中' },
          paused: { color: 'orange', label: '已暂停' },
          expired: { color: 'red', label: '已过期' },
          cancelled: { color: 'default', label: '已取消' },
          pending: { color: 'blue', label: '处理中' },
        };
        const item = statusMap[status] || { color: 'default', label: status };
        return <Tag color={item.color}>{item.label}</Tag>;
      },
    },
    {
      title: '有效期',
      dataIndex: 'valid_period_days',
      width: 90,
      render: (value) => (value != null ? `${value} 天` : '-'),
    },
    {
      title: '收费',
      dataIndex: 'raw_json',
      width: 150,
      render: (_, record) => getStoredPhoneCost(record),
    },
    {
      title: '到期时间',
      dataIndex: 'expired_time',
      width: 170,
      render: (value) => formatEpochTime(value),
    },
    {
      title: '购买日期',
      dataIndex: 'gain_time',
      width: 170,
      render: (value) => formatEpochTime(value),
    },
    {
      title: '自动续费',
      dataIndex: 'auto_renew',
      width: 100,
      render: (value) => (value ? <Tag color="green">是</Tag> : <Tag>否</Tag>),
    },
    {
      title: '靓号',
      dataIndex: 'is_good_number',
      width: 80,
      render: (value) => (value ? '是' : '否'),
    },
    {
      title: '操作',
      width: 360,
      render: (_, record) => {
        const status = record.status as PhoneStatus;
        return (
          <Space size="small" wrap>
            <Button size="small" onClick={() => handleEditPhoneLabel(record)}>
              备注
            </Button>
            {(status === 'active' || status === 'expired') && (
              <Popconfirm title="确认续费这个号码？续费会扣除账户余额。" onConfirm={() => phoneAction(record.id, 'renew')}>
                <Button size="small" type="primary">
                  续费
                </Button>
              </Popconfirm>
            )}
            {status === 'active' && (
              <Popconfirm title="确认暂停这个号码？暂停后号码将暂时不可用。" onConfirm={() => phoneAction(record.id, 'pause')}>
                <Button size="small">
                  暂停
                </Button>
              </Popconfirm>
            )}
            {status === 'paused' && (
              <Popconfirm title="确认恢复这个号码？" onConfirm={() => phoneAction(record.id, 'resume')}>
                <Button size="small">
                  恢复
                </Button>
              </Popconfirm>
            )}
            {(status === 'active' || status === 'paused') && (
              <Popconfirm title="确认取消这个号码？" onConfirm={() => phoneAction(record.id, 'cancel')}>
                <Button size="small" danger>
                  取消
                </Button>
              </Popconfirm>
            )}
            {(status === 'cancelled' || status === 'expired') && (
              <Popconfirm title="确认删除这个号码？删除后不可恢复。" onConfirm={() => handleDeletePhone(record.id)}>
                <Button size="small" danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

  const accountStatusMap: Record<string, { color: string; label: string }> = {
    pending: { color: 'processing', label: '待验证' },
    online: { color: 'green', label: '在线' },
    offline: { color: 'default', label: '离线' },
    error: { color: 'red', label: '异常' },
    expired: { color: 'orange', label: '已过期' },
  };
  const accountStatus = accountStatusMap[account?.status ?? 'offline'] || accountStatusMap.offline;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/accounts')}>
          返回
        </Button>
        {editNickname ? (
          <Space>
            <Input
              value={nickname}
              maxLength={100}
              showCount
              onChange={(e) => setNickname(e.target.value)}
              style={{ width: 280 }}
            />
            <Button size="small" type="primary" onClick={handleSaveNickname}>
              保存
            </Button>
            <Button size="small" onClick={() => setEditNickname(false)}>
              取消
            </Button>
          </Space>
        ) : (
          <h2 style={{ margin: 0, cursor: 'pointer' }} onClick={() => setEditNickname(true)}>
            {account?.nickname || '加载中...'}
          </h2>
        )}
        <Tag color={accountStatus.color}>{accountStatus.label}</Tag>
        <Tag color={account?.app_variant === 'dingdong' ? 'blue' : 'gold'}>
          {account?.app_variant === 'dingdong' ? '叮咚' : '说道'}
        </Tag>
        <Space style={{ marginLeft: 'auto' }}>
          <Button onClick={handleImportDirectSession}>导入会话</Button>
          <Button onClick={handleCaptureHelperSession}>模拟器测试导入（仅逆向/测试）</Button>
          <Button
            type={account?.monitor_enabled ? 'default' : 'primary'}
            icon={account?.monitor_enabled ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
            disabled={account?.status === 'pending'}
            onClick={handleMonitorToggle}
          >
            {account?.monitor_enabled ? '停止监听' : '启动监听'}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            loading={refreshingAccountData}
            onClick={handleRefresh}
            disabled={account?.status === 'pending'}
          >
            刷新数据
          </Button>
          <Button
            onClick={handleReLogin}
            disabled={
              account?.status === 'pending' ||
              account?.login_type === 'email_code' ||
              account?.login_type === 'phone_code' ||
              account?.login_type === 'manual_session'
            }
          >
            重新登录
          </Button>
        </Space>
      </div>

      {account?.last_error && (
        <Card size="small" style={{ marginBottom: 16, background: '#fff2f0', borderColor: '#ffccc7' }}>
          <span style={{ color: '#cf1322' }}>最近错误：{account.last_error}</span>
        </Card>
      )}

      {account?.latest_monitor?.route_address ? (
        <Card size="small" title="监听诊断" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size={4}>
            <Space wrap>
              <Tag color={account.latest_monitor.status === 'running' ? 'green' : 'default'}>
                {account.latest_monitor.status === 'running' ? '监听中' : account.latest_monitor.status}
              </Tag>
              <span>心跳 {account.latest_monitor.heartbeat_count}</span>
              <span>入库 {account.latest_monitor.msg_received_count}</span>
              <span>启动 {dayjs(account.latest_monitor.started_at).format('HH:mm:ss')}</span>
            </Space>
            <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>
              {account.latest_monitor.route_address}
            </div>
          </Space>
        </Card>
      ) : null}

      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'info',
            label: '基本信息',
            children: (
              <div>
                <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
                  <Col xs={12} sm={6}>
                    <Card size="small" loading={loading}>
                      <Statistic title="说道币余额" value={formatNumber(balanceValue, 2)} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" loading={loading}>
                      <Statistic title="会员等级" value={membershipLevelValue || '未同步'} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" loading={loading}>
                      <Statistic title="可兑换积分" value={formatNumber(validPointValue, 2)} />
                    </Card>
                  </Col>
                  <Col xs={12} sm={6}>
                    <Card size="small" loading={loading}>
                      <Statistic
                        title="升级进度"
                        value={
                          progressPointValue !== null
                            ? `${formatNumber(progressPointValue, 1)} / ${formatNumber(progressPointTotalValue, 1, '-')}`
                            : '未同步'
                        }
                      />
                    </Card>
                  </Col>
                </Row>

                <Descriptions bordered column={2} size="small">
                <Descriptions.Item label={account?.app_variant === 'dingdong' ? '叮咚号' : '说道号'}>{dingtoneIdValue || '未获取到'}</Descriptions.Item>
                  <Descriptions.Item label="用户 ID">{account?.dt_user_id || '-'}</Descriptions.Item>
                  <Descriptions.Item label="应用类型">
                    {account?.app_variant === 'dingdong' ? '叮咚 Dingdong' : '说道 Dingtone / TalkU'}
                  </Descriptions.Item>
                  <Descriptions.Item label="登录方式">
                    {(account?.login_type && loginTypeLabelMap[account.login_type]) || account?.login_type || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="显示名称">{snapshot?.full_name || '-'}</Descriptions.Item>
                  <Descriptions.Item label="用户等级">{userGradeValue ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="邮箱">{snapshot?.email || account?.email || '-'}</Descriptions.Item>
                  <Descriptions.Item label="绑定手机号">
                    {boundPhoneValue ? boundPhoneValue : <Tag>未绑定</Tag>}
                  </Descriptions.Item>
                  <Descriptions.Item label="生日">{snapshot?.birthday || '-'}</Descriptions.Item>
                  <Descriptions.Item label="会员类型">{snapshot?.membership_type || snapshotExtras.membershipType || '-'}</Descriptions.Item>
                  <Descriptions.Item label="国家">{snapshot?.country || '-'}</Descriptions.Item>
                  <Descriptions.Item label="省/州">{snapshot?.state || '-'}</Descriptions.Item>
                  <Descriptions.Item label="城市">{snapshot?.city || '-'}</Descriptions.Item>
                  <Descriptions.Item label="关于我">{snapshot?.about_me || '-'}</Descriptions.Item>
                  <Descriptions.Item label="心情">{snapshot?.feeling || '-'}</Descriptions.Item>
                  <Descriptions.Item label="资料版本">{snapshot?.profile_ver_code || '-'}</Descriptions.Item>
                  <Descriptions.Item label="设备 ID">{account?.dt_device_id || '-'}</Descriptions.Item>
                </Descriptions>

                <Card size="small" title="验证码登录追踪" style={{ marginTop: 16 }}>
                  <Space direction="vertical">
                    <div style={{ color: '#666' }}>
                      默认只预览 recoverPassword / verifyAccessCode 参数；真实请求需要先导入直连会话。
                    </div>
                    <Button onClick={handleProbeAccessCode}>
                      追踪验证码链路
                    </Button>
                  </Space>
                </Card>

                <Card
                  size="small"
                  title="积分商城"
                  loading={pointStoreLoading}
                  extra={(
                    <Space>
                      <Button size="small" onClick={() => navigate(`/accounts/${accountId}/point-store`)}>进入商城</Button>
                      <Button size="small" icon={<ReloadOutlined />} onClick={() => fetchPointStore()} loading={pointStoreLoading}>刷新</Button>
                    </Space>
                  )}
                  style={{ marginTop: 16 }}
                >
                  <Descriptions bordered column={2} size="small">
                    <Descriptions.Item label="当前等级">{membershipLevelValue || '-'}</Descriptions.Item>
                    <Descriptions.Item label="会员到期">
                      {snapshot?.membership_expire_at ? dayjs(snapshot.membership_expire_at).format('YYYY-MM-DD HH:mm') : '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="积分权益">{snapshotExtras.walletPrivilege || '暂未解析'}</Descriptions.Item>
                    <Descriptions.Item label="商城项目数">{pointStoreProductCount || 0}</Descriptions.Item>
                    <Descriptions.Item label="年底过期积分">
                      {expirePointValue !== null
                        ? `${formatNumber(expirePointValue, 0, '0')} 积分${expireTimeValue ? ` / ${expireTimeValue}` : ''}`
                        : '未同步'}
                    </Descriptions.Item>
                  </Descriptions>
                  {pointStoreProductTags.length > 0 ? (
                    <Space wrap style={{ marginTop: 12 }}>
                      {pointStoreProductTags.map((item) => (
                        <Tag key={`${item.key}-${item.name}`} color="blue">
                          {item.name}
                          {item.price !== null ? ` / ${formatPointPriceZh(item.price)}` : ''}
                          {item.stock !== null ? ` / 库存 ${item.stock}` : ''}
                        </Tag>
                      ))}
                    </Space>
                  ) : (
                    <div style={{ marginTop: 12, color: '#999' }}>暂未解析到积分商城项目。</div>
                  )}
                </Card>

                <Card size="small" title="通知设置" style={{ marginTop: 16 }}>
                  <Space>
                    <span>Telegram 通知：</span>
                    <Switch checked={account?.telegram_notify ?? false} onChange={handleTelegramToggle} />
                  </Space>
                </Card>
              </div>
            ),
          },
          {
            key: 'messages',
            label: `消息（总计 ${account?.total_messages ?? 0} / 未读 ${account?.unread_messages ?? 0}）`,
            children: (
              <div>
                <div style={{ marginBottom: 12 }}>
                  <Space>
                    <Button onClick={handleMarkAllRead}>全部已读</Button>
                    <Tooltip title="先尝试 direct 收取；如果没有新短信，会继续扫描已连接的 app/helper/ADB 作为兜底。">
                      <Button type="primary" loading={syncingLatestMessages} onClick={syncLatestMessages}>
                        收取新短信
                      </Button>
                    </Tooltip>
                    <Tooltip title="从已连接的 app/helper 数据库导入历史短信，需要模拟器和 app。">
                      <Button loading={syncingAppMessages} onClick={syncAppMessages}>
                        从 app 导入历史
                      </Button>
                    </Tooltip>
                    <Tooltip title="只刷新本地数据库列表，不主动联网收短信。">
                      <Button icon={<ReloadOutlined />} loading={refreshingLocalMessages} onClick={refreshLocalMessages}>
                        刷新本地列表
                      </Button>
                    </Tooltip>
                  </Space>
                </div>
                {lastRefreshDiagnostics && lastRefreshDiagnostics.length > 0 ? (
                  <Card size="small" title="最近一次刷新诊断" style={{ marginBottom: 12 }}>
                    <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>
                      {buildRefreshDiagnosticsSummary(lastRefreshDiagnostics)}
                    </div>
                  </Card>
                ) : null}
                {teamMsgTotal > 0 ? (
                  <Card
                    size="small"
                    hoverable
                    role="button"
                    tabIndex={0}
                    style={{ marginBottom: 12, cursor: 'pointer' }}
                    loading={teamMsgLoading}
                    onClick={openTeamMessageHistory}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openTeamMessageHistory();
                      }
                    }}
                  >
                    <Space>
                      <Tag color="default">系统</Tag>
                      <strong>{account?.app_variant === 'dingdong' ? '叮咚团队' : '说道团队'}</strong>
                      <span style={{ color: '#666' }}>共 {teamMsgTotal} 条，点击查看历史</span>
                    </Space>
                    <div style={{ marginTop: 8, color: '#666' }}>{teamMessages[0]?.content}</div>
                  </Card>
                ) : null}
                <Table
                  columns={msgColumns}
                  dataSource={messages}
                  rowKey="id"
                  loading={msgLoading}
                  size="small"
                  pagination={{
                    current: msgPage,
                    total: msgTotal,
                    pageSize: 10,
                    onChange: (page) => {
                      setMsgPage(page);
                    },
                  }}
                  rowClassName={(record) => record.id === focusedMessageId ? 'message-row-focused' : ''}
                  scroll={{ x: 860 }}
                />
              </div>
            ),
          },
          {
            key: 'phone-numbers',
            label: `手机号（${Math.max(phones.length, account?.phone_number_count ?? 0)}）`,
            children: (
              <div>
                <div style={{ marginBottom: 12 }}>
                  <Space>
                    <Button icon={<ReloadOutlined />} onClick={syncOwnedPhones}>
                      刷新已购号码
                    </Button>
                    <Popconfirm
                      title="确认修复当前账户中短信接收已关闭的号码？"
                      description="只会修改服务端明确标记为关闭的号码，并保留号码现有设置。"
                      onConfirm={repairSmsReception}
                    >
                      <Button icon={<SafetyCertificateOutlined />}>修复短信接收</Button>
                    </Popconfirm>
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleRequestNumber}>
                      获取新号码
                    </Button>
                  </Space>
                </div>
                {!phoneLoading && phones.length === 0 && (
                  <Card size="small" style={{ marginBottom: 12 }}>
                    当前还没有同步到已购号码记录。可以点“刷新已购号码”或“获取新号码”。
                  </Card>
                )}
                <Table
                  columns={phoneColumns}
                  dataSource={phones}
                  rowKey="id"
                  loading={phoneLoading}
                  size="small"
                  scroll={{ x: 1460 }}
                  pagination={false}
                />
              </div>
            ),
          },
        ]}
      />
      <DirectSessionImportModal
        open={directSessionImportOpen}
        appVariant={account?.app_variant ?? 'dingtone'}
        initialDtUserId={account?.dt_user_id ?? ''}
        initialDeviceId={account?.dt_device_id ?? ''}
        countries={phoneCountries}
        loading={directSessionImportLoading}
        onCancel={() => setDirectSessionImportOpen(false)}
        onSubmit={handleSubmitDirectSession}
      />
      <Modal
        title={`${account?.app_variant === 'dingdong' ? '叮咚团队' : '说道团队'}消息历史`}
        open={teamMessageModalOpen}
        onCancel={() => setTeamMessageModalOpen(false)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        <Table
          columns={teamMsgColumns}
          dataSource={teamMessages}
          rowKey="id"
          loading={teamMsgLoading}
          size="small"
          tableLayout="fixed"
          pagination={{
            current: teamMsgPage,
            total: teamMsgTotal,
            pageSize: 20,
            showTotal: (total) => `共 ${total} 条`,
            onChange: (page) => {
              void fetchTeamMessages(page, { force: true });
            },
          }}
        />
      </Modal>
    </div>
  );
}
