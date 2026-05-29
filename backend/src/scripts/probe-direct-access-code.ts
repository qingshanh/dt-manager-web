import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { prisma } from "../lib/prisma.js";
import { buildDirectAccessCodeDryRun, runDirectAccessCodeProbe } from "../services/dingtone/direct-gateway.js";
import { decryptText } from "../utils/crypto.js";

type CliOptions = {
  accountId?: number;
  dtUserId?: string;
  token?: string;
  deviceId?: string;
  kind: "email" | "phone";
  target?: string;
  countryCode?: number;
  accessCode?: string;
  noCode?: number;
  save?: string;
  json: boolean;
  dryRun: boolean;
  confirm: boolean;
};

type ProbeAccount = {
  accountId?: number;
  dtUserId: string;
  token: string;
  deviceId?: string | null;
  email?: string | null;
  phone?: string | null;
};

async function main() {
  const options = parseAccessCodeProbeCliArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const account = options.dryRun ? undefined : await resolveAccount(options);
  const target = resolveTarget(options, account);
  if (options.dryRun) {
    const output = buildDirectAccessCodeDryRun({
      kind: options.kind,
      target,
      countryCode: options.countryCode,
      accessCode: options.accessCode,
      noCode: options.noCode
    });
    await writeOutput(options, output);
    printDryRun(options, output);
    return;
  }

  if (!account) {
    throw new Error("Missing account.");
  }
  if (!options.confirm) {
    throw new Error("Real access-code probes can trigger SMS. Re-run with both --real and --confirm after reviewing dry-run output.");
  }
  const result = await runDirectAccessCodeProbe({
    account,
    kind: options.kind,
    target,
    countryCode: options.countryCode,
    accessCode: options.accessCode,
    noCode: options.noCode
  });
  const output = {
    ...result,
    accountId: account.accountId,
    kind: options.kind,
    target: redactTarget(options.kind, target)
  };

  await writeOutput(options, output);

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printSummary(output);
  }

  if (!result.ok) {
    process.exitCode = 2;
  }
}

export function parseAccessCodeProbeCliArgs(argv: string[]): CliOptions {
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

  const kind = parseKind(values.get("kind"));
  return {
    accountId: parseOptionalPositiveInt(values.get("account-id"), "account-id"),
    dtUserId: parseOptionalString(values.get("dt-user-id")),
    token: parseOptionalString(values.get("token")),
    deviceId: parseOptionalString(values.get("device-id")),
    kind,
    target: parseOptionalString(values.get("target")),
    countryCode: parseOptionalPositiveInt(values.get("country-code"), "country-code"),
    accessCode: parseOptionalString(values.get("access-code")),
    noCode: parseOptionalNonNegativeInt(values.get("no-code"), "no-code"),
    save: parseOptionalString(values.get("save")),
    json: values.get("json") === true,
    dryRun: values.get("real") !== true,
    confirm: values.get("confirm") === true
  };
}

async function resolveAccount(options: CliOptions): Promise<ProbeAccount> {
  if (options.dtUserId && options.token) {
    return {
      dtUserId: options.dtUserId,
      token: options.token,
      deviceId: options.deviceId
    };
  }

  const account = options.accountId
    ? await prisma.dtAccount.findUnique({ where: { id: options.accountId } })
    : await prisma.dtAccount.findFirst({
        where: { dtUserId: { not: null }, dtToken: { not: null } },
        orderBy: { updatedAt: "desc" }
      });
  if (!account?.dtUserId || !account.dtToken) {
    throw new Error("No account with dt_user_id and dt_token was found. Pass --account-id or --dt-user-id/--token.");
  }
  return {
    accountId: account.id,
    dtUserId: account.dtUserId,
    token: decryptText(account.dtToken) ?? "",
    deviceId: account.dtDeviceId,
    email: account.email,
    phone: account.phone
  };
}

