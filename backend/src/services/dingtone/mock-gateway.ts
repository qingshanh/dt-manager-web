import crypto from "node:crypto";
import { AppError } from "../../utils/errors.js";
import { createMockToken } from "../../utils/crypto.js";
import type {
  DingtoneGateway,
  DingtoneLoginInput,
  DingtoneLoginResult,
  DingtonePhonePurchaseCandidate,
  DingtonePhonePurchasePreview,
  DingtoneSessionExportInput,
  DingtoneSessionExport,
  DingtonePhoneNumber,
  DingtoneSnapshot,
  VerificationRequestResult
} from "./types.js";

const MOCK_VERIFICATION_CODE = "123456";

function makeSnapshot(input: { email?: string | null; phone?: string | null; dtUserId: string }): DingtoneSnapshot {
  return {
    dtDingtoneId: input.dtUserId.slice(-8),
    fullName: "Mock User",
    gender: 0,
    email: input.email ?? undefined,
    phone: input.phone ?? "+8613800138000",
    country: "China",
    state: "Guangxi",
    city: "Yulin",
    primaryBalance: 263.857,
    userGrade: 3,
    validPoint: 1275.9,
    progressPoint: 3011.9,
    membershipType: "premium",
    progressPointTotal: 5000,
    membershipLevelLabel: "V4 白金",
    profileVerCode: "117440517",
    rawJson: JSON.stringify({ mock: true })
  };
}

export class MockDingtoneGateway implements DingtoneGateway {
  async sendVerificationCode(input: DingtoneLoginInput): Promise<VerificationRequestResult> {
    const delivery = input.loginType === "phone_code" ? "短信" : "邮件";
    return {
      message: `当前为 mock 模式，不会真实发送${delivery}，请使用固定验证码 123456`,
      mock: true,
      verificationCode: MOCK_VERIFICATION_CODE
    };
  }

  async login(input: DingtoneLoginInput): Promise<DingtoneLoginResult> {
    if ((input.loginType === "email_code" || input.loginType === "phone_code") && input.verificationCode !== MOCK_VERIFICATION_CODE) {
      throw new AppError("验证码错误，请输入 mock 固定验证码 123456", 400, 400);
    }
    const identity = input.email ?? input.phone ?? "mock-user";
    return {
      dtUserId: `145138329${Math.floor(Math.random() * 1000000)}`,
      token: createMockToken(identity),
      deviceId: input.deviceId,
      dingtoneId: `mock-${Math.floor(Math.random() * 1000000)}`,
      routeAddress: "e0.96.00.03.00.50.29.5c",
      serverIp: "139.224.25.197",
      serverPort: 443
    };
  }

  async exportSession(input: DingtoneSessionExportInput): Promise<DingtoneSessionExport> {
    const seed = [
      normalizeOptionalString(input.account?.dtUserId),
      normalizeOptionalString(input.account?.email),
      normalizeOptionalString(input.account?.phone),
      input.appVariant
    ]
      .filter((value): value is string => Boolean(value))
      .join(":")
      .trim() || "mock";

    const dtUserId = normalizeOptionalString(input.account?.dtUserId) ?? `145138329${stableHash(seed).slice(0, 8)}`;
    const tokenSeed = `${seed}:token`;
    const deviceSeed = `${seed}:device`;

    return {
      dtUserId,
      token: stableToken(tokenSeed),
      deviceId: normalizeOptionalString(input.account?.deviceId) ?? `Android.${stableHash(deviceSeed).slice(0, 32)}.dttalk`,
      dingtoneId: `mock-${stableHash(`${seed}:dingtone`).slice(0, 8)}`
    };
  }

  async refreshSnapshot(account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
  }): Promise<DingtoneSnapshot> {
    return makeSnapshot(account);
  }

  async listPhoneNumbers(_account: { dtUserId: string; token: string; deviceId?: string | null }): Promise<DingtonePhoneNumber[]> {
    return [
      {
        phoneNumber: "+15550001111",
        countryCode: 1,
        displayName: "Primary Mock Number",
        status: "active" as const,
        validPeriodDays: 30,
        autoRenew: true,
        isPrimary: true
      },
      {
        phoneNumber: "+33612000000",
        countryCode: 33,
        displayName: "Trial Number",
        status: "paused" as const,
        purchaseType: 1,
        validPeriodDays: 7
      }
    ];
  }

  async requestPhoneNumber(
    _account: { dtUserId: string; token: string; deviceId?: string | null },
    payload: { countryCode?: number }
  ): Promise<DingtonePhonePurchasePreview> {
    const countryCode = payload.countryCode ?? 1;
    const makeCandidate = (suffix: string, price: number, level = 0): DingtonePhonePurchaseCandidate => ({
      phoneNumber: `+${countryCode}${suffix}`,
      countryCode,
      areaCode: Number(String(suffix).slice(0, 3)),
      providerId: 2000,
      packageServiceId: countryCode === 86 ? "DT02030" : "DT01001",
      category: level > 0 ? 2 : 0,
      phoneType: 2,
      displayName: countryCode === 86 ? "中国测试号" : "Mock Number",
      cityName: countryCode === 86 ? "上海" : "Los Angeles",
      stateName: countryCode === 86 ? "上海" : "California",
      isoCountryCode: countryCode === 86 ? "CN" : "US",
      goodNumberLevel: level,
      useHistory: 0,
      price,
      rawJson: JSON.stringify({ mock: true, countryCode, price, suffix })
    });

    return {
      freeChance: 0,
      candidates: [
        makeCandidate("13800138000", 16),
        makeCandidate("13900139000", 22, 1),
        makeCandidate("18888886666", 66, 2)
      ],
      rawJson: JSON.stringify({ mock: true, countryCode })
    };
  }

  async purchasePhoneNumber(
    _account: { dtUserId: string; token: string; deviceId?: string | null },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; candidate: DingtonePhonePurchaseCandidate }
  ): Promise<DingtonePhoneNumber> {
    return {
      phoneNumber: payload.candidate.phoneNumber,
      countryCode: payload.candidate.countryCode ?? payload.countryCode ?? 1,
      providerId: payload.candidate.providerId ?? 2000,
      displayName: payload.candidate.displayName ?? "New Mock Number",
      status: "active" as const,
      purchaseType: payload.candidate.category,
      payType: payload.candidate.phoneType,
      validPeriodDays: 30,
      autoRenew: false,
      isPrimary: false,
      isGoodNumber: (payload.candidate.goodNumberLevel ?? 0) > 0,
      rawJson: JSON.stringify({ mock: true, purchased: true, candidate: payload.candidate })
    };
  }

  async renewPhoneNumber(
    _account: { dtUserId: string; token: string; deviceId?: string | null },
    _phoneNumber: string
  ): Promise<Partial<DingtonePhoneNumber>> {
    return {
      status: "active" as const,
      validPeriodDays: 30
    };
  }

  async cancelPhoneNumber() {}

  async pausePhoneNumber() {}

  async resumePhoneNumber() {}
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stableHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableToken(value: string) {
  return crypto.createHash("md5").update(value).digest("hex");
}
