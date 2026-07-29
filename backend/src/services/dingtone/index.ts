import type {
  DingtoneGateway,
  DingtoneLoginInput,
  DingtoneLoginResult,
  DingtonePhonePurchaseCandidate,
  DingtonePhonePurchasePreview,
  DingtoneSessionExport,
  DingtoneSessionExportInput,
  DingtonePhoneNumber,
  DingtoneSnapshot,
  VerificationRequestResult
} from "./types.js";
import { DirectDingtoneGateway } from "./direct-gateway.js";
import { MockDingtoneGateway } from "./mock-gateway.js";
import { RealDingtoneGateway } from "./real-gateway.js";
import { getGatewayMode } from "../settings.service.js";

const directGateway = new DirectDingtoneGateway();
const mockGateway = new MockDingtoneGateway();
const realGateway = new RealDingtoneGateway();

async function resolveGateway(): Promise<DingtoneGateway> {
  const mode = await getGatewayMode();
  if (mode === "direct") {
    return directGateway;
  }
  if (mode === "mock") {
    return mockGateway;
  }
  return realGateway;
}

async function resolveActivationGateway(): Promise<DingtoneGateway> {
  const mode = await getGatewayMode();
  if (mode === "direct") {
    return directGateway;
  }
  if (mode === "mock") {
    return mockGateway;
  }
  return realGateway;
}

export const dingtoneGateway: DingtoneGateway = {
  async sendVerificationCode(input: DingtoneLoginInput): Promise<VerificationRequestResult> {
    return (await resolveActivationGateway()).sendVerificationCode(input);
  },
  async login(input: DingtoneLoginInput): Promise<DingtoneLoginResult> {
    return (await resolveActivationGateway()).login(input);
  },
  async exportSession(input: DingtoneSessionExportInput): Promise<DingtoneSessionExport> {
    return (await resolveGateway()).exportSession(input);
  },
  async refreshSnapshot(account: {
    dtUserId: string;
    token: string;
    deviceId?: string | null;
    email?: string | null;
    phone?: string | null;
    appVariant?: "dingtone" | "dingdong";
  }): Promise<DingtoneSnapshot> {
    return (await resolveGateway()).refreshSnapshot(account);
  },
  async listPhoneNumbers(account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" }): Promise<DingtonePhoneNumber[]> {
    return (await resolveGateway()).listPhoneNumbers(account);
  },
  async requestPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; areaCode?: number | null }
  ): Promise<DingtonePhonePurchasePreview> {
    return (await resolveGateway()).requestPhoneNumber(account, payload);
  },
  async purchasePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
    payload: { countryCode?: number; isoCountryCode?: string | null; countryKey?: string | null; candidate: DingtonePhonePurchaseCandidate }
  ): Promise<DingtonePhoneNumber> {
    return (await resolveGateway()).purchasePhoneNumber(account, payload);
  },
  async renewPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null; appVariant?: "dingtone" | "dingdong" },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<Partial<DingtonePhoneNumber>> {
    return (await resolveGateway()).renewPhoneNumber(account, phoneNumber, phone);
  },
  async cancelPhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<void> {
    return (await resolveGateway()).cancelPhoneNumber(account, phoneNumber, phone);
  },
  async pausePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<void> {
    return (await resolveGateway()).pausePhoneNumber(account, phoneNumber, phone);
  },
  async resumePhoneNumber(
    account: { dtUserId: string; token: string; deviceId?: string | null },
    phoneNumber: string,
    phone?: Partial<DingtonePhoneNumber>
  ): Promise<void> {
    return (await resolveGateway()).resumePhoneNumber(account, phoneNumber, phone);
  }
};