function resolveTarget(options: CliOptions, account?: ProbeAccount) {
  const target = options.target ?? (options.kind === "email" ? account?.email : account?.phone);
  if (!target?.trim()) {
    throw new Error(`Missing ${options.kind} target. Pass --target.`);
  }
  assertValidCliTarget(options.kind, target);
  return target.trim();
}

export function assertValidCliTarget(kind: "email" | "phone", target: string) {
  const trimmed = target.trim();
  if (kind === "email") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
      throw new Error("Invalid email target. Pass a valid --target email address.");
    }
    return;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new Error("Invalid phone target. Pass a 7-15 digit --target phone number.");
  }
}

function parseKind(value: string | boolean | undefined): "email" | "phone" {
  const normalized = parseOptionalString(value)?.toLowerCase();
  if (normalized === "email" || normalized === "phone") {
    return normalized;
  }
  return "phone";
}

function parseOptionalString(value: string | boolean | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOptionalPositiveInt(value: string | boolean | undefined, name: string) {
  if (value === undefined || value === false || value === true || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalNonNegativeInt(value: string | boolean | undefined, name: string) {
  if (value === undefined || value === false || value === true || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return parsed;
}

function redactTarget(kind: "email" | "phone", target: string) {
  if (kind === "email") {
    const [name = "", domain = ""] = target.split("@");
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return target.replace(/(\d{2})\d+(\d{2})$/, "$1***$2");
}

function printSummary(output: Awaited<ReturnType<typeof runDirectAccessCodeProbe>> & { accountId?: number; kind: string; target: string }) {
  console.log(`Direct access-code probe account=${output.accountId ?? output.dtUserId} kind=${output.kind} target=${output.target}`);
  console.log(`Host: ${output.host}`);
  console.log(`Capability: ${output.capability.mode}; loginTokenCompleted=${output.capability.loginTokenCompleted}`);
  console.log(`recoverPassword: ${formatCall(output.recoverPassword)}`);
  console.log(`verifyAccessCode: ${formatCall(output.verifyAccessCode)}`);
}

async function writeOutput(options: CliOptions, output: unknown) {
  if (options.save) {
    await fs.writeFile(path.resolve(options.save), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }
}

function printDryRun(options: CliOptions, output: ReturnType<typeof buildDirectAccessCodeDryRun>) {
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`Direct access-code dry-run kind=${output.kind} target=${output.target}`);
  console.log(`Capability: ${output.capability.mode}; loginTokenCompleted=${output.capability.loginTokenCompleted}`);
  console.log(`recoverPassword: ${output.recoverPassword.query}`);
  console.log(`recoverPassword params: ${JSON.stringify(output.recoverPassword.params)}`);
  console.log(`verifyAccessCode: ${output.verifyAccessCode?.query ?? "skipped"}`);
  if (output.verifyAccessCode) {
    console.log(`verifyAccessCode params: ${JSON.stringify(output.verifyAccessCode.params)}`);
  }
}

function formatCall(call: { ok: boolean; durationMs: number; error?: string; payload?: unknown } | undefined) {
  if (!call) {
    return "skipped";
  }
  if (!call.ok) {
    return `failed in ${call.durationMs}ms: ${call.error}`;
  }
  return `ok in ${call.durationMs}ms: ${JSON.stringify(call.payload)}`;
}

function printHelp() {
  console.log(`Usage:
  npm run probe:direct-access-code -- --kind phone --target +15551234567 --country-code 1 --access-code 123456 --json
  npm run probe:direct-access-code -- --account-id 3 --kind phone --target 15551234567 --real --confirm
  npm run probe:direct-access-code -- --account-id 3 --kind phone --target 15551234567 --access-code 123456 --real --confirm --json

This probe follows the APK recoverPassword / verifyAccessCode chain:
  recoverPassword: json,type,noCode
  verifyAccessCode: json,type,accessCode

Default mode is dry-run and does not connect to Dingtone. Real probes require both --real and --confirm.
It is for reverse-engineering verification only. It does not mark an account as logged in.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => undefined);
    });
}
