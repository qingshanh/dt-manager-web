import { AccountStatus, AppVariant, LoginType, MessageDirection, MessageType, PhoneStatus, Prisma, type PhoneNumber as StoredPhoneNumber } from "@prisma/client";
import { Router } from "express";
import { MonitorStatus } from "@prisma/client";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../lib/prisma.js";
import { accountMonitorService } from "../services/account-monitor.js";
import {
  buildDirectAccessCodeDryRun,
  DirectDingtoneGateway,
  listenDirectSessionPushes,
  runDirectAccessCodeProbe,
  runDirectSessionProbe,
  type DirectAccessCodeProbeResult,
  type DirectProbeResult,
  type DirectProbePushResult
} from "../services/dingtone/direct-gateway.js";
import { dingtoneGateway } from "../services/dingtone/index.js";
import { RealDingtoneGateway } from "../services/dingtone/real-gateway.js";
import { dumpHelperSmsMessages, executeHelperAction, executeHelperActionWithRetry, getCachedPrivateNumberEvent } from "../services/helper-bridge.js";
import { refreshAccountRuntimeData } from "../services/account-runtime.js";
import { getAccountPoint } from "../services/point.js";
import { getAccountPointStore, orderAccountPointStoreProduct } from "../services/point-store.js";
import { dumpSmsMessagesFromAdb, listPhoneNumbersFromAdb } from "../services/adb-database.js";
import { exportSessionFromAdbConfig } from "../services/adb-session.js";
import { previewPhoneNumbersFromAdb } from "../services/adb-phone-preview.js";
import { dumpSmsMessagesFromUi, openMessagesInbox } from "../services/adb-message-ui.js";
import { dumpSmsMessagesFromNotifications } from "../services/adb-notification-ui.js";
import { storeHelperSmsMessages, storeParsedSmsPushes, type HelperSmsMessageRecord } from "../services/message-runtime.js";
import type {
  DingtoneGateway,
  DingtoneLoginResult,
  DingtonePhoneNumber,
  DingtonePhonePurchaseCandidate,
  DingtonePhonePurchasePreview,
  DingtoneSessionExport,
  DingtoneSnapshot,
  VerificationRequestResult
} from "../services/dingtone/types.js";
import { eventBus } from "../services/event-bus.js";
import { getGatewayMode, getSettingsMap } from "../services/settings.service.js";
import { logger } from "../utils/logger.js";
import { sendPhoneTelegramNotification, sendSmsTelegramNotification } from "../services/telegram-notifier.js";
import { AppError, assertFound } from "../utils/errors.js";
import { createDeviceId, createTrackCode, decryptText, encryptText } from "../utils/crypto.js";
import { ok, paged } from "../utils/response.js";
import { serializeMessage, serializePhoneNumber, serializeSnapshot } from "../utils/serializers.js";

const createAccountSchema = z
  .object({
    nickname: z.string().trim().max(100).optional(),
    app_variant: z.enum(["dingtone", "dingdong"]).optional().default("dingtone"),
    login_type: z.enum(["email_code", "phone_code", "email_password", "phone_password", "manual_session"]),
    email: z.string().email().optional(),
    phone: z.string().min(5).optional(),
    password: z.string().min(1).optional(),
    telegram_notify: z.boolean().optional().default(false),
    proxy_enabled: z.boolean().optional().default(false)
  })
  .superRefine((value, ctx) => {
    if ((value.login_type === "email_code" || value.login_type === "email_password") && !value.email) {
      ctx.addIssue({ code: "custom", message: "email is required for email login", path: ["email"] });
    }
    if ((value.login_type === "phone_code" || value.login_type === "phone_password") && !value.phone) {
      ctx.addIssue({ code: "custom", message: "phone is required for phone login", path: ["phone"] });
    }
    if ((value.login_type === "email_password" || value.login_type === "phone_password") && !value.password) {
      ctx.addIssue({ code: "custom", message: "password is required for password login", path: ["password"] });
    }
  });

const updateAccountSchema = z.object({
  nickname: z.string().trim().max(100).optional().nullable(),
  password: z.string().min(1).optional(),
  telegram_notify: z.boolean().optional(),
  proxy_enabled: z.boolean().optional()
});

const verifyCodeSchema = z.object({
  code: z.string().min(1)
});

const accessCodeProbeSchema = z.object({
  kind: z.enum(["email", "phone"]).optional(),
  target: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).optional()
  ),
  country_code: z.number().int().positive().optional(),
  access_code: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().optional()
  ),
  no_code: z.number().int().nonnegative().optional(),
  dry_run: z.boolean().optional().default(true),
  confirm: z.boolean().optional().default(false)
});

const phoneActionConfirmSchema = z.object({
  confirm: z.boolean().optional().default(false)
});

const pointStoreOrderSchema = z.object({
  product_id: z.string().trim().min(1),
  confirm: z.boolean().optional().default(false)
});

const validateSessionSchema = z.object({
  dt_user_id: z.string().trim().min(1).optional(),
  token: z.string().trim().min(1).optional(),
  device_id: z.string().trim().min(1).optional(),
  device_id_candidates: z.array(z.string().trim().min(1)).max(8).optional(),
  app_variant: z.enum(["dingtone", "dingdong"]).optional(),
  package_name: z.string().trim().min(1).optional(),
  phone_preview_country_code: z.number().int().positive().optional()
});

const requestPhoneSchema = z.object({
  country_code: z.number().int().positive().optional(),
  iso_country_code: z.string().trim().optional(),
  country_key: z.string().trim().optional(),
  area_code: z.number().int().nonnegative().optional()
});

const optionalNullableString = () => z.preprocess((value) => (value === null ? undefined : value), z.string().trim().optional());
const optionalNullableNonNegativeInt = () =>
  z.preprocess((value) => (value === null ? undefined : value), z.number().int().nonnegative().optional());
const optionalNullableInt = () =>
  z.preprocess((value) => (value === null ? undefined : value), z.number().int().optional());
const optionalNullablePositiveInt = () =>
  z.preprocess((value) => (value === null ? undefined : value), z.number().int().positive().optional());
const optionalNullableNonNegativeNumber = () =>
  z.preprocess((value) => (value === null ? undefined : value), z.number().nonnegative().optional());

const purchasePhoneCandidateSchema = z.object({
  phone_number: z.string().min(1),
  country_code: optionalNullablePositiveInt(),
  area_code: optionalNullableNonNegativeInt(),
  provider_id: optionalNullableNonNegativeInt(),
  package_service_id: optionalNullableString(),
  category: optionalNullableNonNegativeInt(),
  phone_type: optionalNullableNonNegativeInt(),
  display_name: optionalNullableString(),
  city_name: optionalNullableString(),
  state_name: optionalNullableString(),
  iso_country_code: optionalNullableString(),
  good_number_level: optionalNullableInt(),
  use_history: optionalNullableInt(),
  price: optionalNullableNonNegativeNumber(),
  product_id: optionalNullableString()
});

const purchasePhoneSchema = z.object({
  country_code: z.number().int().positive().optional(),
  iso_country_code: z.string().trim().optional(),
  country_key: z.string().trim().optional(),
  candidate: purchasePhoneCandidateSchema,
  confirm: z.boolean().optional().default(false)
});

const messagesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  keyword: z.string().optional(),
  msg_type: z.nativeEnum(MessageType).optional(),
  exclude_system: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === true || value === "true")),
  is_read: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true"))
});

type MessagesQuery = z.infer<typeof messagesQuerySchema>;

function buildMessagesWhere(accountId: number, query: MessagesQuery): Prisma.MessageWhereInput {
  return {
    accountId,
    ...(query.msg_type ? { msgType: query.msg_type } : query.exclude_system ? { msgType: { not: MessageType.system } } : {}),
    ...(query.keyword
      ? {
          OR: [
            { content: { contains: query.keyword } },
            { fromNumber: { contains: query.keyword } },
            { toNumber: { contains: query.keyword } }
          ]
        }
      : {}),
    ...(query.is_read === undefined ? {} : { isRead: query.is_read })
  };
}

export function buildMessagesWhereForTest(accountId: number, query: MessagesQuery) {
  return buildMessagesWhere(accountId, query);
}

const syncHelperMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  direct_only: z.boolean().optional().default(false)
});

const updatePhoneLabelSchema = z.object({
  display_name: z.string().trim().max(100)
});

const sessionImportAccountSchema = z.object({
  nickname: z.string().trim().max(100).optional().nullable(),
  app_variant: z.enum(["dingtone", "dingdong"]).optional(),
  package_name: z.string().trim().min(1).optional().nullable(),
  login_type: z.enum(["email_code", "phone_code", "email_password", "phone_password", "manual_session"]).optional().default("manual_session"),
  email: z.string().email().optional().nullable(),
  phone: z.string().min(5).optional().nullable(),
  dt_user_id: z.string().trim().min(1),
  token: z.string().trim().min(1),
  device_id: z.string().trim().min(1),
  telegram_notify: z.boolean().optional().default(false),
  proxy_enabled: z.boolean().optional().default(false),
  snapshot: z.unknown().optional().nullable(),
  phone_numbers: z.array(z.unknown()).optional().default([])
});

const sessionImportSchema = z.object({
  accounts: z.array(sessionImportAccountSchema).min(1).max(500),
  direct_settings: z.record(z.string()).optional().default({}),
  validate: z.boolean().optional().default(false)
});

const fullBackupImportSchema = z.object({
  settings: z.array(z.record(z.unknown())).optional().default([]),
  accounts: z.array(z.record(z.unknown())).optional().default([]),
  validate: z.boolean().optional().default(false)
});

export const accountsRouter = Router();
const directRefreshGateway = new DirectDingtoneGateway();
const helperRefreshGateway = new RealDingtoneGateway();
const SESSION_EXPORT_SETTING_KEYS = [
  "DT_GATEWAY_MODE",
  "dt_server_ip",
  "dt_server_port",
  "dt_backup_ip",
  "dt_direct_use_tls",
  "dt_direct_api_purchase_phone",
  "dt_direct_api_renew_phone",
  "dt_direct_api_cancel_phone",
  "dt_direct_api_pause_phone",
  "dt_direct_api_resume_phone",
  "dt_direct_api_reactivate_phone",
  "dt_direct_template_request_phone",
  "dt_direct_template_purchase_phone",
  "dt_direct_template_renew_phone",
  "dt_direct_template_cancel_phone",
  "dt_direct_template_pause_phone",
  "dt_direct_template_resume_phone",
  "dt_direct_template_phone_setting",
  "dt_direct_template_offline_messages",
  "direct_message_listen_seconds",
  "direct_message_refresh_wait_seconds",
  "direct_monitor_max_concurrent"
] as const;

const PHONE_COUNTRY_SELECTIONS: Record<string, { countryCode: number; isoCountryCode: string }> = {
  US: { countryCode: 1, isoCountryCode: "US" },
  CA: { countryCode: 1, isoCountryCode: "CA" },
  GB: { countryCode: 44, isoCountryCode: "GB" },
  BE: { countryCode: 32, isoCountryCode: "BE" },
  NL: { countryCode: 31, isoCountryCode: "NL" },
  RU: { countryCode: 7, isoCountryCode: "RU" },
  ES: { countryCode: 34, isoCountryCode: "ES" },
  CN: { countryCode: 86, isoCountryCode: "CN" },
  AU: { countryCode: 61, isoCountryCode: "AU" },
  AT: { countryCode: 43, isoCountryCode: "AT" },
  FR: { countryCode: 33, isoCountryCode: "FR" },
  SE: { countryCode: 46, isoCountryCode: "SE" },
  MU: { countryCode: 230, isoCountryCode: "MU" },
  PL: { countryCode: 48, isoCountryCode: "PL" },
  ID: { countryCode: 62, isoCountryCode: "ID" },
  PR: { countryCode: 1787, isoCountryCode: "PR" },
  CZ: { countryCode: 420, isoCountryCode: "CZ" },
  MY: { countryCode: 60, isoCountryCode: "MY" },
  DK: { countryCode: 45, isoCountryCode: "DK" },
  RO: { countryCode: 40, isoCountryCode: "RO" }
};

type RefreshMessagesDiagnostics = {
  source: string;
  scanned: number;
  imported: number;
  sampleSender: string | null;
  sampleContent: string | null;
  sampleReceivedAt: string | null;
  note?: string | null;
  offlineTemplate?: DirectMessageOfflineTemplateStatus | null;
};
type DirectMessageOfflineTemplateStatus = {
  attempted: boolean;
  sent: boolean;
  status: "sent" | "attempted-not-sent" | "not-attempted";
  listenStatus: "completed" | "preempted";
  error?: string | null;
};
const helperSessionGateway = new RealDingtoneGateway();

type PurchaseConfirmationSource = "remote_phone_list" | "adb_phone_db" | "helper_purchase_response";
type PurchaseConfirmation = {
  phone: DingtonePhoneNumber;
  source: PurchaseConfirmationSource;
  confirmed: boolean;
  note: string;
};

