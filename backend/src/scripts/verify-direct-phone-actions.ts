import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { prisma } from "../lib/prisma.js";
import { DirectDingtoneGateway, type DirectPhoneActionDryRun } from "../services/dingtone/direct-gateway.js";
import type { DingtonePhoneNumber, DingtonePhonePurchaseCandidate } from "../services/dingtone/types.js";
import { decryptText } from "../utils/crypto.js";

type CliOptions = {
  accountId?: number;
  phoneId?: number;
  phoneNumber?: string;
  candidateFile?: string;
  json: boolean;
};

type ProbeAccount = {
  accountId?: number;
  dtUserId: string;
  token: string;
  deviceId?: string | null;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const account = await resolveAccount(options);
  const phone = await resolvePhone(options, account.accountId);
  const candidate = options.candidateFile ? await readCandidate(options.candidateFile) : undefined;
  const gateway = new DirectDingtoneGateway();
  const actions = await gateway.buildPhoneActionDryRuns(
    {
      dtUserId: account.dtUserId,
      token: account.token,
      deviceId: account.deviceId
    },
    {
      phoneNumber: phone?.phoneNumber ?? options.phoneNumber,
      phone,
      candidate,
      countryCode: candidate?.countryCode
    }
  );

  const output = {
    ok: actions.length > 0,
    accountId: account.accountId,
    dtUserId: account.dtUserId,
    deviceId: account.deviceId,
    phoneNumber: phone?.phoneNumber ?? options.phoneNumber,
    candidatePhoneNumber: candidate?.phoneNumber,
    actions
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printSummary(output);
  }

  if (actions.length === 0) {
    process.exitCode = 2;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith("--")) {
      continue;
    }
    const equalsIndex = current.indexOf("=");
    if (equalsIndex >= 0) {
      values.set(current.slice(2, equalsIndex), current.slice(equalsIndex + 1));
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      values.set(key, true);
    }
  }

  return {
    accountId: parseOptionalPositiveInt(values.get("account-id"), "account-id"),
    phoneId: parseOptionalPositiveInt(values.get("phone-id"), "phone-id"),
    phoneNumber: parseOptionalString(values.get("phone-number")),
    candidateFile: parseOptionalString(values.get("candidate-file")),
    json: values.get("json") === true
  };
}

async function resolveAccount(options: CliOptions): Promise<ProbeAccount> {
  const account = options.accountId
    ? await prisma.dtAccount.findUnique({ where: { id: options.accountId } })
    : await prisma.dtAccount.findFirst({
        where: {
          dtUserId: { not: null },
          dtToken: { not: null }
        },
        orderBy: { updatedAt: "desc" }
      });

  if (!account) {
    throw new Error("No captured account found. Use --account-id after importing or capturing a session.");
  }
  if (!account.dtUserId) {
    throw new Error(`Account ${account.id} does not have dtUserId.`);
  }

  const token = decryptText(account.dtToken);
  if (!token) {
    throw new Error(`Account ${account.id} does not have a decryptable dtToken.`);
  }

  return {
    accountId: account.id,
    dtUserId: account.dtUserId,
    token,
    deviceId: account.dtDeviceId
  };
}

async function resolvePhone(options: CliOptions, accountId?: number): Promise<DingtonePhoneNumber | undefined> {
  const item = options.phoneId
    ? await prisma.phoneNumber.findUnique({ where: { id: options.phoneId } })
    : accountId
      ? await prisma.phoneNumber.findFirst({
          where: { accountId },
          orderBy: [{ isPrimary: "desc" }, { updatedAt: "desc" }]
        })
      : null;

  if (item) {
    return {
      phoneNumber: item.phoneNumber,
      countryCode: item.countryCode ?? undefined,
      providerId: item.providerId ?? undefined,
      displayName: item.displayName ?? undefined,
      status: item.status,
      purchaseType: item.purchaseType ?? undefined,
      payType: item.payType ?? undefined,
      validPeriodDays: item.validPeriodDays ?? undefined,
      gainTime: item.gainTime ?? undefined,
      expiredTime: item.expiredTime ?? undefined,
      autoRenew: item.autoRenew,
      isPrimary: item.isPrimary,
      isGoodNumber: item.isGoodNumber,
      portoutInfo: item.portoutInfo ?? undefined,
      rawJson: item.rawJson ?? undefined
    };
  }

  if (options.phoneNumber) {
    return { phoneNumber: options.phoneNumber };
  }

  return undefined;
}

async function readCandidate(filePath: string): Promise<DingtonePhonePurchaseCandidate> {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Candidate file must contain a JSON object.");
  }
  if (typeof parsed.phone_number !== "string" && typeof parsed.phoneNumber !== "string") {
    throw new Error("Candidate file must include phone_number or phoneNumber.");
  }
  return {
    phoneNumber: String(parsed.phoneNumber ?? parsed.phone_number),
    countryCode: parseOptionalPositiveInt(parsed.countryCode ?? parsed.country_code, "candidate countryCode"),
    areaCode: parseOptionalPositiveInt(parsed.areaCode ?? parsed.area_code, "candidate areaCode"),
    providerId: parseOptionalPositiveInt(parsed.providerId ?? parsed.provider_id, "candidate providerId"),
    packageServiceId: parseOptionalString(parsed.packageServiceId ?? parsed.package_service_id),
    category: parseOptionalPositiveInt(parsed.category, "candidate category"),
    phoneType: parseOptionalPositiveInt(parsed.phoneType ?? parsed.phone_type, "candidate phoneType"),
    price: parseOptionalNumber(parsed.price),
    rawJson: JSON.stringify(parsed)
  };
}

function printSummary(output: {
  ok: boolean;
  accountId?: number;
  dtUserId: string;
  deviceId?: string | null;
  phoneNumber?: string;
  candidatePhoneNumber?: string;
  actions: DirectPhoneActionDryRun[];
}) {
  const accountLabel = output.accountId ? `account #${output.accountId}` : `dtUserId ${output.dtUserId}`;
  console.log(`Direct phone action dry-run for ${accountLabel}`);
  console.log(`Device: ${output.deviceId ?? "(none)"}`);
  console.log(`Stored phone: ${output.phoneNumber ?? "(none)"}`);
  console.log(`Purchase candidate: ${output.candidatePhoneNumber ?? "(none)"}`);
  console.log("");
  for (const action of output.actions) {
    console.log(`${action.label}: ${action.apiName}`);
    console.log(`  ${action.query}`);
  }
  if (output.actions.length === 0) {
    console.log("No actions built. Provide --phone-id/--phone-number and/or --candidate-file.");
  }
}

function printHelp() {
  console.log(`Usage:
  npm run verify:direct-phone-actions -- --account-id 1 --phone-id 10
  npm run verify:direct-phone-actions -- --account-id 1 --phone-number +33123456789 --json
  npm run verify:direct-phone-actions -- --account-id 1 --candidate-file ./candidate.json

This is a dry-run helper. It builds the direct socket API names and query strings only; it does not send purchase, renew, cancel, pause, or resume requests.`);
}

function parseOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOptionalPositiveInt(value: unknown, name: string) {
  if (value === undefined || value === false) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalNumber(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