accountsRouter.get("/", async (req, res, next) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 20);
    const status = req.query.status ? String(req.query.status) : undefined;
    const keyword = req.query.keyword ? String(req.query.keyword) : undefined;

    const where: Prisma.DtAccountWhereInput = {
      adminId: req.auth!.userId,
      ...accountListVisibleWhere(),
      ...(status ? { status: status as never } : {}),
      ...(keyword
        ? {
            OR: [
              { nickname: { contains: keyword } },
              { email: { contains: keyword } },
              { phone: { contains: keyword } },
              { dtUserId: { contains: keyword } }
            ]
          }
        : {})
    };

    const [total, accounts] = await Promise.all([
      prisma.dtAccount.count({ where }),
      prisma.dtAccount.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          snapshot: {
            select: {
              fullName: true
            }
          }
        }
      })
    ]);

    const list = await Promise.all(
      accounts.map(async (item) => {
        const [unreadCount, activePhoneCount] = await Promise.all([
          prisma.message.count({ where: { accountId: item.id, isRead: false } }),
          prisma.phoneNumber.count({ where: { accountId: item.id, status: PhoneStatus.active } })
        ]);

        return {
          id: item.id,
          nickname: resolveAccountName(item),
          app_variant: item.appVariant,
          email: item.email,
          phone: item.phone,
          dt_user_id: item.dtUserId,
          status: item.status,
          monitor_enabled: item.monitorEnabled,
          telegram_notify: item.telegramNotify,
          unread_count: unreadCount,
          active_phone_count: activePhoneCount,
          last_login_at: item.lastLoginAt,
          created_at: item.createdAt
        };
      })
    );

    paged(res, { list, total, page, pageSize });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/", async (req, res, next) => {
  try {
    const body = createAccountSchema.parse(req.body);
    const adminId = req.auth!.userId;
    const existing = await findExistingAccount(adminId, body.app_variant, body.email ?? null, body.phone ?? null);
    const nickname = normalizeOptionalString(body.nickname);
    const deviceId = normalizeVerificationDeviceId(existing?.dtDeviceId ?? createDeviceId(), body.app_variant, body.login_type);
    const trackCode = existing?.dtTrackCode ?? createTrackCode();

    if (body.login_type === "manual_session") {
      const nextStatus = existing?.dtUserId ? existing.status : AccountStatus.pending;
      const account = await prisma.dtAccount.upsert({
        where: { id: existing?.id ?? -1 },
        update: {
          nickname,
          appVariant: body.app_variant,
          loginType: body.login_type,
          email: body.email ?? null,
          phone: body.phone ?? null,
          password: null,
          dtDeviceId: deviceId,
          dtTrackCode: trackCode,
          telegramNotify: body.telegram_notify,
          proxyEnabled: body.proxy_enabled,
          status: nextStatus,
          lastError: null
        },
        create: {
          adminId,
          nickname,
          appVariant: body.app_variant,
          loginType: body.login_type,
          email: body.email ?? null,
          phone: body.phone ?? null,
          password: null,
          dtDeviceId: deviceId,
          dtTrackCode: trackCode,
          telegramNotify: body.telegram_notify,
          proxyEnabled: body.proxy_enabled,
          status: AccountStatus.pending
        }
      });

      return ok(res, {
        id: account.id,
        status: nextStatus,
        reused: Boolean(existing),
        requires_session_import: true,
        message: "Account created. Open the account detail page to import the logged-in app session."
      });
    }

    if (body.login_type === "email_code" || body.login_type === "phone_code") {
      const nextStatus = existing?.dtUserId ? existing.status : AccountStatus.pending;
      const account = await prisma.dtAccount.upsert({
        where: { id: existing?.id ?? -1 },
        update: {
          nickname,
          appVariant: body.app_variant,
          loginType: body.login_type,
          email: body.email ?? null,
          phone: body.phone ?? null,
          password: null,
          dtDeviceId: deviceId,
          dtTrackCode: trackCode,
          telegramNotify: body.telegram_notify,
          proxyEnabled: body.proxy_enabled,
          status: nextStatus,
          lastError: null
        },
        create: {
          adminId,
          nickname,
          appVariant: body.app_variant,
          loginType: body.login_type,
          email: body.email ?? null,
          phone: body.phone ?? null,
          password: null,
          dtDeviceId: deviceId,
          dtTrackCode: trackCode,
          telegramNotify: body.telegram_notify,
          proxyEnabled: body.proxy_enabled,
          status: AccountStatus.pending
        }
      });

      let sendResult: VerificationSendResult;
      try {
        sendResult = await sendVerificationCodeWithVariantFallback({
          loginType: body.login_type,
          appVariant: body.app_variant,
          email: body.email,
          phone: body.phone,
          deviceId,
          trackCode
        });
        await prisma.dtAccount.update({
          where: { id: account.id },
          data: {
            appVariant: sendResult.appVariant,
            dtDeviceId: sendResult.deviceId,
            dtTrackCode: sendResult.trackCode,
            lastError: null
          }
        });
      } catch (error) {
        if (!account.dtUserId) {
          await prisma.dtAccount.deleteMany({ where: { id: account.id, adminId } }).catch(() => null);
        } else {
          await prisma.dtAccount.update({ where: { id: account.id }, data: { lastError: error instanceof Error ? error.message : String(error) } }).catch(() => null);
        }
        throw error;
      }

      return ok(res, {
        id: account.id,
        app_variant: sendResult.appVariant,
        message: sendResult.result.message,
        requires_verification: true,
        mock: sendResult.result.mock ?? false,
        verification_code: sendResult.result.verificationCode ?? null
      });
    }

    const loginResult = await dingtoneGateway.login({
      loginType: body.login_type,
      appVariant: body.app_variant,
      email: body.email,
      phone: body.phone,
      password: body.password,
      deviceId,
      trackCode
    });

    const account = existing
      ? await prisma.dtAccount.update({
          where: { id: existing.id },
          data: {
            nickname,
            appVariant: body.app_variant,
            loginType: body.login_type,
            email: body.email ?? null,
            phone: body.phone ?? null,
            password: body.password ? encryptText(body.password) : null,
            dtDeviceId: deviceId,
            dtTrackCode: trackCode,
            telegramNotify: body.telegram_notify,
            proxyEnabled: body.proxy_enabled
          }
        })
      : await prisma.dtAccount.create({
          data: {
            adminId,
            nickname,
            appVariant: body.app_variant,
            loginType: body.login_type,
            email: body.email ?? null,
            phone: body.phone ?? null,
            password: body.password ? encryptText(body.password) : null,
            dtDeviceId: deviceId,
            dtTrackCode: trackCode,
            telegramNotify: body.telegram_notify,
            proxyEnabled: body.proxy_enabled
          }
        });

    await finalizeSuccessfulLogin({
      accountId: account.id,
      loginResult
    });

    ok(res, {
      id: account.id,
      dt_user_id: loginResult.dtUserId,
      status: "offline",
      reused: Boolean(existing)
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.get("/sessions/export", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const accounts = await prisma.dtAccount.findMany({
      where: { adminId },
      orderBy: { id: "asc" },
      include: {
        snapshot: true,
        phoneNumbers: {
          orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
        }
      }
    });

    ok(res, {
      version: 1,
      exported_at: new Date().toISOString(),
      direct_settings: await exportSessionSettings(),
      accounts: accounts
        .filter((account) => account.dtUserId && account.dtToken)
        .map((account) => ({
          nickname: account.nickname,
          app_variant: account.appVariant,
          package_name: expectedPackageNameForVariant(account.appVariant),
          login_type: account.loginType,
          email: account.email,
          phone: account.phone,
          dt_user_id: account.dtUserId,
          token: decryptText(account.dtToken) ?? "",
          device_id: account.dtDeviceId,
          telegram_notify: account.telegramNotify,
          proxy_enabled: account.proxyEnabled,
          snapshot: serializeSnapshot(account.snapshot),
          phone_numbers: account.phoneNumbers.map(serializePhoneNumber)
        }))
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/sessions/import", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const body = sessionImportSchema.parse(req.body ?? {});
    const results = [];
    const settingsImported = await importSessionSettings(body.direct_settings);

    for (const item of body.accounts) {
      try {
        const accountId = await importSessionAccount(adminId, item, body.validate);
        results.push({
          ok: true,
          account_id: accountId,
          dt_user_id: item.dt_user_id,
          nickname: item.nickname ?? item.email ?? item.phone ?? item.dt_user_id
        });
      } catch (error) {
        results.push({
          ok: false,
          dt_user_id: item.dt_user_id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    ok(res, {
      imported: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      settings_imported: settingsImported,
      results
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.get("/backup/export", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const [settings, accounts] = await Promise.all([
      prisma.setting.findMany({ orderBy: { key: "asc" } }),
      prisma.dtAccount.findMany({
        orderBy: { id: "asc" },
        include: {
          admin: {
            select: {
              id: true,
              username: true
            }
          },
          snapshot: true,
          phoneNumbers: { orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }] },
          messages: { orderBy: { receivedAt: "asc" } }
        }
      })
    ]);

    ok(res, {
      version: 1,
      kind: "dt-manager-full-backup",
      exported_at: new Date().toISOString(),
      contains_secrets: true,
      settings: settings.map((item) => ({
        key: item.key,
        value: item.value,
        description: item.description
      })),
      accounts: accounts.map((account) => ({
        source_admin_id: account.adminId,
        source_admin_username: account.admin.username,
        nickname: account.nickname,
        app_variant: account.appVariant,
        package_name: expectedPackageNameForVariant(account.appVariant),
        login_type: account.loginType,
        email: account.email,
        phone: account.phone,
        password: account.password ? decryptText(account.password) : null,
        dt_user_id: account.dtUserId,
        token: account.dtToken ? decryptText(account.dtToken) : null,
        device_id: account.dtDeviceId,
        track_code: account.dtTrackCode,
        status: account.status,
        monitor_enabled: account.monitorEnabled,
        telegram_notify: account.telegramNotify,
        proxy_enabled: account.proxyEnabled,
        last_login_at: account.lastLoginAt,
        last_error: account.lastError,
        snapshot: account.snapshot ? mapStoredSnapshot(account.snapshot) : null,
        phone_numbers: account.phoneNumbers.map((phone) => ({
          phone_number: phone.phoneNumber,
          ...mapStoredPhoneNumber(phone)
        })),
        messages: account.messages.map((message) => serializeMessage(message))
      }))
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/backup/import", async (req, res, next) => {
  try {
    const adminId = req.auth!.userId;
    const body = fullBackupImportSchema.parse(req.body ?? {});
    let settingsImported = 0;
    const results = [];

    for (const setting of body.settings) {
      const key = normalizeOptionalString(setting.key);
      const value = normalizeOptionalString(setting.value);
      if (!key || value === null) {
        continue;
      }
      await prisma.setting.upsert({
        where: { key },
        update: {
          value,
          description: normalizeOptionalString(setting.description)
        },
        create: {
          key,
          value,
          description: normalizeOptionalString(setting.description)
        }
      });
      settingsImported += 1;
    }

    for (const item of body.accounts) {
      try {
        const result = await importFullBackupAccount(adminId, item, body.validate);
        results.push({ ok: true, ...result });
      } catch (error) {
        results.push({
          ok: false,
          dt_user_id: normalizeOptionalString(item.dt_user_id),
          nickname: normalizeOptionalString(item.nickname),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    ok(res, {
      imported: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      settings_imported: settingsImported,
      results
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.get("/:id", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    const account = await prisma.dtAccount.findUnique({
      where: { id: accountId },
      include: {
        snapshot: true,
        _count: {
          select: {
            phoneNumbers: true,
            messages: true
          }
        }
      }
    });
    const found = assertFound(account, "Account not found");

    const [unreadMessages, todayMessages, activePhoneCount, latestMonitor] = await Promise.all([
      prisma.message.count({ where: { accountId, isRead: false } }),
      prisma.message.count({
        where: {
          accountId,
          receivedAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0))
          }
        }
      }),
      prisma.phoneNumber.count({ where: { accountId, status: PhoneStatus.active } }),
      prisma.monitorSession.findFirst({
        where: { accountId },
        orderBy: { id: "desc" },
        select: {
          id: true,
          status: true,
          routeAddress: true,
          heartbeatCount: true,
          msgReceivedCount: true,
          errorMessage: true,
          startedAt: true,
          stoppedAt: true
        }
      })
    ]);

    ok(res, {
      id: found.id,
      nickname: resolveAccountName(found),
      app_variant: found.appVariant,
      login_type: found.loginType,
      email: found.email,
      phone: found.phone,
      dt_user_id: found.dtUserId,
      dt_device_id: found.dtDeviceId,
      status: found.status,
      monitor_enabled: found.monitorEnabled,
      telegram_notify: found.telegramNotify,
      proxy_enabled: found.proxyEnabled,
      last_login_at: found.lastLoginAt,
      last_error: found.lastError,
      snapshot: serializeSnapshot(found.snapshot),
      phone_number_count: found._count.phoneNumbers,
      active_phone_count: activePhoneCount,
      total_messages: found._count.messages,
      unread_messages: unreadMessages,
      today_messages: todayMessages,
      latest_monitor: latestMonitor
        ? {
            id: latestMonitor.id,
            status: latestMonitor.status,
            route_address: latestMonitor.routeAddress,
            heartbeat_count: latestMonitor.heartbeatCount,
            msg_received_count: latestMonitor.msgReceivedCount,
            error_message: latestMonitor.errorMessage,
            started_at: latestMonitor.startedAt,
            stopped_at: latestMonitor.stoppedAt
          }
        : null
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.put("/:id", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    const body = updateAccountSchema.parse(req.body);
    await assertAccount(accountId);

    const updated = await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        ...(body.nickname !== undefined ? { nickname: normalizeOptionalString(body.nickname) } : {}),
        ...(body.password ? { password: encryptText(body.password) } : {}),
        ...(body.telegram_notify !== undefined ? { telegramNotify: body.telegram_notify } : {}),
        ...(body.proxy_enabled !== undefined ? { proxyEnabled: body.proxy_enabled } : {})
      }
    });

    ok(res, serializeAccountForEdit(updated));
  } catch (error) {
    next(error);
  }
});

accountsRouter.delete("/:id", async (req, res, next) => {
  try {
    if (String(req.query.confirm) !== "true") {
      throw new AppError("Deleting an account requires confirm=true", 400, 400);
    }
    const accountId = Number(req.params.id);
    await accountMonitorService.stop(accountId).catch(() => undefined);
    const deleted = await prisma.dtAccount.deleteMany({ where: { id: accountId, adminId: req.auth!.userId } });
    if (deleted.count === 0) {
      return ok(res, null, "account already deleted");
    }
    ok(res, null, "account deleted");
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/send-verification-code", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    if (account.loginType !== "email_code" && account.loginType !== "phone_code") {
      throw new AppError("Only email or phone verification-code login can send a verification code.", 400, 400);
    }
    let sendResult: VerificationSendResult;
    try {
      sendResult = await sendVerificationCodeWithVariantFallback({
        loginType: account.loginType,
        appVariant: account.appVariant,
        email: account.email,
        phone: account.phone,
        deviceId: normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType),
        trackCode: account.dtTrackCode
      });
    } catch (error) {
      if (!account.dtUserId) {
        await prisma.dtAccount.deleteMany({ where: { id: account.id, adminId: req.auth!.userId } }).catch(() => null);
      } else {
        await prisma.dtAccount.update({ where: { id: account.id }, data: { lastError: error instanceof Error ? error.message : String(error) } }).catch(() => null);
      }
      throw error;
    }
    await prisma.dtAccount.update({
      where: { id: account.id },
      data: {
        appVariant: sendResult.appVariant,
        dtDeviceId: sendResult.deviceId,
        dtTrackCode: sendResult.trackCode,
        status: account.dtUserId ? account.status : AccountStatus.pending,
        lastError: null
      }
    });
    ok(res, {
      app_variant: sendResult.appVariant,
      message: sendResult.result.message,
      mock: sendResult.result.mock ?? false,
      verification_code: sendResult.result.verificationCode ?? null
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/verify-code", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    if (account.loginType !== "email_code" && account.loginType !== "phone_code") {
      throw new AppError("This account is not using email or phone verification-code login.", 400, 400);
    }
    const body = verifyCodeSchema.parse(req.body);
    const result = await dingtoneGateway.login({
      loginType: account.loginType,
      appVariant: account.appVariant,
      email: account.email,
      phone: account.phone,
      verificationCode: body.code,
      deviceId: normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType),
      trackCode: account.dtTrackCode
    });

    await finalizeSuccessfulLogin({
      accountId: account.id,
      loginResult: result
    });

    ok(res, {
      dt_user_id: result.dtUserId,
      dt_token: result.token,
      status: "offline"
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/probe-access-code", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    const body = accessCodeProbeSchema.parse(req.body);
    const inferredKind = body.kind ?? inferAccessCodeKind(account);
    const target = normalizeOptionalString(body.target) ?? (inferredKind === "email" ? account.email : account.phone);
    if (!target) {
      throw new AppError(`Missing ${inferredKind} target`, 400, 400);
    }
    if (body.dry_run) {
      return ok(res, {
        dry_run: true,
        ...buildDirectAccessCodeDryRun({
          kind: inferredKind,
          target,
          countryCode: body.country_code,
          accessCode: body.access_code,
          noCode: body.no_code
        })
      });
    }
    if (requiresAccessCodeProbeConfirm(body)) {
      throw new AppError("Real access-code probes can trigger SMS. Re-submit with confirm=true after reviewing dry-run output.", 400, 400);
    }
    const dtUserId = requireString(account.dtUserId, "Missing dt_user_id");
    const token = requireString(decryptText(account.dtToken), "Missing dt_token");
    const result = await runDirectAccessCodeProbe({
      account: {
        dtUserId,
        token,
        deviceId: normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType),
        email: account.email,
        phone: account.phone
      },
      kind: inferredKind,
      target,
      countryCode: body.country_code,
      accessCode: body.access_code,
      noCode: body.no_code
    });
    ok(res, serializeAccessCodeProbe(result, inferredKind, target));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/start", async (req, res, next) => {
  try {
    const session = await accountMonitorService.start(Number(req.params.id));
    ok(res, {
      session_id: session.id,
      status: session.status,
      server: `${session.serverIp}:${session.serverPort}`
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/stop", async (req, res, next) => {
  try {
    await accountMonitorService.stop(Number(req.params.id));
    ok(res, {
      status: "stopped",
      stopped_at: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/restart", async (req, res, next) => {
  try {
    const session = await accountMonitorService.restart(Number(req.params.id));
    ok(res, { status: session.status, session_id: session.id });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/re-login", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    if (account.loginType === "manual_session" || account.loginType === "email_code" || account.loginType === "phone_code") {
      throw new AppError("This account does not support password re-login. Please import a fresh direct session or verify again.", 400, 400);
    }
    const password = decryptText(account.password);
    if (!password) {
      throw new AppError("Account does not have a stored password", 400, 400);
    }
    const result = await dingtoneGateway.login({
      loginType: account.loginType,
      appVariant: account.appVariant,
      email: account.email,
      phone: account.phone,
      password,
      deviceId: normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType),
      trackCode: createTrackCode()
    });

    await finalizeSuccessfulLogin({
      accountId: account.id,
      loginResult: result
    });

    ok(res, {
      dt_user_id: result.dtUserId,
      status: "offline"
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/capture-session", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    const account = await assertAccount(accountId);
    const { storedSession, validation, validationError, source } = await captureAndImportSession(accountId, account);
    const refresh = await tryRefreshValidatedAccountData(accountId, 6_000);

    ok(res, {
      dt_user_id: storedSession.dtUserId,
      dt_device_id: storedSession.deviceId,
      app_variant: storedSession.appVariant ?? account.appVariant,
      package_name: storedSession.packageName ?? expectedPackageNameForVariant(account.appVariant),
      source,
      status: validation ? "offline" : "warning",
      validation: validation ? serializeDirectValidation(validation.probe, validation.deviceId) : null,
      validation_error: validationError,
      snapshot: refresh.snapshot,
      refresh_error: refresh.error
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/validate-session", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    const account = await assertAccount(accountId);
    const body = validateSessionSchema.parse(req.body ?? {});
    const session: DingtoneSessionExport = {
      dtUserId: normalizeOptionalString(body.dt_user_id) ?? requireString(account.dtUserId, "Missing dt_user_id"),
      token: normalizeOptionalString(body.token) ?? requireString(decryptText(account.dtToken), "Missing dt_token"),
      deviceId: normalizeOptionalString(body.device_id) ?? account.dtDeviceId,
      deviceIdCandidates: body.device_id_candidates,
      appVariant: body.app_variant,
      packageName: body.package_name
    };
    const { storedSession, validation, validationError } = await importAuthorizedSession(accountId, account, session, {
      phonePreviewCountryCode: body.phone_preview_country_code
    });
    const refresh = await tryRefreshValidatedAccountData(accountId, 6_000);

    ok(res, {
      dt_user_id: storedSession.dtUserId,
      dt_device_id: storedSession.deviceId,
      status: validation ? "offline" : "warning",
      validation: validation ? serializeDirectValidation(validation.probe, validation.deviceId) : null,
      validation_error: validationError,
      snapshot: refresh.snapshot,
      refresh_error: refresh.error
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/refresh", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    const account = await assertAccount(accountId);
    const gateway = (await shouldUseDirectAccountFlow(account)) ? directRefreshGateway : dingtoneGateway;
    const { snapshot } = await refreshAccountRuntimeData(accountId, gateway);
    ok(res, { snapshot, refresh_error: null, cached: false });
  } catch (error) {
    try {
      const accountId = Number(req.params.id);
      const helperRefreshed = await refreshAccountRuntimeData(accountId, helperRefreshGateway).catch(() => null);
      if (helperRefreshed?.snapshot) {
        logger.warn("Direct refresh failed, returning helper-backed snapshot", {
          accountId,
          error: error instanceof Error ? error.message : String(error)
        });
        return ok(res, {
          snapshot: helperRefreshed.snapshot,
          refresh_error: error instanceof Error ? error.message : String(error),
          cached: false
        });
      }
      const cached = await prisma.accountSnapshot.findUnique({ where: { accountId } });
      if (cached) {
        logger.warn("Refresh failed, returning cached snapshot", {
          accountId,
          error: error instanceof Error ? error.message : String(error)
        });
        return ok(res, {
          snapshot: serializeSnapshot(cached),
          refresh_error: error instanceof Error ? error.message : String(error),
          cached: true
        });
      }
    } catch {
      // fall through to normal error handler
    }
    next(error);
  }
});

accountsRouter.get("/:id/point", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    await assertAccount(accountId);
    const data = await getAccountPoint(accountId);
    ok(res, serializePointData(data));
  } catch (error) {
    next(error);
  }
});

accountsRouter.get("/:id/pointstore", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    await assertAccount(accountId);
    const data = await getAccountPointStore(accountId);
    ok(res, serializePointStore(data));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/pointstore/order", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    await assertAccount(accountId);
    const body = pointStoreOrderSchema.parse(req.body ?? {});
    if (!body.confirm) {
      throw new AppError("Point store order requires confirmation.", 400, 400);
    }
    const data = await orderAccountPointStoreProduct(accountId, body.product_id);
    ok(res, serializePointStoreOrder(data));
  } catch (error) {
    next(error);
  }
});
accountsRouter.get("/:id/messages", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    await assertAccount(accountId);
    const query = messagesQuerySchema.parse(req.query);
    const where = buildMessagesWhere(accountId, query);

    const [total, list] = await Promise.all([
      prisma.message.count({ where }),
      prisma.message.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      })
    ]);

    paged(res, {
      list: list.map(serializeMessage),
      total,
      page: query.page,
      pageSize: query.pageSize
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/messages/sync-helper", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    const body = syncHelperMessagesSchema.parse(req.body ?? {});
    const diagnostics: RefreshMessagesDiagnostics[] = [];
    const { rows, imported, source } = await syncMessagesWithFallback(account, body.limit, diagnostics);
    const latest = await prisma.message.findMany({
      where: { accountId: account.id },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: 10
    });
    ok(res, {
      imported,
      source,
      scanned: rows.length,
      matched: rows.length,
      diagnostics,
      messages: latest.map(serializeMessage)
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/messages/refresh", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    const body = syncHelperMessagesSchema.parse(req.body ?? {});
    const result = await refreshMessagesFromRemote(account.id, body.limit, body.direct_only);
    const latest = await prisma.message.findMany({
      where: { accountId: account.id },
      orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
      take: 10
    });
    ok(res, {
      imported: result.imported,
      diagnostics: result.diagnostics,
      messages: latest.map(serializeMessage)
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.put("/:id/messages/read-all", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    await prisma.message.updateMany({
      where: { accountId, isRead: false },
      data: { isRead: true }
    });
    ok(res, null);
  } catch (error) {
    next(error);
  }
});

accountsRouter.delete("/:id/messages/:messageId", async (req, res, next) => {
  try {
    await prisma.message.delete({
      where: { id: Number(req.params.messageId) }
    });
    ok(res, null);
  } catch (error) {
    next(error);
  }
});

accountsRouter.get("/:id/phone-numbers", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    await assertAccount(accountId);
    const list = await prisma.phoneNumber.findMany({
      where: { accountId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
    });
    ok(res, list.map(serializePhoneNumber));
  } catch (error) {
    next(error);
  }
});

accountsRouter.get("/:id/phone-numbers/countries", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    const directAccount = {
      dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
      token: requireString(decryptText(account.dtToken), "Missing dt_token"),
      deviceId: account.dtDeviceId
    };
    const list = await directRefreshGateway.listPhoneNumberCountries(directAccount);
    ok(res, list.map((item) => ({
      country_key: item.countryKey,
      label: item.label,
      country_code: item.countryCode,
      iso_country_code: item.isoCountryCode,
      provider_id_list: item.providerIdList ?? [],
      available: item.available ?? true,
      raw_json: item.rawJson ?? null
    })));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/sync", async (req, res, next) => {
  try {
    const accountId = Number(req.params.id);
    const phoneNumbers = await syncPhoneNumbersFromRemote(accountId);
    ok(res, phoneNumbers.map(serializePhoneNumber));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers", async (req, res, next) => {
  try {
    const preview = await previewPhoneNumbers(Number(req.params.id), req.body ?? {});
    ok(res, serializePhonePurchasePreview(preview));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/preview", async (req, res, next) => {
  try {
    const preview = await previewPhoneNumbers(Number(req.params.id), req.body ?? {});
    ok(res, serializePhonePurchasePreview(preview));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/purchase", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    const body = purchasePhoneSchema.parse(req.body ?? {});
    assertPhoneCountrySelection(body);
    if (requiresPhonePurchaseConfirm(body)) {
      throw new AppError("Purchasing a phone number requires confirm=true", 400, 400);
    }
    const useDirect = await shouldUseDirectAccountFlow(account);
    const helperPurchaseTimeoutMs = Math.max(45_000, config.DT_HELPER_PURCHASE_TIMEOUT_MS);
    let usedHelperPurchaseFallback = false;
    const directAccount = useDirect
      ? {
          dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
          token: requireString(decryptText(account.dtToken), "Missing dt_token"),
          deviceId: account.dtDeviceId
        }
      : null;
    const purchaseCandidate = mapPurchaseCandidate(body.candidate);
    let remote: DingtonePhoneNumber;
    if (useDirect) {
      try {
        remote = await directRefreshGateway.purchasePhoneNumber(
            {
              dtUserId: directAccount!.dtUserId,
              token: directAccount!.token,
              deviceId: directAccount!.deviceId
            },
            {
              countryCode: body.country_code,
              isoCountryCode: body.iso_country_code ?? body.candidate.iso_country_code,
              countryKey: body.country_key,
              candidate: purchaseCandidate
            }
          );
      } catch (error) {
        logger.warn("Direct phone purchase failed; trying helper/native fallback", {
          accountId: account.id,
          appVariant: account.appVariant,
          error: error instanceof Error ? error.message : String(error)
        });
        remote = normalizeHelperPhoneNumber(
          await executeHelperAction(
            "purchase_phone_number",
            {
              appVariant: account.appVariant,
              countryCode: body.country_code,
              isoCountryCode: body.iso_country_code ?? body.candidate.iso_country_code,
              countryKey: body.country_key,
              candidate: purchaseCandidate
            },
            helperPurchaseTimeoutMs
          )
        );
        usedHelperPurchaseFallback = true;
      }
    } else {
      remote = normalizeHelperPhoneNumber(
        await executeHelperAction(
          "purchase_phone_number",
          {
            appVariant: account.appVariant,
            countryCode: body.country_code,
            isoCountryCode: body.iso_country_code ?? body.candidate.iso_country_code,
            countryKey: body.country_key,
            candidate: purchaseCandidate
          },
          helperPurchaseTimeoutMs
        )
      );
    }
    const confirmation: PurchaseConfirmation = useDirect && !usedHelperPurchaseFallback
      ? await confirmPurchasedPhone(
          directAccount!,
          remote,
          account.appVariant
        ).catch((error) => {
          logger.warn("Direct purchase was not confirmed; local phone data was not changed", {
            accountId: account.id,
            appVariant: account.appVariant,
            phoneNumber: redactPhoneForLog(remote.phoneNumber),
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        })
      : {
          phone: remote,
          source: "helper_purchase_response",
          confirmed: false,
          note: "Helper native app purchase fallback returned the purchased phone record."
        };
    const confirmedRemote = confirmation.phone;

    await prisma.phoneNumber.upsert({
      where: {
        accountId_phoneNumber: {
          accountId: account.id,
          phoneNumber: confirmedRemote.phoneNumber
        }
      },
      update: mapPhoneNumberPatch(confirmedRemote),
      create: {
        ...mapPhoneNumberCreate(account.id, confirmedRemote)
      }
    });

    const snapshot = await refreshAccountRuntimeData(account.id).then((result) => result.snapshot).catch((error) => {
      logger.warn("Failed to refresh account snapshot after phone purchase; returning the purchased phone first", {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    });
    const item = assertFound(
      await prisma.phoneNumber.findFirst({
        where: {
          accountId: account.id,
          phoneNumber: confirmedRemote.phoneNumber
        }
      }),
      "Phone number not found after purchase"
    );
    await sendPhoneTelegramNotification({
      account,
      phone: confirmedRemote,
      verificationSource: confirmation.source,
      verificationNote: confirmation.note
    }).catch((error) => {
      logger.warn("Failed to send Telegram notification for purchased phone", {
        accountId: account.id,
        phoneNumber: confirmedRemote.phoneNumber,
        error: error instanceof Error ? error.message : String(error)
      });
    });

    ok(res, {
      phone: serializePhoneNumber(item),
      snapshot,
      verification: {
        source: confirmation.source,
        confirmed: confirmation.confirmed,
        phone_number: confirmedRemote.phoneNumber,
        status: item.status,
        note: confirmation.note
      }
    });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/:phoneId/renew", async (req, res, next) => {
  try {
    const body = phoneActionConfirmSchema.parse(req.body ?? {});
    if (requiresPhoneRenewConfirm(body)) {
      throw new AppError("Renewing a phone number requires confirm=true", 400, 400);
    }
    const account = await assertAccount(Number(req.params.id));
    const phoneItem = await assertAccountPhoneNumber(account.id, Number(req.params.phoneId));
    const useDirect = await shouldUseDirectAccountFlow(account);
    const remote = useDirect
      ? await directRefreshGateway.renewPhoneNumber(
          {
            dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
            token: requireString(decryptText(account.dtToken), "Missing dt_token"),
            deviceId: account.dtDeviceId
          },
          phoneItem.phoneNumber,
          mapStoredPhoneContext(phoneItem)
        )
      : normalizeHelperPhoneNumberPatch(
          await executeHelperAction("renew_phone_number", { appVariant: account.appVariant, phoneNumber: phoneItem.phoneNumber }, 45_000)
        );
    const verified = useDirect ? await verifyDirectPhoneAction(account, phoneItem, null) : {};

    const updated = await prisma.phoneNumber.update({
      where: { id: phoneItem.id },
      data: mapPhoneNumberPatch({ ...remote, ...verified })
    });

    const response = phoneActionResponse(updated, "renew", useDirect, verified);
    await sendPhoneActionTelegramNotification(account, updated, "renew", response.verification);
    ok(res, response);
  } catch (error) {
    next(error);
  }
});

accountsRouter.put("/:id/phone-numbers/:phoneId/label", async (req, res, next) => {
  try {
    const account = await assertAccount(Number(req.params.id));
    const phoneItem = await assertAccountPhoneNumber(account.id, Number(req.params.phoneId));
    const body = updatePhoneLabelSchema.parse(req.body ?? {});
    const useDirect = await shouldUseDirectAccountFlow(account);
    const remote = useDirect
      ? await directRefreshGateway.updatePhoneNumberLabel(
          {
            dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
            token: requireString(decryptText(account.dtToken), "Missing dt_token"),
            deviceId: account.dtDeviceId
          },
          phoneItem.phoneNumber,
          body.display_name,
          mapStoredPhoneContext(phoneItem)
        )
      : normalizeHelperPhoneNumberPatch(
          await executeHelperAction(
            "update_phone_number_label",
            { appVariant: account.appVariant, phoneNumber: phoneItem.phoneNumber, displayName: body.display_name },
            35_000
          )
        );
    const updated = await prisma.phoneNumber.update({
      where: { id: phoneItem.id },
      data: mapPhoneNumberPatch({ ...remote, displayName: body.display_name })
    });
    ok(res, serializePhoneNumber(updated));
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/:phoneId/cancel", async (req, res, next) => {
  try {
    const body = phoneActionConfirmSchema.parse(req.body ?? {});
    if (requiresPhoneCancelConfirm(body)) {
      throw new AppError("Cancelling a phone number requires confirm=true", 400, 400);
    }
    const account = await assertAccount(Number(req.params.id));
    const phoneItem = await assertAccountPhoneNumber(account.id, Number(req.params.phoneId));
    const useDirect = await shouldUseDirectAccountFlow(account);
    if (useDirect) {
      await directRefreshGateway.cancelPhoneNumber(
        {
          dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
          token: requireString(decryptText(account.dtToken), "Missing dt_token"),
          deviceId: account.dtDeviceId
        },
        phoneItem.phoneNumber,
        mapStoredPhoneContext(phoneItem)
      );
    } else {
      await executeHelperAction("cancel_phone_number", { appVariant: account.appVariant, phoneNumber: phoneItem.phoneNumber }, 35_000);
    }
    const verified = useDirect ? await verifyDirectPhoneAction(account, phoneItem, PhoneStatus.cancelled) : { status: PhoneStatus.cancelled };

    const updated = await prisma.phoneNumber.update({
      where: { id: phoneItem.id },
      data: mapPhoneNumberPatch(verified)
    });
    const response = phoneActionResponse(updated, "cancel", useDirect, verified);
    await sendPhoneActionTelegramNotification(account, updated, "cancel", response.verification);
    ok(res, response);
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/:phoneId/pause", async (req, res, next) => {
  try {
    const body = phoneActionConfirmSchema.parse(req.body ?? {});
    if (requiresPhonePauseConfirm(body)) {
      throw new AppError("Pausing a phone number requires confirm=true", 400, 400);
    }
    const account = await assertAccount(Number(req.params.id));
    const phoneItem = await assertAccountPhoneNumber(account.id, Number(req.params.phoneId));
    const useDirect = await shouldUseDirectAccountFlow(account);
    if (useDirect) {
      await directRefreshGateway.pausePhoneNumber(
        {
          dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
          token: requireString(decryptText(account.dtToken), "Missing dt_token"),
          deviceId: account.dtDeviceId
        },
        phoneItem.phoneNumber,
        mapStoredPhoneContext(phoneItem)
      );
    } else {
      await executeHelperAction("pause_phone_number", { appVariant: account.appVariant, phoneNumber: phoneItem.phoneNumber }, 35_000);
    }
    const verified = useDirect ? await verifyDirectPhoneAction(account, phoneItem, PhoneStatus.paused) : { status: PhoneStatus.paused };

    const updated = await prisma.phoneNumber.update({
      where: { id: phoneItem.id },
      data: mapPhoneNumberPatch(verified)
    });
    const response = phoneActionResponse(updated, "pause", useDirect, verified);
    await sendPhoneActionTelegramNotification(account, updated, "pause", response.verification);
    ok(res, response);
  } catch (error) {
    next(error);
  }
});

accountsRouter.post("/:id/phone-numbers/:phoneId/resume", async (req, res, next) => {
  try {
    const body = phoneActionConfirmSchema.parse(req.body ?? {});
    if (requiresPhoneResumeConfirm(body)) {
      throw new AppError("Resuming a phone number requires confirm=true", 400, 400);
    }
    const account = await assertAccount(Number(req.params.id));
    const phoneItem = await assertAccountPhoneNumber(account.id, Number(req.params.phoneId));
    const useDirect = await shouldUseDirectAccountFlow(account);
    if (useDirect) {
      await directRefreshGateway.resumePhoneNumber(
        {
          dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
          token: requireString(decryptText(account.dtToken), "Missing dt_token"),
          deviceId: account.dtDeviceId
        },
        phoneItem.phoneNumber,
        mapStoredPhoneContext(phoneItem)
      );
    } else {
      await executeHelperAction("resume_phone_number", { appVariant: account.appVariant, phoneNumber: phoneItem.phoneNumber }, 35_000);
    }
    const verified = useDirect ? await verifyDirectPhoneAction(account, phoneItem, PhoneStatus.active) : { status: PhoneStatus.active };

    const updated = await prisma.phoneNumber.update({
      where: { id: phoneItem.id },
      data: mapPhoneNumberPatch(verified)
    });
    const response = phoneActionResponse(updated, "resume", useDirect, verified);
    await sendPhoneActionTelegramNotification(account, updated, "resume", response.verification);
    ok(res, response);
  } catch (error) {
    next(error);
  }
});

accountsRouter.delete("/:id/phone-numbers/:phoneId", async (req, res, next) => {
  try {
    if (String(req.query.confirm) !== "true") {
      throw new AppError("Deleting a phone number requires confirm=true", 400, 400);
    }
    const account = await assertAccount(Number(req.params.id));
    const phoneItem = await assertAccountPhoneNumber(account.id, Number(req.params.phoneId));
    if (phoneItem.status !== PhoneStatus.cancelled && phoneItem.status !== PhoneStatus.expired) {
      throw new AppError("Only cancelled or expired phone numbers can be deleted", 400, 400);
    }
    await prisma.phoneNumber.delete({ where: { id: phoneItem.id } });
    ok(res, null);
  } catch (error) {
    next(error);
  }
});

async function refreshAccountData(
  accountId: number,
  gateway: Pick<DingtoneGateway, "refreshSnapshot" | "listPhoneNumbers"> = dingtoneGateway
) {
  const account = await assertAccount(accountId);
  const dtUserId = requireString(account.dtUserId, "Missing dt_user_id");
  const token = requireString(decryptText(account.dtToken), "Missing dt_token");

  const snapshot = await gateway.refreshSnapshot({
    dtUserId,
    token,
    deviceId: account.dtDeviceId,
    email: account.email,
    phone: account.phone
  });
  const phoneNumbers = await gateway.listPhoneNumbers({ dtUserId, token, deviceId: account.dtDeviceId });

  await prisma.accountSnapshot.upsert({
    where: { accountId },
    update: mapSnapshot(snapshot),
    create: {
      accountId,
      ...mapSnapshot(snapshot)
    }
  });

  if (phoneNumbers.length > 0) {
    await syncPhoneNumbers(accountId, phoneNumbers);
  } else {
    logger.warn("鍒锋柊璐︽埛鍙风爜鍒楄〃杩斿洖绌烘暟鎹紝淇濈暀鏈湴宸叉湁鍙风爜", {
      accountId,
      dtUserId
    });
  }

  const normalizedNickname = normalizeOptionalString(account.nickname);
  const snapshotName = normalizeOptionalString(snapshot.fullName);
  if (!normalizedNickname || shouldReplaceNickname(normalizedNickname, snapshotName)) {
    const autoName = snapshotName || account.email || account.phone || account.dtUserId || "Unnamed account";
    await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        nickname: autoName
      }
    });
  }

  const updated = await prisma.accountSnapshot.findUnique({ where: { accountId } });
  return serializeSnapshot(updated);
}

async function finalizeSuccessfulLogin(input: {
  accountId: number;
  loginResult: DingtoneLoginResult;
}) {
  const accountId = await persistAuthenticatedSession(input.accountId, {
    dtUserId: input.loginResult.dtUserId,
    token: input.loginResult.token,
    deviceId: input.loginResult.deviceId ?? null
  });

  try {
    await refreshAccountRuntimeData(accountId);
  } catch (error) {
    await prisma.dtAccount.update({
      where: { id: accountId },
      data: {
        status: AccountStatus.error,
        lastError: error instanceof Error ? error.message : "鍒锋柊璐︽埛淇℃伅澶辫触"
      }
    });
  }
}

async function captureAndImportSession(
  accountId: number,
  account: {
    id: number;
    adminId: number;
    appVariant: AppVariant;
    dtDeviceId: string;
    dtUserId: string | null;
    email: string | null;
    phone: string | null;
  }
) {
  let helperError: unknown;
  try {
    const session = await helperSessionGateway.exportSession({
      appVariant: account.appVariant,
      account: {
        dtUserId: account.dtUserId ?? undefined,
        deviceId: account.dtUserId ? account.dtDeviceId : undefined,
        email: account.dtUserId ? account.email : undefined,
        phone: account.dtUserId ? account.phone : undefined
      }
    });
    return {
      ...(await importAuthorizedSession(accountId, account, session)),
      source: "helper" as const
    };
  } catch (error) {
    helperError = error;
    logger.warn("Helper session capture failed; trying ADB app-config fallback", {
      accountId,
      appVariant: account.appVariant,
      expectedPackage: expectedPackageNameForVariant(account.appVariant),
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const session = await exportSessionFromAdbConfig(account.appVariant);
    return {
      ...(await importAuthorizedSession(accountId, account, session)),
      source: "adb-config" as const
    };
  } catch (adbError) {
    throw new AppError(
      `Session capture failed for ${describeAccountVariant(account.appVariant)} (${expectedPackageNameForVariant(account.appVariant)}). Helper: ${
        helperError instanceof Error ? helperError.message : String(helperError ?? "unknown error")
      }; ADB fallback: ${adbError instanceof Error ? adbError.message : String(adbError)}`,
      503,
      503
    );
  }
}

async function persistCapturedSession(accountId: number, account: { dtDeviceId: string; email?: string | null; phone?: string | null }, session: DingtoneSessionExport) {
  const persistedAccountId = await persistAuthenticatedSession(accountId, {
    dtUserId: session.dtUserId,
    token: session.token,
    deviceId: normalizeOptionalString(session.deviceId) ?? account.dtDeviceId
  });
  const activatedEmail = normalizeOptionalString(session.activatedEmail);
  const mainPhone = normalizeOptionalString(session.mainPhone);
  if ((activatedEmail && !account.email) || (mainPhone && !account.phone)) {
    await prisma.dtAccount.update({
      where: { id: persistedAccountId },
      data: {
        ...(activatedEmail && !account.email ? { email: activatedEmail } : {}),
        ...(mainPhone && !account.phone ? { phone: mainPhone } : {})
      }
    });
  }
  if (session.snapshot) {
    const previousSnapshot = await prisma.accountSnapshot.findUnique({ where: { accountId: persistedAccountId } });
    await prisma.accountSnapshot.upsert({
      where: { accountId: persistedAccountId },
      update: mapSnapshot(session.snapshot, previousSnapshot),
      create: {
        accountId: persistedAccountId,
        ...mapSnapshot(session.snapshot, previousSnapshot)
      }
    });
  }
  if (session.phoneNumbers && session.phoneNumbers.length > 0) {
    await syncPhoneNumbers(persistedAccountId, session.phoneNumbers);
  }
  return persistedAccountId;
}

async function validateCapturedSession(
  account: {
    id: number;
    appVariant: AppVariant;
    dtDeviceId: string;
    email: string | null;
    phone: string | null;
  },
  session: DingtoneSessionExport,
  options: { phonePreviewCountryCode?: number } = {}
) {
  const deviceCandidates = uniqueNonEmptyStrings([session.deviceId, ...(session.deviceIdCandidates ?? []), account.dtDeviceId]);
  let lastError: unknown;

  for (const deviceId of deviceCandidates) {
    try {
      const probe = await runDirectSessionProbe({
        account: {
          dtUserId: session.dtUserId,
          token: session.token,
          deviceId,
          email: session.activatedEmail ?? account.email,
          phone: session.mainPhone ?? account.phone
        },
        phonePreviewCountryCode: options.phonePreviewCountryCode
      });
      if (probe.ok) {
        return { deviceId, probe };
      }
      lastError = new Error(`Direct probe returned no successful call for deviceId=${deviceId}`);
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "unknown direct session validation error";
  await prisma.dtAccount.update({
    where: { id: account.id },
    data: {
      status: AccountStatus.error,
      lastError: `Captured session validation failed: ${message}`
    }
  });
  throw new AppError(`Captured session validation failed: ${message}`, 409, 409);
}

async function importAuthorizedSession(
  accountId: number,
  account: {
    id: number;
    adminId: number;
    appVariant: AppVariant;
    dtDeviceId: string;
    email: string | null;
    phone: string | null;
  },
  session: DingtoneSessionExport,
  options: { phonePreviewCountryCode?: number } = {}
) {
  const storedSession = {
    ...session,
    deviceId: normalizeOptionalString(session.deviceId) ?? account.dtDeviceId
  };
  assertCapturedSessionMatchesAccountVariant(account, storedSession);
  await assertCapturedSessionIsNotOwnedByAnotherAccount(account, storedSession);
  let persistedAccountId = await persistCapturedSession(accountId, account, storedSession);
  await tryHydrateImportedAccountFromHelper(persistedAccountId);

  const validation = await tryValidateCapturedSessionQuickly(account, storedSession, options);
  const validationError = validation ? null : "Direct validation timed out or failed during import; imported helper session was still saved.";
  const finalSession = validation
    ? {
        ...storedSession,
        deviceId: validation.deviceId
      }
    : storedSession;
  persistedAccountId = await persistCapturedSession(persistedAccountId, account, finalSession);

  if (validationError) {
    await prisma.dtAccount.update({
      where: { id: persistedAccountId },
      data: {
        status: AccountStatus.offline,
        lastError: validationError
      }
    });
  } else {
    await prisma.dtAccount.update({
      where: { id: persistedAccountId },
      data: {
        status: AccountStatus.offline,
        lastError: null
      }
    });
  }

  return {
    storedSession: finalSession,
    validation,
    validationError
  };
}

async function tryValidateCapturedSessionQuickly(
  account: {
    id: number;
    appVariant: AppVariant;
    dtDeviceId: string;
    email: string | null;
    phone: string | null;
  },
  session: DingtoneSessionExport,
  options: { phonePreviewCountryCode?: number } = {}
) {
  try {
    return await Promise.race([
      validateCapturedSession(account, session, options),
      delayResult<null>(8_000, null)
    ]);
  } catch (error) {
    logger.warn("Quick direct validation failed after import", {
      accountId: account.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function assertCapturedSessionMatchesAccountVariant(account: { appVariant: AppVariant }, session: DingtoneSessionExport) {
  const expectedPackage = expectedPackageNameForVariant(account.appVariant);
  const actualPackage = normalizeOptionalString(session.packageName);
  const packageVariant = inferAppVariantFromPackageName(actualPackage);
  if (packageVariant && packageVariant !== account.appVariant) {
    throw new AppError(
      `Captured session came from ${actualPackage}, but this account is ${describeAccountVariant(account.appVariant)} and expects ${expectedPackage}. Open the matching app and import again.`,
      409,
      409
    );
  }
  if (actualPackage && expectedPackage && actualPackage !== expectedPackage) {
    throw new AppError(
      `Captured session came from ${actualPackage}, but this account is ${describeAccountVariant(account.appVariant)} and expects ${expectedPackage}. Open the matching app and import again.`,
      409,
      409
    );
  }

  if (session.appVariant && session.appVariant !== account.appVariant) {
    throw new AppError(
      `Captured session is ${session.appVariant}, but this account is ${account.appVariant}. Open the matching app and import again.`,
      409,
      409
    );
  }
}

function expectedPackageNameForVariant(variant: AppVariant) {
  return variant === AppVariant.dingdong ? config.DT_ADB_DINGDONG_PACKAGE : config.DT_ADB_DINGTONE_PACKAGE;
}

function inferAppVariantFromPackageName(packageName?: string | null): AppVariant | null {
  const normalized = normalizeOptionalString(packageName)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === config.DT_ADB_DINGDONG_PACKAGE.toLowerCase() || normalized === "me.dingtone.app.im") {
    return AppVariant.dingdong;
  }
  if (normalized === config.DT_ADB_DINGTONE_PACKAGE.toLowerCase() || normalized === "me.talkyou.app.im") {
    return AppVariant.dingtone;
  }
  return null;
}

function inferAppVariantFromDeviceId(deviceId?: string | null): AppVariant | null {
  const normalized = normalizeOptionalString(deviceId)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.endsWith(".dttalk") || normalized.includes("dttalk")) {
    return AppVariant.dingtone;
  }
  return null;
}

async function assertCapturedSessionIsNotOwnedByAnotherAccount(
  account: { id: number; adminId: number; appVariant: AppVariant },
  session: DingtoneSessionExport
) {
  const dtUserId = normalizeOptionalString(session.dtUserId);
  if (!dtUserId) {
    return;
  }

  const owner = await prisma.dtAccount.findFirst({
    where: {
      adminId: account.adminId,
      dtUserId,
      NOT: { id: account.id }
    },
    select: {
      id: true,
      nickname: true,
      appVariant: true,
      email: true,
      phone: true
    }
  });
  if (!owner) {
    return;
  }

  logger.warn("Captured session dt_user_id already exists on another local account; it will be merged after import", {
    targetAccountId: account.id,
    duplicateAccountId: owner.id,
    targetVariant: account.appVariant,
    duplicateVariant: owner.appVariant
  });
}

function describeAccountVariant(variant: AppVariant) {
  return variant === AppVariant.dingdong ? "叮咚" : "说道/TalkU";
}

function delayResult<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function serializeDirectValidation(probe: DirectProbeResult, deviceId: string) {
  return {
    ok: probe.ok,
    host: probe.host,
    device_id: deviceId,
    calls: probe.calls.map((call) => ({
      name: call.name,
      ok: call.ok,
      duration_ms: call.durationMs
    }))
  };
}

function serializeAccessCodeProbe(probe: DirectAccessCodeProbeResult, kind: "email" | "phone", target: string) {
  return {
    ok: probe.ok,
    host: probe.host,
    dt_user_id: probe.dtUserId,
    device_id: probe.deviceId,
    kind,
    target: redactAccessCodeTarget(kind, target),
    capability: {
      mode: probe.capability.mode,
      verified_calls: [...probe.capability.verifiedCalls],
      login_token_completed: probe.capability.loginTokenCompleted,
      requires_external_capture_for_login_token: probe.capability.requiresExternalCaptureForLoginToken,
      note: probe.capability.note
    },
    recover_password: serializeDirectProbeCall(probe.recoverPassword),
    verify_access_code: serializeDirectProbeCall(probe.verifyAccessCode),
    trace: probe.trace?.map((frame) => ({
      received_at: frame.receivedAt,
      frame_type: frame.frameType,
      status: frame.status,
      route_hex: frame.routeHex,
      raw_length: frame.rawLength,
      body_length: frame.bodyLength,
      raw_hex_preview: frame.rawHexPreview,
      body_hex_preview: frame.bodyHexPreview,
      json_payload: frame.jsonPayload ?? null
    })) ?? []
  };
}

function inferAccessCodeKind(account: { loginType: string; email?: string | null; phone?: string | null }): "email" | "phone" {
  if (account.loginType === "email_code" || account.loginType === "email_password") {
    return "email";
  }
  if (account.loginType === "phone_code" || account.loginType === "phone_password") {
    return "phone";
  }
  return account.phone ? "phone" : "email";
}

export function requiresAccessCodeProbeConfirm(input: { dry_run?: boolean; confirm?: boolean }) {
  return input.dry_run === false && input.confirm !== true;
}

export function requiresPhoneCancelConfirm(input: { confirm?: boolean }) {
  return input.confirm !== true;
}

export function requiresPhoneRenewConfirm(input: { confirm?: boolean }) {
  return input.confirm !== true;
}

export function requiresPhonePauseConfirm(input: { confirm?: boolean }) {
  return input.confirm !== true;
}

export function requiresPhoneResumeConfirm(input: { confirm?: boolean }) {
  return input.confirm !== true;
}

export function requiresPhonePurchaseConfirm(input: { confirm?: boolean }) {
  return input.confirm !== true;
}

export function assertPhoneCountrySelection(input: {
  country_code?: number;
  iso_country_code?: string;
  country_key?: string;
}) {
  const key = normalizeOptionalString(input.country_key)?.toUpperCase();
  if (!key) {
    return;
  }
  const selected = PHONE_COUNTRY_SELECTIONS[key];
  if (!selected) {
    throw new AppError(`Unsupported phone country_key: ${key}`, 400, 400);
  }
  if (input.country_code !== undefined && input.country_code !== selected.countryCode) {
    throw new AppError(`country_code ${input.country_code} does not match country_key ${key}`, 400, 400);
  }
  const iso = normalizeOptionalString(input.iso_country_code)?.toUpperCase();
  if (iso && iso !== selected.isoCountryCode) {
    throw new AppError(`iso_country_code ${iso} does not match country_key ${key}`, 400, 400);
  }
}

function serializeDirectProbeCall(call: DirectAccessCodeProbeResult["recoverPassword"]) {
  if (!call) {
    return null;
  }
  return {
    name: call.name,
    ok: call.ok,
    duration_ms: call.durationMs,
    payload: call.payload ?? null,
    error: call.error ?? null,
    frames: call.frames?.map((frame) => ({
      received_at: frame.receivedAt,
      frame_type: frame.frameType,
      status: frame.status,
      route_hex: frame.routeHex,
      raw_length: frame.rawLength,
      body_length: frame.bodyLength,
      json_payload: frame.jsonPayload ?? null
    })) ?? []
  };
}

function redactAccessCodeTarget(kind: "email" | "phone", target: string) {
  if (kind === "email") {
    const [name = "", domain = ""] = target.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return target.replace(/(\d{2})\d+(\d{2})$/, "$1***$2");
}

function redactPhoneForLog(phoneNumber: string) {
  return phoneNumber.replace(/(\d{3})\d+(\d{2})$/, "$1***$2");
}

async function tryRefreshValidatedAccountData(accountId: number, timeoutMs = 12_000) {
  try {
    return {
      snapshot: (await Promise.race([refreshAccountRuntimeData(accountId, directRefreshGateway), delayResult<null>(timeoutMs, null)]))?.snapshot ?? null,
      error: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Validated session refresh failed after successful direct probe", { accountId, error: message });
    return {
      snapshot: null,
      error: message
    };
  }
}

async function tryHydrateImportedAccountFromHelper(accountId: number) {
  try {
    await Promise.race([refreshAccountRuntimeData(accountId, helperRefreshGateway), delayResult<null>(6_000, null)]);
  } catch (error) {
    logger.warn("Helper-backed snapshot hydration failed after session import", {
      accountId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  try {
    const account = await prisma.dtAccount.findUnique({ where: { id: accountId }, select: { appVariant: true } });
    const rows = await dumpHelperSmsMessages(50, account?.appVariant ?? "dingtone");
    await storeHelperSmsMessages(accountId, rows);
  } catch (error) {
    logger.warn("Helper-backed SMS hydration failed after session import", {
      accountId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function persistAuthenticatedSession(
  accountId: number,
  session: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
  }
) {
  await prisma.dtAccount.update({
    where: { id: accountId },
    data: {
      dtUserId: session.dtUserId,
      dtToken: encryptText(session.token),
      ...(session.deviceId ? { dtDeviceId: session.deviceId } : {}),
      lastLoginAt: new Date(),
      status: AccountStatus.offline,
      lastError: null
    }
  });

  await mergeDuplicateAccounts(accountId);
  return accountId;
}

async function mergeDuplicateAccounts(accountId: number) {
  const target = assertFound(
    await prisma.dtAccount.findUnique({
      where: { id: accountId }
    }),
    "Account not found"
  );
  const dtUserId = normalizeOptionalString(target.dtUserId);
  if (!dtUserId) {
    return;
  }

  const duplicates = await prisma.dtAccount.findMany({
    where: {
      adminId: target.adminId,
      dtUserId,
      NOT: { id: accountId }
    }
  });

  for (const duplicate of duplicates) {
    await mergeDuplicateAccountData(accountId, duplicate.id);
  }
}

async function mergeDuplicateAccountData(targetAccountId: number, duplicateAccountId: number) {
  if (targetAccountId === duplicateAccountId) {
    return;
  }

  const duplicate = assertFound(
    await prisma.dtAccount.findUnique({
      where: { id: duplicateAccountId }
    }),
    "Duplicate account not found"
  );

  accountMonitorService.transferHeartbeat(duplicateAccountId, targetAccountId);

  const duplicatePhones = await prisma.phoneNumber.findMany({
    where: { accountId: duplicateAccountId }
  });
  for (const phone of duplicatePhones) {
    await prisma.phoneNumber.upsert({
      where: {
        accountId_phoneNumber: {
          accountId: targetAccountId,
          phoneNumber: phone.phoneNumber
        }
      },
      update: mapStoredPhoneNumber(phone),
      create: {
        accountId: targetAccountId,
        phoneNumber: phone.phoneNumber,
        ...mapStoredPhoneNumber(phone)
      }
    });
  }

  await prisma.message.updateMany({
    where: { accountId: duplicateAccountId },
    data: { accountId: targetAccountId }
  });
  await prisma.monitorSession.updateMany({
    where: { accountId: duplicateAccountId },
    data: { accountId: targetAccountId }
  });
  const duplicateSnapshot = await prisma.accountSnapshot.findUnique({
    where: { accountId: duplicateAccountId }
  });
  const targetSnapshot = await prisma.accountSnapshot.findUnique({
    where: { accountId: targetAccountId }
  });
  if (duplicateSnapshot && !targetSnapshot) {
    await prisma.accountSnapshot.upsert({
      where: { accountId: targetAccountId },
      update: mapStoredSnapshot(duplicateSnapshot),
      create: {
        accountId: targetAccountId,
        ...mapStoredSnapshot(duplicateSnapshot)
      }
    });
  }

  const currentTarget = assertFound(
    await prisma.dtAccount.findUnique({
      where: { id: targetAccountId }
    }),
    "Target account not found"
  );
  await prisma.dtAccount.update({
    where: { id: targetAccountId },
    data: {
      monitorEnabled: currentTarget.monitorEnabled || duplicate.monitorEnabled,
      telegramNotify: currentTarget.telegramNotify || duplicate.telegramNotify,
      proxyEnabled: currentTarget.proxyEnabled || duplicate.proxyEnabled,
      lastLoginAt:
        currentTarget.lastLoginAt && duplicate.lastLoginAt
          ? currentTarget.lastLoginAt >= duplicate.lastLoginAt
            ? currentTarget.lastLoginAt
            : duplicate.lastLoginAt
          : currentTarget.lastLoginAt ?? duplicate.lastLoginAt,
      status: chooseMergedAccountStatus(currentTarget.status, duplicate.status),
      lastError: currentTarget.lastError ?? duplicate.lastError,
      nickname: normalizeOptionalString(currentTarget.nickname) ?? normalizeOptionalString(duplicate.nickname) ?? currentTarget.nickname
    }
  });

  await prisma.dtAccount.delete({
    where: { id: duplicateAccountId }
  });
}

async function findExistingAccount(adminId: number, appVariant: AppVariant, email: string | null, phone: string | null) {
  if (email) {
    return prisma.dtAccount.findFirst({
      where: { adminId, appVariant, email }
    });
  }
  if (phone) {
    return prisma.dtAccount.findFirst({
      where: { adminId, appVariant, phone }
    });
  }
  return null;
}

async function previewPhoneNumbers(accountId: number, payload: unknown) {
  const body = requestPhoneSchema.parse(payload ?? {});
  assertPhoneCountrySelection(body);
  const account = await assertAccount(accountId);
  if (await shouldUseDirectAccountFlow(account)) {
    return directRefreshGateway.requestPhoneNumber(
      {
        dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
        token: requireString(decryptText(account.dtToken), "Missing dt_token"),
        deviceId: account.dtDeviceId
      },
      { countryCode: body.country_code, isoCountryCode: body.iso_country_code, countryKey: body.country_key, areaCode: body.area_code }
    );
  }
  try {
    const helperPreview = normalizeHelperPhonePreview(
      await helperRefreshGateway.requestPhoneNumber(
        {
          dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
          token: requireString(decryptText(account.dtToken), "Missing dt_token"),
          deviceId: normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType),
          appVariant: account.appVariant
        },
        { countryCode: body.country_code, isoCountryCode: body.iso_country_code, countryKey: body.country_key, areaCode: body.area_code }
      )
    );
    if (helperPreview.candidates.length > 0 || helperPreview.freeChance !== undefined) {
      return helperPreview;
    }
    throw new Error("Helper preview returned no candidates");
  } catch (primaryError) {
    let lastFallbackError: unknown = null;
    try {
      const adbPreview = await previewPhoneNumbersFromAdb(body.country_code ?? 1, body.iso_country_code ?? body.country_key, account.appVariant);
      logger.warn("ADB preview fallback result", {
        accountId,
        countryCode: body.country_code ?? 1,
        candidateCount: adbPreview.candidates.length
      });
      return adbPreview;
    } catch (adbError) {
      lastFallbackError = adbError;
      logger.warn("ADB preview fallback failed", {
        accountId,
        countryCode: body.country_code ?? 1,
        error: adbError instanceof Error ? adbError.message : String(adbError)
      });
    }
    try {
      const raw = await getCachedPrivateNumberEvent();
      return normalizeHelperPhonePreview(raw);
    } catch (cachedError) {
      if (lastFallbackError instanceof Error) {
        throw lastFallbackError;
      }
      if (cachedError instanceof Error) {
        throw cachedError;
      }
      if (primaryError instanceof Error) {
        throw primaryError;
      }
      throw new Error(String(cachedError));
    }
  }
}

async function syncPhoneNumbersFromRemote(accountId: number) {
  const account = await assertAccount(accountId);
  const directAccount = {
    dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
    token: requireString(decryptText(account.dtToken), "Missing dt_token"),
    deviceId: account.dtDeviceId
  };
  const phoneNumbers = (await shouldUseDirectAccountFlow(account))
    ? await directRefreshGateway.listPhoneNumbers(directAccount)
    : await executeHelperAction("list_phone_numbers", { appVariant: account.appVariant }, 35_000)
        .then((raw) => normalizeHelperPhoneNumbers(raw))
        .catch(async () => {
          return listPhoneNumbersFromAdb(account.appVariant).catch(async () => {
            return dingtoneGateway.listPhoneNumbers(directAccount);
          });
        });
  await syncPhoneNumbers(accountId, phoneNumbers);
  return prisma.phoneNumber.findMany({
    where: { accountId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }]
  });
}

async function verifyDirectPhoneAction(
  account: {
    id: number;
    dtUserId: string | null;
    dtToken: string | null;
    dtDeviceId: string | null;
  },
  phoneItem: {
    phoneNumber: string;
  },
  expectedStatus: PhoneStatus | null
): Promise<Partial<DingtonePhoneNumber>> {
  const directAccount = {
    dtUserId: requireString(account.dtUserId, "Missing dt_user_id"),
    token: requireString(decryptText(account.dtToken), "Missing dt_token"),
    deviceId: account.dtDeviceId
  };
  const target = normalizePhoneDigits(phoneItem.phoneNumber);
  let lastError: unknown;

  for (const waitMs of [0, 1_500, 3_000, 5_000]) {
    if (waitMs > 0) {
      await delayResult(waitMs, null);
    }

    try {
      const remotePhones = await directRefreshGateway.listPhoneNumbers(directAccount);
      const matched = remotePhones.find((item) => normalizePhoneDigits(item.phoneNumber) === target);

      if (expectedStatus === PhoneStatus.cancelled) {
        if (matched && matched.status !== "cancelled") {
          lastError = new AppError("Remote verification failed: phone number is still present and not cancelled.", 502, 502);
          continue;
        }
        return { status: "cancelled" };
      }

      if (!matched) {
        lastError = new AppError("Remote verification failed: phone number was not found after action.", 502, 502);
        continue;
      }
      if (expectedStatus && matched.status !== expectedStatus) {
        lastError = new AppError(`Remote verification failed: expected ${expectedStatus}, got ${matched.status ?? "unknown"}.`, 502, 502);
        continue;
      }
      return matched;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof AppError) {
    throw lastError;
  }
  throw new AppError(
    `Remote verification failed: ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")}`,
    502,
    502
  );
}

function phoneActionResponse(
  phone: StoredPhoneNumber,
  action: "renew" | "cancel" | "pause" | "resume",
  useDirect: boolean,
  verified: Partial<DingtonePhoneNumber>
) {
  const serialized = serializePhoneNumber(phone);
  return {
    phone: serialized,
    verification: {
      source: useDirect ? "remote_phone_list" : "helper_action_response",
      confirmed: useDirect,
      action,
      phone_number: serialized.phone_number,
      status: serialized.status,
      note: useDirect
        ? phoneActionVerificationNote(action, verified)
        : "Helper mode action result was written without direct remote-list confirmation."
    }
  };
}

async function sendPhoneActionTelegramNotification(
  account: {
    id: number;
    nickname: string | null;
    email: string | null;
    phone: string | null;
    dtUserId: string | null;
    telegramNotify: boolean;
  },
  phone: StoredPhoneNumber,
  action: "renew" | "cancel" | "pause" | "resume",
  verification: { source: string; note?: string | null }
) {
  await sendPhoneTelegramNotification({
    account,
    phone: mapStoredPhoneContext(phone),
    action,
    verificationSource: verification.source,
    verificationNote: verification.note
  }).catch((error) => {
    logger.warn("Failed to send Telegram notification for phone action", {
      accountId: account.id,
      phoneNumber: phone.phoneNumber,
      action,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function phoneActionVerificationNote(action: "renew" | "cancel" | "pause" | "resume", verified: Partial<DingtonePhoneNumber>) {
  if (action === "cancel") {
    return "Action was confirmed by polling the remote purchased phone list until the number disappeared or returned cancelled.";
  }
  if (action === "renew") {
    return "Action was confirmed by polling the remote purchased phone list and merging the returned phone record.";
  }
  return `Action was confirmed by polling the remote purchased phone list until status became ${verified.status ?? "expected"}.`;
}

function normalizePhoneDigits(value: string) {
  return value.replace(/[^\d]/g, "");
}

async function confirmPurchasedPhone(
  account: { dtUserId: string; token: string; deviceId?: string | null },
  phone: DingtonePhoneNumber,
  appVariant: AppVariant
): Promise<PurchaseConfirmation> {
  const target = normalizePhoneDigits(phone.phoneNumber);
  if (!target) {
    throw new AppError("Purchase did not return a phone number to verify.", 502, 502);
  }

  let lastError: unknown;
  const lastSeenRemotePhones: string[] = [];
  for (const waitMs of [0, 1_500, 3_500, 6_000, 10_000]) {
    if (waitMs > 0) {
      await delayResult(waitMs, null);
    }

    try {
      const remotePhones = await directRefreshGateway.listPhoneNumbers(account);
      lastSeenRemotePhones.splice(
        0,
        lastSeenRemotePhones.length,
        ...remotePhones.map((item) => item.phoneNumber).filter(Boolean).slice(0, 8)
      );
      const matched = remotePhones.find((item) => normalizePhoneDigits(item.phoneNumber) === target);
      if (matched) {
        return {
          phone: {
            ...phone,
            ...matched,
            rawJson: matched.rawJson ?? phone.rawJson
          },
          source: "remote_phone_list",
          confirmed: true,
          note: "Purchase was confirmed by polling the remote purchased phone list before writing local data."
        };
      }
      lastError = new AppError("Purchased phone was not present in the remote phone list yet.", 502, 502);
    } catch (error) {
      lastError = error;
    }
  }

  try {
    const adbPhones = await listPhoneNumbersFromAdb(appVariant);
    const matched = adbPhones.find((item) => normalizePhoneDigits(item.phoneNumber) === target);
    if (matched) {
      return {
        phone: {
          ...phone,
          ...matched,
          rawJson: matched.rawJson ?? phone.rawJson
        },
        source: "adb_phone_db",
        confirmed: true,
        note: `Purchase was not visible in the direct remote list during the confirmation window, but the matching ${describeAccountVariant(appVariant)} app database contains it.`
      };
    }
  } catch (error) {
    lastError = error;
  }

  const lastSeen = lastSeenRemotePhones.length
    ? ` Last remote-list sample: ${lastSeenRemotePhones.map(redactPhoneForLog).join(", ")}.`
    : "";
  throw new AppError(
    `Purchase was not confirmed by the remote phone list; local data was not changed. ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "")
    }${lastSeen}`,
    502,
    502
  );
}

async function importSessionAccount(
  adminId: number,
  item: z.infer<typeof sessionImportAccountSchema>,
  validateSession: boolean
) {
  const importedPackageVariant = inferAppVariantFromPackageName(item.package_name);
  const deviceVariant = inferAppVariantFromDeviceId(item.device_id);
  if (importedPackageVariant && item.app_variant && importedPackageVariant !== item.app_variant) {
    throw new AppError(
      `Imported session package ${item.package_name} belongs to ${describeAccountVariant(importedPackageVariant)}, but the file marks it as ${describeAccountVariant(item.app_variant)}.`,
      409,
      409
    );
  }
  if (deviceVariant && item.app_variant && deviceVariant !== item.app_variant) {
    throw new AppError(
      `Imported session device_id looks like ${describeAccountVariant(deviceVariant)}, but the file marks it as ${describeAccountVariant(item.app_variant)}.`,
      409,
      409
    );
  }
  if (deviceVariant && importedPackageVariant && deviceVariant !== importedPackageVariant) {
    throw new AppError(
      `Imported session package ${item.package_name} belongs to ${describeAccountVariant(importedPackageVariant)}, but device_id looks like ${describeAccountVariant(deviceVariant)}.`,
      409,
      409
    );
  }

  const existingByUserIdAccounts = await prisma.dtAccount.findMany({
    where: {
      adminId,
      dtUserId: item.dt_user_id
    },
    orderBy: { id: "asc" }
  });
  const inferredAppVariant = importedPackageVariant ?? item.app_variant ?? deviceVariant ?? existingByUserIdAccounts[0]?.appVariant ?? AppVariant.dingtone;
  const existingByUserId =
    existingByUserIdAccounts.find((account) => account.appVariant === inferredAppVariant) ??
    existingByUserIdAccounts[0] ??
    null;
  const resolvedAppVariant = inferredAppVariant;

  const existing =
    existingByUserId ??
    (await findExistingAccount(adminId, resolvedAppVariant, item.email ?? null, item.phone ?? null));

  const account = existing
    ? await prisma.dtAccount.update({
        where: { id: existing.id },
        data: {
          nickname: normalizeOptionalString(item.nickname) ?? existing.nickname,
          appVariant: resolvedAppVariant,
          loginType: item.login_type,
          email: item.email ?? existing.email,
          phone: item.phone ?? existing.phone,
          dtUserId: item.dt_user_id,
          dtToken: encryptText(item.token),
          dtDeviceId: item.device_id,
          telegramNotify: item.telegram_notify,
          proxyEnabled: item.proxy_enabled,
          status: AccountStatus.offline,
          lastLoginAt: new Date(),
          lastError: null
        }
      })
    : await prisma.dtAccount.create({
        data: {
          adminId,
          nickname:
            normalizeOptionalString(item.nickname) ??
            normalizeOptionalString(item.email) ??
            normalizeOptionalString(item.phone) ??
            item.dt_user_id,
          appVariant: resolvedAppVariant,
          loginType: item.login_type,
          email: item.email ?? null,
          phone: item.phone ?? null,
          password: null,
          dtUserId: item.dt_user_id,
          dtToken: encryptText(item.token),
          dtDeviceId: item.device_id,
          dtTrackCode: createTrackCode(),
          telegramNotify: item.telegram_notify,
          proxyEnabled: item.proxy_enabled,
          status: AccountStatus.offline,
          lastLoginAt: new Date()
        }
      });

  if (item.snapshot) {
    const snapshot = normalizeImportedSnapshot(item.snapshot);
    const previousSnapshot = await prisma.accountSnapshot.findUnique({ where: { accountId: account.id } });
    await prisma.accountSnapshot.upsert({
      where: { accountId: account.id },
      update: mapSnapshot(snapshot, previousSnapshot),
      create: {
        accountId: account.id,
        ...mapSnapshot(snapshot, previousSnapshot)
      }
    });
  }

  const phoneNumbers = item.phone_numbers.map((phone) => normalizeHelperPhoneNumber(phone)).filter((phone) => Boolean(phone.phoneNumber));
  if (phoneNumbers.length > 0) {
    await syncPhoneNumbers(account.id, phoneNumbers);
  }

  if (validateSession) {
    const validation = await tryValidateCapturedSessionQuickly(
      {
        id: account.id,
        appVariant: resolvedAppVariant,
        dtDeviceId: item.device_id,
        email: item.email ?? null,
        phone: item.phone ?? null
      },
      {
        dtUserId: item.dt_user_id,
        token: item.token,
        deviceId: item.device_id,
        appVariant: resolvedAppVariant,
        packageName: item.package_name ?? undefined
      }
    );
    if (!validation) {
      await prisma.dtAccount.update({
        where: { id: account.id },
        data: {
          lastError: "Imported session was saved, but direct validation did not complete."
        }
      });
    }
  }

  await mergeDuplicateAccounts(account.id);
  return account.id;
}

async function importFullBackupAccount(adminId: number, item: Record<string, unknown>, validateSession: boolean) {
  const dtUserId = normalizeOptionalString(item.dt_user_id);
  const deviceId = normalizeOptionalString(item.device_id) ?? createDeviceId();
  const importedPackageVariant = inferAppVariantFromPackageName(normalizeOptionalString(item.package_name));
  const deviceVariant = inferAppVariantFromDeviceId(deviceId);
  const explicitVariant = normalizeAppVariantValue(item.app_variant);
  if (explicitVariant && importedPackageVariant && explicitVariant !== importedPackageVariant) {
    throw new AppError("Backup account app_variant does not match package_name.", 409, 409);
  }
  const requestedAppVariant = importedPackageVariant ?? explicitVariant ?? deviceVariant;
  if (deviceVariant && requestedAppVariant && requestedAppVariant !== deviceVariant) {
    throw new AppError("Backup account device_id does not match app_variant.", 409, 409);
  }

  const incomingEmail = normalizeOptionalString(item.email);
  const incomingPhone = normalizeOptionalString(item.phone);
  const existingByUserIdAccounts = dtUserId
    ? await prisma.dtAccount.findMany({ where: { adminId, dtUserId }, orderBy: { id: "asc" } })
    : [];
  const appVariant = requestedAppVariant ?? existingByUserIdAccounts[0]?.appVariant ?? AppVariant.dingtone;
  const existing = dtUserId
    ? existingByUserIdAccounts.find((account) => account.appVariant === appVariant) ?? existingByUserIdAccounts[0] ?? null
    : await findExistingAccount(adminId, appVariant, incomingEmail, incomingPhone);
  const token = normalizeOptionalString(item.token ?? item.dt_token);
  const password = normalizeOptionalString(item.password);
  const loginType = normalizeLoginTypeValue(item.login_type);
  const status = normalizeAccountStatusValue(item.status);
  const incomingTrackCode = normalizeOptionalString(item.track_code);
  const incomingLastLoginAt = normalizeBackupDate(item.last_login_at);
  const incomingLastError = normalizeOptionalString(item.last_error);
  const accountData = {
    nickname:
      normalizeOptionalString(item.nickname) ??
      incomingEmail ??
      incomingPhone ??
      dtUserId ??
      existing?.nickname ??
      "imported-account",
    appVariant,
    loginType,
    email: incomingEmail ?? existing?.email ?? null,
    phone: incomingPhone ?? existing?.phone ?? null,
    password: password ? encryptText(password) : existing?.password ?? null,
    dtUserId,
    dtToken: token ? encryptText(token) : existing?.dtToken ?? null,
    dtDeviceId: deviceId,
    dtTrackCode: incomingTrackCode ?? existing?.dtTrackCode ?? createTrackCode(),
    status,
    monitorEnabled: Boolean(item.monitor_enabled),
    telegramNotify: Boolean(item.telegram_notify),
    proxyEnabled: Boolean(item.proxy_enabled),
    lastLoginAt: incomingLastLoginAt ?? existing?.lastLoginAt ?? null,
    lastError: incomingLastError ?? existing?.lastError ?? null
  };

  const account = existing
    ? await prisma.dtAccount.update({
        where: { id: existing.id },
        data: accountData
      })
    : await prisma.dtAccount.create({
        data: {
          adminId,
          ...accountData
        }
      });

  const snapshot = normalizeBackupSnapshot(item.snapshot);
  if (snapshot) {
    const previousSnapshot = await prisma.accountSnapshot.findUnique({ where: { accountId: account.id } });
    await prisma.accountSnapshot.upsert({
      where: { accountId: account.id },
      update: mapSnapshot(snapshot, previousSnapshot),
      create: {
        accountId: account.id,
        ...mapSnapshot(snapshot, previousSnapshot)
      }
    });
  }

  let phoneImported = 0;
  for (const rawPhone of Array.isArray(item.phone_numbers) ? item.phone_numbers : []) {
    const phone = normalizeBackupPhoneNumber(rawPhone);
    if (!phone) {
      continue;
    }
    await prisma.phoneNumber.upsert({
      where: {
        accountId_phoneNumber: {
          accountId: account.id,
          phoneNumber: phone.phoneNumber
        }
      },
      update: mapPhoneNumberBase(phone),
      create: mapPhoneNumberCreate(account.id, phone)
    });
    phoneImported += 1;
  }

  let messageImported = 0;
  for (const rawMessage of Array.isArray(item.messages) ? item.messages : []) {
    const message = normalizeBackupMessage(rawMessage);
    if (!message) {
      continue;
    }
    const duplicate = await prisma.message.findFirst({
      where: {
        accountId: account.id,
        direction: message.direction,
        fromNumber: message.fromNumber,
        toNumber: message.toNumber,
        content: message.content,
        receivedAt: message.receivedAt
      },
      select: { id: true }
    });
    if (duplicate) {
      continue;
    }
    await prisma.message.create({
      data: {
        accountId: account.id,
        ...message
      }
    });
    messageImported += 1;
  }

  if (validateSession && dtUserId && token) {
    await tryValidateCapturedSessionQuickly(
      {
        id: account.id,
        appVariant,
        dtDeviceId: deviceId,
        email: account.email,
        phone: account.phone
      },
      {
        dtUserId,
        token,
        deviceId,
        appVariant,
        packageName: expectedPackageNameForVariant(appVariant)
      }
    );
  }

  await mergeDuplicateAccounts(account.id);

  return {
    account_id: account.id,
    dt_user_id: dtUserId,
    nickname: account.nickname,
    phones_imported: phoneImported,
    messages_imported: messageImported
  };
}

function normalizeAppVariantValue(value: unknown): AppVariant | null {
  if (value === AppVariant.dingtone || value === "talku" || value === "talkyou") {
    return AppVariant.dingtone;
  }
  if (value === AppVariant.dingdong) {
    return AppVariant.dingdong;
  }
  return null;
}

function normalizeLoginTypeValue(value: unknown): LoginType {
  const allowed = new Set(Object.values(LoginType));
  return typeof value === "string" && allowed.has(value as LoginType) ? (value as LoginType) : LoginType.manual_session;
}

function normalizeAccountStatusValue(value: unknown): AccountStatus {
  const allowed = new Set(Object.values(AccountStatus));
  return typeof value === "string" && allowed.has(value as AccountStatus) ? (value as AccountStatus) : AccountStatus.offline;
}

function normalizeBackupSnapshot(value: unknown): DingtoneSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    dtDingtoneId: normalizeOptionalString(value.dtDingtoneId ?? value.dt_dingtone_id) ?? undefined,
    fullName: normalizeOptionalString(value.fullName ?? value.full_name) ?? undefined,
    avatarUrl: normalizeOptionalString(value.avatarUrl ?? value.avatar_url) ?? undefined,
    gender: pickNumber(value, ["gender"]) ?? undefined,
    birthday: normalizeOptionalString(value.birthday) ?? undefined,
    email: normalizeOptionalString(value.email) ?? undefined,
    phone: normalizeOptionalString(value.phone) ?? undefined,
    aboutMe: normalizeOptionalString(value.aboutMe ?? value.about_me) ?? undefined,
    feeling: normalizeOptionalString(value.feeling) ?? undefined,
    company: normalizeOptionalString(value.company) ?? undefined,
    school: normalizeOptionalString(value.school) ?? undefined,
    country: normalizeOptionalString(value.country) ?? undefined,
    state: normalizeOptionalString(value.state) ?? undefined,
    city: normalizeOptionalString(value.city) ?? undefined,
    primaryBalance: pickNumber(value, ["primaryBalance", "primary_balance"]) ?? undefined,
    userGrade: pickNumber(value, ["userGrade", "user_grade"]) ?? undefined,
    validPoint: pickNumber(value, ["validPoint", "valid_point"]) ?? undefined,
    progressPoint: pickNumber(value, ["progressPoint", "progress_point"]) ?? undefined,
    membershipType: normalizeOptionalString(value.membershipType ?? value.membership_type) ?? undefined,
    membershipExpireAt: normalizeBackupDate(value.membershipExpireAt ?? value.membership_expire_at) ?? undefined,
    profileVerCode: normalizeOptionalString(value.profileVerCode ?? value.profile_ver_code) ?? undefined,
    rawJson: normalizeOptionalString(value.rawJson ?? value.raw_json) ?? safeJsonStringify(value)
  };
}

function normalizeBackupPhoneNumber(value: unknown): DingtonePhoneNumber | null {
  if (!isRecord(value)) {
    return null;
  }
  const phoneNumber = normalizeOptionalString(value.phone_number ?? value.phoneNumber);
  if (!phoneNumber) {
    return null;
  }
  return {
    phoneNumber,
    countryCode: pickNumber(value, ["countryCode", "country_code"]) ?? undefined,
    providerId: pickNumber(value, ["providerId", "provider_id"]) ?? undefined,
    displayName: normalizeOptionalString(value.displayName ?? value.display_name) ?? undefined,
    status: normalizePhoneStatusValue(value.status),
    purchaseType: pickNumber(value, ["purchaseType", "purchase_type"]) ?? undefined,
    payType: pickNumber(value, ["payType", "pay_type"]) ?? undefined,
    validPeriodDays: pickNumber(value, ["validPeriodDays", "valid_period_days"]) ?? undefined,
    gainTime: normalizeOptionalString(value.gainTime ?? value.gain_time) ?? undefined,
    expiredTime: normalizeOptionalString(value.expiredTime ?? value.expired_time) ?? undefined,
    autoRenew: Boolean(value.autoRenew ?? value.auto_renew),
    isPrimary: Boolean(value.isPrimary ?? value.is_primary),
    isGoodNumber: Boolean(value.isGoodNumber ?? value.is_good_number),
    portoutInfo: normalizeOptionalString(value.portoutInfo ?? value.portout_info) ?? undefined,
    rawJson: normalizeOptionalString(value.rawJson ?? value.raw_json) ?? safeJsonStringify(value)
  };
}

function normalizePhoneStatusValue(value: unknown): PhoneStatus {
  const allowed = new Set(Object.values(PhoneStatus));
  return typeof value === "string" && allowed.has(value as PhoneStatus) ? (value as PhoneStatus) : PhoneStatus.active;
}

function normalizeBackupMessage(value: unknown): Prisma.MessageUncheckedCreateWithoutAccountInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const content = normalizeOptionalString(value.content);
  if (!content) {
    return null;
  }
  const direction = value.direction === "outgoing" ? MessageDirection.outgoing : MessageDirection.incoming;
  const msgType = normalizeMessageTypeValue(value.msg_type ?? value.msgType);
  return {
    direction,
    msgType,
    fromNumber: normalizeOptionalString(value.from_number ?? value.fromNumber),
    toNumber: normalizeOptionalString(value.to_number ?? value.toNumber),
    content,
    rawInfo: normalizeOptionalString(value.raw_info ?? value.rawInfo),
    rawK3: normalizeOptionalString(value.raw_k3 ?? value.rawK3),
    k5Flag: pickNumber(value, ["k5Flag", "k5_flag"]) ?? undefined,
    isRead: Boolean(value.is_read ?? value.isRead),
    telegramSent: Boolean(value.telegram_sent ?? value.telegramSent),
    telegramMsgId: normalizeOptionalString(value.telegram_msg_id ?? value.telegramMsgId),
    receivedAt: normalizeBackupDate(value.received_at ?? value.receivedAt) ?? new Date(),
    createdAt: normalizeBackupDate(value.created_at ?? value.createdAt) ?? new Date()
  };
}

function normalizeMessageTypeValue(value: unknown): MessageType {
  const allowed = new Set(Object.values(MessageType));
  return typeof value === "string" && allowed.has(value as MessageType) ? (value as MessageType) : MessageType.sms;
}

function normalizeBackupDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
}

async function exportSessionSettings() {
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: [...SESSION_EXPORT_SETTING_KEYS]
      }
    }
  });
  const values = new Map(rows.map((item) => [item.key, item.value]));
  return Object.fromEntries(
    SESSION_EXPORT_SETTING_KEYS.map((key) => [key, values.get(key) ?? ""]).filter(([, value]) => String(value).trim())
  );
}

async function importSessionSettings(settings: Record<string, string>) {
  let imported = 0;
  for (const key of SESSION_EXPORT_SETTING_KEYS) {
    const value = normalizeOptionalString(settings[key]);
    if (value === null) {
      continue;
    }
    await prisma.setting.upsert({
      where: { key },
      update: { value },
      create: {
        key,
        value,
        description: "Imported with session migration package"
      }
    });
    imported += 1;
  }
  return imported;
}

function normalizeImportedSnapshot(value: unknown): DingtoneSnapshot {
  const record = isRecord(value) ? value : {};
  const rawJson = pickString(record, ["raw_json", "rawJson"]);
  return {
    dtDingtoneId: pickString(record, ["dt_dingtone_id", "dtDingtoneId"]) ?? undefined,
    fullName: pickString(record, ["full_name", "fullName"]) ?? undefined,
    avatarUrl: pickString(record, ["avatar_url", "avatarUrl"]) ?? undefined,
    gender: pickNumber(record, ["gender"]) ?? undefined,
    birthday: pickString(record, ["birthday"]) ?? undefined,
    email: pickString(record, ["email"]) ?? undefined,
    phone: pickString(record, ["phone"]) ?? undefined,
    aboutMe: pickString(record, ["about_me", "aboutMe"]) ?? undefined,
    feeling: pickString(record, ["feeling"]) ?? undefined,
    company: pickString(record, ["company"]) ?? undefined,
    school: pickString(record, ["school"]) ?? undefined,
    country: pickString(record, ["country"]) ?? undefined,
    state: pickString(record, ["state"]) ?? undefined,
    city: pickString(record, ["city"]) ?? undefined,
    primaryBalance: pickNumber(record, ["primary_balance", "primaryBalance"]) ?? undefined,
    userGrade: pickNumber(record, ["user_grade", "userGrade"]) ?? undefined,
    validPoint: pickNumber(record, ["valid_point", "validPoint"]) ?? undefined,
    progressPoint: pickNumber(record, ["progress_point", "progressPoint"]) ?? undefined,
    membershipType: pickString(record, ["membership_type", "membershipType"]) ?? undefined,
    membershipExpireAt: pickDate(record, ["membership_expire_at", "membershipExpireAt"]) ?? undefined,
    profileVerCode: pickString(record, ["profile_ver_code", "profileVerCode"]) ?? undefined,
    rawJson: rawJson ?? safeJsonStringify(value)
  };
}

async function refreshMessagesFromRemote(accountId: number, limit: number, directOnly = false) {
  const diagnostics: RefreshMessagesDiagnostics[] = [];
  const account = await assertAccount(accountId);
  const useDirectFlow = await shouldUseDirectAccountFlow(account);
  if (directOnly && useDirectFlow) {
    const activeMonitorDiagnostics = await buildActiveMonitorRefreshDiagnostics(accountId);
    if (activeMonitorDiagnostics) {
      diagnostics.push(activeMonitorDiagnostics);
      diagnostics.push({
        source: "server-only",
        scanned: 0,
        imported: 0,
        sampleSender: null,
        sampleContent: "后台 direct 监听正在运行；本次手动刷新未新开 direct 连接，避免抢占实时短信监听。",
        sampleReceivedAt: new Date().toISOString()
      });
      return { imported: 0, diagnostics };
    }
  }

  const pausedMonitor = useDirectFlow && !directOnly ? await pauseMonitorForManualMessageRefresh(account).catch(() => false) : false;

  try {
    if (useDirectFlow && account.dtUserId && account.dtToken) {
    const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
    const directWaitSeconds = parsePositiveIntSetting(settings.direct_message_refresh_wait_seconds, 12);
    const pushes = await listenDirectSessionPushes({
      account: {
        dtUserId: account.dtUserId,
        token: decryptText(account.dtToken) ?? "",
        deviceId: normalizeVerificationDeviceId(account.dtDeviceId, account.appVariant, account.loginType),
        email: account.email,
        phone: account.phone
      },
      listenSeconds: Math.max(5, Math.min(20, directWaitSeconds)),
      maxPushFrames: Math.max(12, Math.min(50, limit))
    }).catch((error) => {
      diagnostics.push({
        source: "direct-push",
        scanned: 0,
        imported: 0,
        sampleSender: null,
        sampleContent: error instanceof Error ? error.message : String(error),
        sampleReceivedAt: new Date().toISOString()
      });
      return null;
    });
    const smsPushes = (pushes?.pushes ?? [])
      .map((item: DirectProbePushResult) => item.sms)
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const directTraceSummary = pushes ? summarizeDirectPushTrace(pushes) : null;
    const directImported = smsPushes.length > 0 ? await storeParsedSmsPushes(accountId, smsPushes) : 0;
    diagnostics.push({
      source: "direct-push",
      scanned: directTraceSummary?.rawPushFrames ?? smsPushes.length,
      imported: directImported,
      sampleSender: smsPushes[0]?.fromNumber ?? null,
      sampleContent: smsPushes[0]?.content ?? buildDirectMissedFrameSample(pushes),
      sampleReceivedAt: new Date().toISOString(),
      note: buildDirectMessageRefreshNote(pushes),
      offlineTemplate: buildDirectMessageOfflineTemplateStatus(pushes)
    });
    if (directImported > 0) {
      return { imported: directImported, diagnostics };
    }
    if (directOnly) {
      diagnostics.push({
        source: "server-only",
        scanned: 0,
        imported: 0,
        sampleSender: null,
        sampleContent: describeDirectOnlyMessageRefresh(pushes),
        sampleReceivedAt: new Date().toISOString()
      });
      return { imported: 0, diagnostics };
    }
  }

  if (directOnly) {
    diagnostics.push({
      source: "server-only",
      scanned: 0,
      imported: 0,
      sampleSender: null,
      sampleContent: useDirectFlow
        ? "Direct mode did not run for this account; no app/helper/ADB fallback was attempted in server-only refresh."
        : "Direct mode is not enabled for this account; no app/helper/ADB fallback was attempted in server-only refresh.",
      sampleReceivedAt: new Date().toISOString()
    });
    return { imported: 0, diagnostics };
  }

  const notificationRows = await dumpSmsMessagesFromNotifications(limit, account.appVariant).catch(() => [] as HelperSmsMessageRecord[]);
  const notificationImported = notificationRows.length > 0 ? await storeHelperSmsMessages(accountId, notificationRows).catch(() => 0) : 0;
  diagnostics.push(buildRefreshDiagnostics("notification-ui", notificationRows, notificationImported));
  if (notificationImported > 0) {
    return { imported: notificationImported, diagnostics };
  }

  await openMessagesInbox(account.appVariant).catch(() => undefined);
  for (const waitMs of [0, 1500, 3000]) {
    if (waitMs > 0) {
      await delayResult(waitMs, null);
    }

    if (waitMs === 0) {
      const helperRows = await dumpHelperSmsMessages(limit, account.appVariant, 8_000).catch(() => [] as HelperSmsMessageRecord[]);
      const helperImported = helperRows.length > 0 ? await storeHelperSmsMessages(accountId, helperRows).catch(() => 0) : 0;
      diagnostics.push(buildRefreshDiagnostics(`helper-db@${waitMs}`, helperRows, helperImported));
      if (helperImported > 0) {
        return { imported: helperImported, diagnostics };
      }
    }

    const adbRows = await dumpSmsMessagesFromAdb(limit, account.appVariant).catch(() => [] as HelperSmsMessageRecord[]);
    const adbImported = adbRows.length > 0 ? await storeHelperSmsMessages(accountId, adbRows).catch(() => 0) : 0;
    diagnostics.push(buildRefreshDiagnostics(`adb-db@${waitMs}`, adbRows, adbImported));
    if (adbImported > 0) {
      return { imported: adbImported, diagnostics };
    }

    const uiRows = filterFreshUiSmsRows(await dumpSmsMessagesFromUi(limit, account.appVariant).catch(() => [] as HelperSmsMessageRecord[]));
    const uiImported = uiRows.length > 0 ? await storeHelperSmsMessages(accountId, uiRows).catch(() => 0) : 0;
    diagnostics.push(buildRefreshDiagnostics(`adb-ui@${waitMs}`, uiRows, uiImported));
    if (uiImported > 0) {
      return { imported: uiImported, diagnostics };
    }
  }
    return { imported: 0, diagnostics };
  } finally {
    if (pausedMonitor) {
      await accountMonitorService.start(accountId).catch((error) => {
        logger.warn("Failed to restore account monitor after manual message refresh", {
          accountId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }
}

async function buildActiveMonitorRefreshDiagnostics(accountId: number): Promise<RefreshMessagesDiagnostics | null> {
  const session = await prisma.monitorSession.findFirst({
    where: {
      accountId,
      status: MonitorStatus.running
    },
    orderBy: { id: "desc" }
  });
  if (!session) {
    return null;
  }

  const note = session.routeAddress ?? "后台 direct 监听已启动，正在等待推送帧。";
  return {
    source: "direct-monitor",
    scanned: pickDiagnosticNumber(note, "raw8107") ?? 0,
    imported: pickDiagnosticNumber(note, "stored") ?? 0,
    sampleSender: null,
    sampleContent: note.includes("missed0103=") ? note.slice(note.indexOf("missed0103=")) : null,
    sampleReceivedAt: new Date().toISOString(),
    note
  };
}

function pickDiagnosticNumber(note: string, key: string) {
  const match = note.match(new RegExp(`(?:^|;\\s*)${key}=(\\d+)`));
  return match ? Number(match[1]) : null;
}

async function pauseMonitorForManualMessageRefresh(account: { id: number; monitorEnabled: boolean }) {
  if (!account.monitorEnabled) {
    return false;
  }
  await accountMonitorService.stop(account.id, {
    preserveMonitorEnabled: true,
    targetStatus: AccountStatus.online,
    emitStatus: false
  });
  return true;
}

function buildRefreshDiagnostics(source: string, rows: HelperSmsMessageRecord[], imported: number): RefreshMessagesDiagnostics {
  const sample = rows.find((row) => row.content?.trim()) ?? rows[0] ?? null;
  return {
    source,
    scanned: rows.length,
    imported,
    sampleSender: sample?.senderId ?? sample?.data1 ?? null,
    sampleContent: sample?.content?.trim() ?? null,
    sampleReceivedAt: formatRefreshSampleTime(sample),
    note: rows.length > 0 && imported === 0
      ? "Scanned messages were not inserted; they are likely already present locally or were de-duplicated."
      : null
  };
}

async function syncMessagesWithFallback(
  account: Prisma.DtAccountGetPayload<Record<string, never>>,
  limit: number,
  diagnostics: RefreshMessagesDiagnostics[]
) {
  try {
    const rows = await dumpHelperSmsMessages(limit, account.appVariant);
    const imported = rows.length > 0 ? await storeHelperSmsMessages(account.id, rows).catch(() => 0) : 0;
    diagnostics.push(buildRefreshDiagnostics("helper-db", rows, imported));
    return { rows, imported, source: "helper-db" };
  } catch (error) {
    diagnostics.push({
      source: "helper-db",
      scanned: 0,
      imported: 0,
      sampleSender: null,
      sampleContent: error instanceof Error ? error.message : String(error),
      sampleReceivedAt: new Date().toISOString()
    });
  }

  const adbRows = await dumpSmsMessagesFromAdb(limit, account.appVariant).catch((error) => {
    diagnostics.push({
      source: "adb-db",
      scanned: 0,
      imported: 0,
      sampleSender: null,
      sampleContent: error instanceof Error ? error.message : String(error),
      sampleReceivedAt: new Date().toISOString()
    });
    return [] as HelperSmsMessageRecord[];
  });
  const adbImported = adbRows.length > 0 ? await storeHelperSmsMessages(account.id, adbRows).catch(() => 0) : 0;
  diagnostics.push(buildRefreshDiagnostics("adb-db", adbRows, adbImported));
  if (adbRows.length > 0 || adbImported > 0) {
    return { rows: adbRows, imported: adbImported, source: "adb-db" };
  }

  const uiRows = filterFreshUiSmsRows(await dumpSmsMessagesFromUi(limit, account.appVariant).catch((error) => {
    diagnostics.push({
      source: "adb-ui",
      scanned: 0,
      imported: 0,
      sampleSender: null,
      sampleContent: error instanceof Error ? error.message : String(error),
      sampleReceivedAt: new Date().toISOString()
    });
    return [] as HelperSmsMessageRecord[];
  }));
  const uiImported = uiRows.length > 0 ? await storeHelperSmsMessages(account.id, uiRows).catch(() => 0) : 0;
  diagnostics.push(buildRefreshDiagnostics("adb-ui", uiRows, uiImported));
  return { rows: uiRows, imported: uiImported, source: "adb-ui" };
}

function filterFreshUiSmsRows(rows: HelperSmsMessageRecord[]) {
  const freshSince = Date.now() - 30 * 60_000;
  return rows.filter((row) => {
    if (row.data3 !== "adb-ui") {
      return true;
    }
    const timestamp = row.time ?? row.timestamp ?? 0;
    return Number.isFinite(timestamp) && timestamp >= freshSince;
  });
}

export function buildDirectMessageOfflineTemplateStatus(pushes: DirectProbeResult | null): DirectMessageOfflineTemplateStatus | null {
  if (!pushes) {
    return null;
  }
  const sent = pushes.offlineTemplateSent === true;
  const attempted = pushes.offlineTemplateAttempted === true;
  return {
    attempted,
    sent,
    status: sent ? "sent" : attempted ? "attempted-not-sent" : "not-attempted",
    listenStatus: pushes.preempted ? "preempted" : "completed",
    error: pushes.offlineTemplateError ?? null
  };
}

export function buildDirectMessageRefreshNote(pushes: DirectProbeResult | null) {
  if (!pushes) {
    return null;
  }
  const offlineTemplateStatus = formatOfflineTemplateStatus(pushes);
  const traceSummary = summarizeDirectPushTrace(pushes);
  const parts = [
    `host=${pushes.host}`,
    `pushFrames=${pushes.pushes.length}`,
    `raw8107=${traceSummary.rawPushFrames}`,
    `nonSms8107=${traceSummary.nonSmsPushFrames}`,
    `listen=${pushes.preempted ? "preempted" : "completed"}`,
    offlineTemplateStatus
  ];
  if (traceSummary.statusSummary) {
    parts.push(`status=${traceSummary.statusSummary}`);
  }
  if (pushes.offlineTemplateError) {
    parts.push(`offlineTemplateError=${pushes.offlineTemplateError}`);
  }
  return parts.join("; ");
}

function formatOfflineTemplateStatus(pushes: DirectProbeResult) {
  if (pushes.offlineTemplateSent) {
    return "offlineTemplate=sent; offlineCatchup=requested";
  }
  if (pushes.offlineTemplateAttempted) {
    const catchupStatus = pushes.offlineTemplateError?.includes("not configured") ? "template-missing" : "template-error";
    return `offlineTemplate=attempted-not-sent; offlineCatchup=${catchupStatus}`;
  }
  return "offlineTemplate=not-attempted; offlineCatchup=not-started";
}

function describeDirectOnlyMessageRefresh(pushes: DirectProbeResult | null) {
  if (!pushes) {
    return "Direct listen did not complete. Server-only refresh does not scan app/helper/ADB.";
  }
  const traceSummary = summarizeDirectPushTrace(pushes);
  if (pushes.preempted) {
    return "Direct listen was preempted by another direct session. Stop account monitoring or retry after current direct operation finishes; server-only refresh does not scan app/helper/ADB.";
  }
  if (traceSummary.rawPushFrames > 0 && pushes.pushes.length === 0) {
    return `Direct listen received ${traceSummary.rawPushFrames} raw 0x8107 frame(s), but none parsed as SMS. Status distribution: ${traceSummary.statusSummary || "unknown"}. Server-only refresh does not scan app/helper/ADB.`;
  }
  if (pushes.offlineTemplateError?.includes("not configured")) {
    return "Direct listen saw no SMS and offline catch-up template is missing. Configure dt_direct_template_offline_messages to fetch historical/offline SMS on a server without simulator fallback.";
  }
  if (pushes.offlineTemplateError) {
    return `Direct listen saw no SMS and offline catch-up failed: ${pushes.offlineTemplateError}. Server-only refresh does not scan app/helper/ADB.`;
  }
  if (!pushes.offlineTemplateAttempted) {
    return "Direct listen saw no SMS before offline catch-up could be attempted. Server-only refresh does not scan app/helper/ADB.";
  }
  if (!pushes.offlineTemplateSent) {
    return "Direct listen saw no SMS and offline catch-up template was not sent. Server-only refresh does not scan app/helper/ADB.";
  }
  return "Direct listen and offline catch-up request completed, but no importable SMS push arrived. Server-only refresh does not scan app/helper/ADB.";
}

function buildDirectMissedFrameSample(pushes: DirectProbeResult | null) {
  if (!pushes) {
    return null;
  }
  const suspicious = (pushes.trace ?? []).find((item) => item.frameType === 0x8107 && item.status === 0x0103);
  if (!suspicious) {
    return null;
  }
  const jsonName = isRecord(suspicious.jsonPayload)
    ? formatDiagnosticPrimitive(suspicious.jsonPayload.api_name ?? suspicious.jsonPayload.apiName ?? suspicious.jsonPayload.name)
    : null;
  const bodyPreview = suspicious.bodyHexPreview ? `${suspicious.bodyHexPreview.slice(0, 96)}...` : "empty";
  return [
    "疑似短信状态帧未解析",
    `status=0x0103`,
    `body=${suspicious.bodyLength}`,
    jsonName ? `json=${jsonName}` : null,
    `bodyHex=${bodyPreview}`
  ].filter(Boolean).join("; ");
}

function formatDiagnosticPrimitive(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : null;
}

function summarizeDirectPushTrace(pushes: DirectProbeResult) {
  const rawPushFrames = (pushes.trace ?? []).filter((item) => item.frameType === 0x8107).length;
  const nonSmsPushFrames = Math.max(0, rawPushFrames - pushes.pushes.length);
  const statusCounts = new Map<string, number>();
  for (const frame of pushes.trace ?? []) {
    if (frame.frameType !== 0x8107) {
      continue;
    }
    const status = frame.status === undefined ? "unknown" : `0x${frame.status.toString(16).padStart(4, "0")}`;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const statusSummary = Array.from(statusCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}:${count}`)
    .join(",");
  return {
    rawPushFrames,
    nonSmsPushFrames,
    statusSummary
  };
}

function formatRefreshSampleTime(sample: HelperSmsMessageRecord | null) {
  if (!sample) {
    return null;
  }
  const candidate = sample.time ?? sample.timestamp ?? null;
  if (!candidate || !Number.isFinite(candidate)) {
    return null;
  }
  const date = new Date(candidate > 1_000_000_000_000 ? candidate : candidate * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function syncPhoneNumbers(accountId: number, phoneNumbers: DingtonePhoneNumber[]) {
  const remoteSet = new Set<string>();
  for (const item of phoneNumbers) {
    if (!item.phoneNumber) {
      continue;
    }
    remoteSet.add(item.phoneNumber);
    await prisma.phoneNumber.upsert({
      where: {
        accountId_phoneNumber: {
          accountId,
          phoneNumber: item.phoneNumber
        }
      },
      update: mapPhoneNumberPatch(item),
      create: mapPhoneNumberCreate(accountId, item)
    });
  }

  const missingCount = remoteSet.size
    ? await prisma.phoneNumber.count({
        where: {
          accountId,
          phoneNumber: { notIn: Array.from(remoteSet) }
        }
      })
    : 0;
  if (missingCount > 0) {
    logger.warn("Remote phone sync omitted local phone records; keeping local rows instead of deleting them", {
      accountId,
      missingCount
    });
  }
}

function chooseMergedAccountStatus(current: AccountStatus, duplicate: AccountStatus) {
  const order: AccountStatus[] = [
    AccountStatus.online,
    AccountStatus.error,
    AccountStatus.expired,
    AccountStatus.offline,
    AccountStatus.pending
  ];
  return order.indexOf(duplicate) < order.indexOf(current) ? duplicate : current;
}

function accountListVisibleWhere(): Prisma.DtAccountWhereInput {
  return {
    NOT: {
      AND: [
        { status: AccountStatus.pending },
        { dtUserId: null },
        { loginType: { in: [LoginType.email_code, LoginType.phone_code] } }
      ]
    }
  };
}

export function shouldShowAccountInList(input: {
  status: AccountStatus;
  loginType: LoginType | "email_code" | "phone_code" | string;
  dtUserId: string | null;
  dtToken: string | null;
}) {
  return !(
    input.status === AccountStatus.pending &&
    !input.dtUserId &&
    (input.loginType === LoginType.email_code || input.loginType === LoginType.phone_code)
  );
}


type VerificationSendInput = {
  loginType: LoginType;
  appVariant: AppVariant;
  email?: string | null;
  phone?: string | null;
  deviceId: string;
  trackCode: string;
};

type VerificationSendResult = {
  result: VerificationRequestResult;
  appVariant: AppVariant;
  deviceId: string;
  trackCode: string;
  switched: boolean;
};

async function sendVerificationCodeWithVariantFallback(input: VerificationSendInput): Promise<VerificationSendResult> {
  try {
    const result = await dingtoneGateway.sendVerificationCode(input);
    return { result, appVariant: input.appVariant, deviceId: input.deviceId, trackCode: input.trackCode, switched: false };
  } catch (firstError) {
    if (!shouldRetryVerificationWithOtherVariant(firstError)) {
      throw firstError;
    }

    const fallbackVariant = otherVerificationAppVariant(input.appVariant);
    const fallbackDeviceId = normalizeVerificationDeviceId(createDeviceId(), fallbackVariant, input.loginType);
    const fallbackTrackCode = createTrackCode();
    try {
      const result = await dingtoneGateway.sendVerificationCode({
        ...input,
        appVariant: fallbackVariant,
        deviceId: fallbackDeviceId,
        trackCode: fallbackTrackCode
      });
      logger.info("Verification-code send succeeded after switching app variant", {
        from: input.appVariant,
        to: fallbackVariant,
        loginType: input.loginType
      });
      return { result, appVariant: fallbackVariant, deviceId: fallbackDeviceId, trackCode: fallbackTrackCode, switched: true };
    } catch (fallbackError) {
      throw new AppError(
        `邮箱验证码自动识别 App 失败：${formatAppVariantName(input.appVariant)} 返回：${formatVerificationSendError(firstError)}；${formatAppVariantName(fallbackVariant)} 返回：${formatVerificationSendError(fallbackError)}`,
        400,
        400
      );
    }
  }
}

export function otherVerificationAppVariant(appVariant: AppVariant | "dingtone" | "dingdong") {
  return String(appVariant) === "dingdong" ? AppVariant.dingtone : AppVariant.dingdong;
}

export function shouldRetryVerificationWithOtherVariant(error: unknown) {
  const message = formatVerificationSendError(error);
  return /user exist in other app|Direct registerEmail failed: REST call failed|current local account type/i.test(message);
}

function formatVerificationSendError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatAppVariantName(appVariant: AppVariant | "dingtone" | "dingdong") {
  return String(appVariant) === "dingdong" ? "Dingdong" : "TalkU";
}
function normalizeVerificationDeviceId(deviceId: string, appVariant?: string | null, loginType?: string | null) {
  const trimmed = deviceId.trim();
  if (loginType === "email_code" && appVariant === "dingdong") {
    return trimmed.replace(/\.dttalk$/i, "");
  }
  return trimmed;
}

function normalizeOptionalString(value: unknown) {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed ? trimmed : null;
}

function parsePositiveIntSetting(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeOptionalString(value))
        .filter((value): value is string => Boolean(value))
    )
  );
}

async function shouldUseDirectAccountFlow(account: { loginType: string; dtUserId?: string | null; dtToken?: string | null }) {
  const mode = await getGatewayMode();
  return mode === "direct" || account.loginType === "manual_session" || (mode !== "mock" && Boolean(account.dtUserId && account.dtToken));
}

function shouldReplaceNickname(currentNickname: string | null, snapshotName: string | null) {
  if (!currentNickname || !snapshotName) {
    return false;
  }
  const repairedNickname = repairUtf8Mojibake(currentNickname);
  return repairedNickname !== currentNickname && repairedNickname === snapshotName;
}

function repairUtf8Mojibake(value: string) {
  if (!value) {
    return value;
  }
  if (/[\u4e00-\u9fff]/.test(value)) {
    return value;
  }
  if (!hasMojibakeLeadBytes(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired === value || repaired.includes("\ufffd")) {
      return value;
    }
    if (/[\u4e00-\u9fff]/.test(repaired)) {
      return repaired;
    }
    const suspiciousOriginal = countMojibakeLeadBytes(value);
    const suspiciousRepaired = countMojibakeLeadBytes(repaired);
    return suspiciousRepaired < suspiciousOriginal ? repaired : value;
  } catch {
    return value;
  }
}

function hasMojibakeLeadBytes(value: string) {
  return countMojibakeLeadBytes(value) > 0;
}

function countMojibakeLeadBytes(value: string) {
  return Array.from(value).filter((char) => {
    const code = char.charCodeAt(0);
    return code >= 0xc0 && code <= 0xff;
  }).length;
}

function deriveFallbackName(input: {
  nickname?: string | null;
  email?: string | null;
  phone?: string | null;
  dtUserId?: string | null;
}) {
  return (
    normalizeOptionalString(input.nickname) ??
    normalizeOptionalString(input.email) ??
    normalizeOptionalString(input.phone) ??
    normalizeOptionalString(input.dtUserId) ??
    "Unnamed account"
  );
}

function resolveAccountName(input: {
  nickname: string | null;
  email: string | null;
  phone: string | null;
  dtUserId: string | null;
  snapshot?: { fullName: string | null } | null;
}) {
  return (
    normalizeOptionalString(input.nickname) ??
    normalizeOptionalString(input.snapshot?.fullName) ??
    normalizeOptionalString(input.email) ??
    normalizeOptionalString(input.phone) ??
    normalizeOptionalString(input.dtUserId) ??
    "Unnamed account"
  );
}

function mapPurchaseCandidate(input: z.infer<typeof purchasePhoneCandidateSchema>): DingtonePhonePurchaseCandidate {
  return {
    phoneNumber: input.phone_number,
    countryCode: input.country_code,
    areaCode: input.area_code,
    providerId: input.provider_id,
    packageServiceId: normalizeOptionalString(input.package_service_id) ?? undefined,
    category: input.category,
    phoneType: input.phone_type,
    displayName: normalizeOptionalString(input.display_name) ?? undefined,
    cityName: normalizeOptionalString(input.city_name) ?? undefined,
    stateName: normalizeOptionalString(input.state_name) ?? undefined,
    isoCountryCode: normalizeOptionalString(input.iso_country_code) ?? undefined,
    goodNumberLevel: input.good_number_level,
    useHistory: input.use_history,
    price: input.price,
    productId: normalizeOptionalString(input.product_id) ?? undefined
  };
}

function mapStoredPhoneContext(phone: {
  phoneNumber: string;
  countryCode: number | null;
  providerId: number | null;
  displayName: string | null;
  status: PhoneStatus;
  purchaseType: number | null;
  payType: number | null;
  validPeriodDays: number | null;
  gainTime: string | null;
  expiredTime: string | null;
  autoRenew: boolean;
  isPrimary: boolean;
  isGoodNumber: boolean;
  portoutInfo: string | null;
  rawJson: string | null;
}): DingtonePhoneNumber {
  const raw = parseJsonRecord(phone.rawJson);
  return {
    phoneNumber: phone.phoneNumber,
    countryCode: phone.countryCode ?? pickNumber(raw, ["countryCode", "country_code"]) ?? undefined,
    areaCode: pickNumber(raw, ["areaCode", "area_code"]) ?? undefined,
    providerId: phone.providerId ?? pickNumber(raw, ["providerId", "provider_id", "reserved3"]) ?? undefined,
    packageServiceId: pickString(raw, ["packageServiceId", "package_service_id", "reserved4"]) ?? undefined,
    displayName: phone.displayName ?? pickString(raw, ["displayName", "display_name"]) ?? undefined,
    status: phone.status,
    purchaseType: phone.purchaseType ?? pickNumber(raw, ["purchaseType", "purchase_type", "category"]) ?? undefined,
    payType: phone.payType ?? pickNumber(raw, ["payType", "pay_type", "phoneType", "phone_type"]) ?? undefined,
    validPeriodDays: phone.validPeriodDays ?? undefined,
    gainTime: phone.gainTime ?? undefined,
    expiredTime: phone.expiredTime ?? undefined,
    autoRenew: phone.autoRenew,
    isPrimary: phone.isPrimary,
    isGoodNumber: phone.isGoodNumber,
    portoutInfo: phone.portoutInfo ?? undefined,
    rawJson: phone.rawJson ?? undefined
  };
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializePointData(data: Awaited<ReturnType<typeof getAccountPoint>>) {
  return {
    point_uid: data.pointUid,
    user_id: data.userId,
    game_uid: data.gameUid,
    app_type: data.appType,
    game_app_id: data.gameAppId,
    user_name: data.userName,
    user_grade: data.userGrade,
    valid_point: data.validPoint,
    history_point: data.historyPoint,
    expire_point: data.expirePoint,
    expire_time: data.expireTime,
    game_benefits: data.gameBenefits.map((item) => ({
      code: item.code,
      name: item.name,
      price: item.price,
      stock: item.stock
    })),
    snapshot: data.snapshot,
    raw: data.raw
  };
}

function serializePointStore(data: Awaited<ReturnType<typeof getAccountPointStore>>) {
  return {
    point_uid: data.pointUid,
    email: data.email,
    user_name: data.userName,
    user_grade: data.userGrade,
    valid_point: data.validPoint,
    history_point: data.historyPoint,
    expire_point: data.expirePoint,
    expire_time: data.expireTime,
    products: data.products.map(serializePointStoreProduct),
    snapshot: data.snapshot,
    raw: data.raw
  };
}

function serializePointStoreProduct(product: Awaited<ReturnType<typeof getAccountPointStore>>["products"][number]) {
  return {
    product_id: product.productId,
    name: product.name,
    stock: product.stock,
    price: product.price,
    raw_json: product.rawJson
  };
}

function serializePointStoreOrder(data: Awaited<ReturnType<typeof orderAccountPointStoreProduct>>) {
  return {
    product: serializePointStoreProduct(data.product),
    email: data.email,
    order_id: data.orderId,
    order: data.order,
    order_info: data.orderInfo,
    point_store: serializePointStore(data.pointStore)
  };
}
function serializePhonePurchasePreview(preview: DingtonePhonePurchasePreview) {
  return {
    free_chance: preview.freeChance ?? null,
    candidates: preview.candidates.map(serializePhonePurchaseCandidate),
    raw_json: preview.rawJson ?? JSON.stringify(preview)
  };
}

function serializePhonePurchaseCandidate(candidate: DingtonePhonePurchaseCandidate) {
  return {
    phone_number: candidate.phoneNumber,
    country_code: candidate.countryCode ?? null,
    area_code: candidate.areaCode ?? null,
    provider_id: candidate.providerId ?? null,
    package_service_id: candidate.packageServiceId ?? null,
    category: candidate.category ?? null,
    phone_type: candidate.phoneType ?? null,
    display_name: candidate.displayName ?? null,
    city_name: candidate.cityName ?? null,
    state_name: candidate.stateName ?? null,
    iso_country_code: candidate.isoCountryCode ?? null,
    good_number_level: candidate.goodNumberLevel ?? null,
    use_history: candidate.useHistory ?? null,
    price: candidate.price ?? null,
    product_id: candidate.productId ?? null,
    raw_json: candidate.rawJson ?? JSON.stringify(candidate)
  };
}

function normalizeHelperPhonePreview(value: unknown): DingtonePhonePurchasePreview {
  const record = isRecord(value) ? value : {};
  const rawCandidates = Array.isArray(record.phones) ? record.phones : Array.isArray(record.candidates) ? record.candidates : [];
  return {
    freeChance: pickNumber(record, ["freeChance", "free_chance"]) ?? undefined,
    candidates: rawCandidates.map((item) => normalizeHelperPhoneCandidate(item)).filter((item) => Boolean(item.phoneNumber)),
    rawJson: JSON.stringify(value)
  };
}

function normalizeHelperPhoneCandidate(value: unknown): DingtonePhonePurchaseCandidate {
  const merged = mergeHelperRawRecord(value);
  return {
    phoneNumber: pickString(merged, ["phoneNumber", "phone_number"]) ?? "",
    countryCode: pickNumber(merged, ["countryCode", "country_code"]) ?? undefined,
    areaCode: pickNumber(merged, ["areaCode", "area_code"]) ?? undefined,
    providerId: pickNumber(merged, ["providerId", "provider_id"]) ?? undefined,
    packageServiceId: pickString(merged, ["packageServiceId", "package_service_id"]) ?? undefined,
    category: pickNumber(merged, ["category", "purchaseType", "purchase_type"]) ?? undefined,
    phoneType: pickNumber(merged, ["phoneType", "phone_type", "payType", "pay_type"]) ?? undefined,
    displayName: pickString(merged, ["displayName", "display_name", "cityName", "city_name", "stateName", "state_name"]) ?? undefined,
    cityName: pickString(merged, ["cityName", "city_name"]) ?? undefined,
    stateName: pickString(merged, ["stateName", "state_name"]) ?? undefined,
    isoCountryCode: pickString(merged, ["isoCountryCode", "iso_country_code", "isoCC", "iso_cc"]) ?? undefined,
    goodNumberLevel: pickNumber(merged, ["goodNumberLevel", "good_number_level"]) ?? undefined,
    useHistory: pickNumber(merged, ["useHistory", "use_history"]) ?? undefined,
    price:
      pickNumber(merged, [
        "price",
        "orderPrice",
        "order_price",
        "cost",
        "amount",
        "needPay",
        "need_pay",
        "needBalance",
        "need_balance",
        "credit",
        "creditNum",
        "credit_num",
        "reserved5"
      ]) ?? undefined,
    productId: pickString(merged, ["productId", "product_id"]) ?? undefined,
    rawJson: JSON.stringify(value)
  };
}

function normalizeHelperPhoneNumbers(value: unknown) {
  const list = Array.isArray(value) ? value : [];
  return list.map((item) => normalizeHelperPhoneNumber(item)).filter((item) => Boolean(item.phoneNumber));
}

function normalizeHelperPhoneNumber(value: unknown): DingtonePhoneNumber {
  const merged = mergeHelperRawRecord(value);
  return {
    phoneNumber: pickString(merged, ["phoneNumber", "phone_number"]) ?? "",
    countryCode: pickNumber(merged, ["countryCode", "country_code"]) ?? undefined,
    providerId: pickNumber(merged, ["providerId", "provider_id"]) ?? undefined,
    displayName: pickString(merged, ["displayName", "display_name"]) ?? undefined,
    status: normalizeHelperPhoneStatus(merged),
    purchaseType: pickNumber(merged, ["purchaseType", "purchase_type", "category"]) ?? undefined,
    payType: pickNumber(merged, ["payType", "pay_type", "phoneType", "phone_type"]) ?? undefined,
    validPeriodDays: pickNumber(merged, ["validPeriodDays", "valid_period_days", "usePeriod", "use_period"]) ?? undefined,
    gainTime: pickString(merged, ["gainTime", "gain_time"]) ?? undefined,
    expiredTime: pickString(merged, ["expireTime", "expire_time", "expiredTime", "expired_time"]) ?? undefined,
    autoRenew: pickBoolean(merged, ["autoRenew", "auto_renew"]) ?? undefined,
    isPrimary: pickBoolean(merged, ["isPrimary", "is_primary", "primaryFlag", "primary_flag"]) ?? undefined,
    isGoodNumber:
      pickBoolean(merged, ["isGoodNumber", "is_good_number"]) ??
      ((pickNumber(merged, ["goodNumberLevel", "good_number_level"]) ?? 0) > 0 ? true : undefined),
    portoutInfo: pickString(merged, ["portoutInfo", "portout_info"]) ?? undefined,
    rawJson: JSON.stringify(value)
  };
}

function normalizeHelperPhoneNumberPatch(value: unknown): Partial<DingtonePhoneNumber> {
  const normalized = normalizeHelperPhoneNumber(value);
  return {
    countryCode: normalized.countryCode,
    providerId: normalized.providerId,
    displayName: normalized.displayName,
    status: normalized.status,
    purchaseType: normalized.purchaseType,
    payType: normalized.payType,
    validPeriodDays: normalized.validPeriodDays,
    gainTime: normalized.gainTime,
    expiredTime: normalized.expiredTime,
    autoRenew: normalized.autoRenew,
    isPrimary: normalized.isPrimary,
    isGoodNumber: normalized.isGoodNumber,
    portoutInfo: normalized.portoutInfo,
    rawJson: normalized.rawJson
  };
}

function normalizeHelperPhoneStatus(record: Record<string, unknown>): DingtonePhoneNumber["status"] {
  const status = pickString(record, ["status", "phoneStatus", "phone_status"])?.toLowerCase();
  if (status === "active" || status === "paused" || status === "expired" || status === "cancelled" || status === "pending") {
    return status;
  }
  if (pickBoolean(record, ["cancelled", "isCancelled", "is_cancelled"])) {
    return "cancelled";
  }
  if (pickBoolean(record, ["suspendFlag", "suspend_flag", "paused", "isPaused", "is_paused"])) {
    return "paused";
  }
  const expireTime = pickNumber(record, ["expireTime", "expire_time", "expiredTime", "expired_time"]);
  if (expireTime && (expireTime > 1_000_000_000_000 ? expireTime : expireTime * 1000) <= Date.now()) {
    return "expired";
  }
  return "active";
}

function mergeHelperRawRecord(value: unknown) {
  const base = isRecord(value) ? value : {};
  const rawJson = isRecord(base.rawJson) ? base.rawJson : {};
  return {
    ...rawJson,
    ...base
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      const normalized = normalizePickedString(value);
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function normalizePickedString(value: string) {
  const normalized = value.trim();
  return /^(null|undefined|none|nil)$/i.test(normalized) ? "" : normalized;
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function pickDate(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return new Date(value > 1_000_000_000_000 ? value : value * 1000);
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        return new Date(numeric > 1_000_000_000_000 ? numeric : numeric * 1000);
      }
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return null;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (value === 1) {
        return true;
      }
      if (value === 0 || value === -1) {
        return false;
      }
      return null;
    }
    if (typeof value === "string" && value.trim()) {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") {
        return true;
      }
      if (normalized === "false" || normalized === "0" || normalized === "-1") {
        return false;
      }
    }
  }
  return null;
}

function safeJsonStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializeError: true });
  }
}

function mapSnapshot(snapshot: DingtoneSnapshot, previousSnapshot?: {
  dtDingtoneId: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  gender: number | null;
  birthday: string | null;
  email: string | null;
  phone: string | null;
  aboutMe: string | null;
  feeling: string | null;
  company: string | null;
  school: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  primaryBalance: number | null;
  userGrade: number | null;
  validPoint: number | null;
  progressPoint: number | null;
  membershipType: string | null;
  membershipExpireAt: Date | null;
  profileVerCode: string | null;
  rawJson: string | null;
} | null) {
  return {
    dtDingtoneId: pickNextValue(snapshot.dtDingtoneId, previousSnapshot?.dtDingtoneId),
    fullName: pickNextValue(snapshot.fullName, previousSnapshot?.fullName),
    avatarUrl: pickNextValue(snapshot.avatarUrl, previousSnapshot?.avatarUrl),
    gender: pickNextNumber(snapshot.gender, previousSnapshot?.gender),
    birthday: pickNextValue(snapshot.birthday, previousSnapshot?.birthday),
    email: pickNextValue(snapshot.email, previousSnapshot?.email),
    phone: pickNextValue(snapshot.phone, previousSnapshot?.phone),
    aboutMe: pickNextValue(snapshot.aboutMe, previousSnapshot?.aboutMe),
    feeling: pickNextValue(snapshot.feeling, previousSnapshot?.feeling),
    company: pickNextValue(snapshot.company, previousSnapshot?.company),
    school: pickNextValue(snapshot.school, previousSnapshot?.school),
    country: pickNextValue(snapshot.country, previousSnapshot?.country),
    state: pickNextValue(snapshot.state, previousSnapshot?.state),
    city: pickNextValue(snapshot.city, previousSnapshot?.city),
    primaryBalance: pickNextNumber(snapshot.primaryBalance, previousSnapshot?.primaryBalance),
    userGrade: pickNextNumber(snapshot.userGrade, previousSnapshot?.userGrade),
    validPoint: pickNextNumber(snapshot.validPoint, previousSnapshot?.validPoint),
    progressPoint: pickNextNumber(snapshot.progressPoint, previousSnapshot?.progressPoint),
    membershipType: pickNextValue(snapshot.membershipType ?? snapshot.membershipLevelLabel, previousSnapshot?.membershipType),
    membershipExpireAt: snapshot.membershipExpireAt ?? previousSnapshot?.membershipExpireAt ?? null,
    profileVerCode: pickNextValue(snapshot.profileVerCode, previousSnapshot?.profileVerCode),
    rawJson: snapshot.rawJson ?? previousSnapshot?.rawJson ?? JSON.stringify(snapshot)
  };
}

function pickNextValue(next: string | null | undefined, previous: string | null | undefined) {
  return normalizeOptionalString(next) ?? normalizeOptionalString(previous) ?? null;
}

function pickNextNumber(next: number | null | undefined, previous: number | null | undefined) {
  return Number.isFinite(next) ? next : Number.isFinite(previous) ? previous : null;
}

function mapPhoneNumberBase(item: Partial<DingtonePhoneNumber>) {
  return {
    countryCode: item.countryCode,
    providerId: item.providerId,
    displayName: item.displayName,
    status: item.status ? (item.status as PhoneStatus) : undefined,
    purchaseType: item.purchaseType,
    payType: item.payType,
    validPeriodDays: item.validPeriodDays,
    gainTime: item.gainTime,
    expiredTime: item.expiredTime,
    autoRenew: item.autoRenew ?? false,
    isPrimary: item.isPrimary ?? false,
    isGoodNumber: item.isGoodNumber ?? false,
    portoutInfo: item.portoutInfo,
    rawJson: item.rawJson ?? JSON.stringify(item)
  };
}

function mapStoredPhoneNumber(phone: {
  countryCode: number | null;
  providerId: number | null;
  displayName: string | null;
  status: PhoneStatus;
  purchaseType: number | null;
  payType: number | null;
  validPeriodDays: number | null;
  gainTime: string | null;
  expiredTime: string | null;
  autoRenew: boolean;
  isPrimary: boolean;
  isGoodNumber: boolean;
  portoutInfo: string | null;
  rawJson: string | null;
}) {
  return {
    countryCode: phone.countryCode,
    providerId: phone.providerId,
    displayName: phone.displayName,
    status: phone.status,
    purchaseType: phone.purchaseType,
    payType: phone.payType,
    validPeriodDays: phone.validPeriodDays,
    gainTime: phone.gainTime,
    expiredTime: phone.expiredTime,
    autoRenew: phone.autoRenew,
    isPrimary: phone.isPrimary,
    isGoodNumber: phone.isGoodNumber,
    portoutInfo: phone.portoutInfo,
    rawJson: phone.rawJson
  };
}

function mapStoredSnapshot(snapshot: {
  dtDingtoneId: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  gender: number | null;
  birthday: string | null;
  email: string | null;
  phone: string | null;
  aboutMe: string | null;
  feeling: string | null;
  company: string | null;
  school: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  primaryBalance: number | null;
  userGrade: number | null;
  validPoint: number | null;
  progressPoint: number | null;
  membershipType: string | null;
  membershipExpireAt: Date | null;
  profileVerCode: string | null;
  rawJson: string | null;
}) {
  return {
    dtDingtoneId: snapshot.dtDingtoneId,
    fullName: snapshot.fullName,
    avatarUrl: snapshot.avatarUrl,
    gender: snapshot.gender,
    birthday: snapshot.birthday,
    email: snapshot.email,
    phone: snapshot.phone,
    aboutMe: snapshot.aboutMe,
    feeling: snapshot.feeling,
    company: snapshot.company,
    school: snapshot.school,
    country: snapshot.country,
    state: snapshot.state,
    city: snapshot.city,
    primaryBalance: snapshot.primaryBalance,
    userGrade: snapshot.userGrade,
    validPoint: snapshot.validPoint,
    progressPoint: snapshot.progressPoint,
    membershipType: snapshot.membershipType,
    membershipExpireAt: snapshot.membershipExpireAt,
    profileVerCode: snapshot.profileVerCode,
    rawJson: snapshot.rawJson
  };
}

function mapPhoneNumberCreate(accountId: number, item: DingtonePhoneNumber): Prisma.PhoneNumberUncheckedCreateInput {
  return {
    accountId,
    phoneNumber: item.phoneNumber,
    ...mapPhoneNumberBase(item)
  };
}

function mapPhoneNumberPatch(item: Partial<DingtonePhoneNumber>): Prisma.PhoneNumberUncheckedUpdateInput {
  return mapPhoneNumberBase(item);
}

async function assertAccount(accountId: number) {
  return assertFound(
    await prisma.dtAccount.findUnique({
      where: { id: accountId }
    }),
    "Account not found"
  );
}

export async function assertAccountPhoneNumber(accountId: number, phoneId: number) {
  return assertFound(
    await prisma.phoneNumber.findFirst({
      where: {
        id: phoneId,
        accountId
      }
    }),
    "Phone number not found"
  );
}

function requireString(value: string | null, message: string) {
  if (!value) {
    throw new AppError(message, 400, 400);
  }
  return value;
}

function serializeAccountForEdit(account: {
  id: number;
  nickname: string | null;
  appVariant: AppVariant;
  email: string | null;
  phone: string | null;
  dtUserId: string | null;
  status: string;
  monitorEnabled: boolean;
  telegramNotify: boolean;
  proxyEnabled: boolean;
  lastLoginAt: Date | null;
}) {
  return {
    id: account.id,
    nickname: account.nickname ?? "",
    app_variant: account.appVariant,
    email: account.email,
    phone: account.phone,
    dt_user_id: account.dtUserId,
    status: account.status,
    monitor_enabled: account.monitorEnabled,
    telegram_notify: account.telegramNotify,
    proxy_enabled: account.proxyEnabled,
    last_login_at: account.lastLoginAt
  };
}

export async function createMockIncomingMessage(accountId: number, content: string, fromNumber = "38689") {
  const account = await assertAccount(accountId);
  const message = await prisma.message.create({
    data: {
      accountId,
      direction: "incoming",
      msgType: content.match(/\d{4,8}/) ? MessageType.verification : MessageType.sms,
      fromNumber,
      content,
      receivedAt: new Date()
    }
  });

  if (account.telegramNotify) {
    const msgId = await sendSmsTelegramNotification({
      account,
      fromNumber,
      content,
      receivedAt: message.receivedAt
    });
    if (msgId) {
      await prisma.message.update({
        where: { id: message.id },
        data: {
          telegramSent: true,
          telegramMsgId: msgId
        }
      });
    }
  }

  eventBus.emitEvent({
    type: "new_message",
    payload: {
      id: message.id,
      accountId,
      accountNickname: deriveFallbackName(account),
      from: fromNumber,
      content,
      msgType: message.msgType,
      receivedAt: message.receivedAt.toISOString()
    }
  });

  return message;
}
