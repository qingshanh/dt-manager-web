import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { prisma } from "../lib/prisma.js";
import {
  runDirectSessionProbe,
  type DirectProbeCustomTemplate,
  type DirectProbeResult
} from "../services/dingtone/direct-gateway.js";
import { decryptText } from "../utils/crypto.js";

type CliOptions = {
  accountId?: number;
  dtUserId?: string;
  token?: string;
  deviceId?: string;
  listenSeconds: number;
  maxPushFrames: number;
  phonePreviewCountryCode?: number;
  templateFile?: string;
  save?: string;
  json: boolean;
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
  const options = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp();
    return;
  }

  const account = await resolveAccount(options);
  const customTemplates = options.templateFile ? await readCustomTemplates(options.templateFile) : [];
  const result = await runDirectSessionProbe({
    account,
    listenSeconds: options.listenSeconds,
    maxPushFrames: options.maxPushFrames,
    customTemplates,
    phonePreviewCountryCode: options.phonePreviewCountryCode
  });

  const output = {
    ...result,
    accountId: account.accountId,
    token: redactSecret(account.token)
  };

  if (options.save) {
    await fs.writeFile(path.resolve(options.save), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  }

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    printSummary(output, options);
  }

  if (!result.ok) {
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
    dtUserId: parseOptionalString(values.get("dt-user-id")),
    token: parseOptionalString(values.get("token")),
    deviceId: parseOptionalString(values.get("device-id")),
    listenSeconds: parseOptionalPositiveInt(values.get("listen-seconds"), "listen-seconds") ?? 0,
    maxPushFrames: parseOptionalPositiveInt(values.get("max-push-frames"), "max-push-frames") ?? 5,
    phonePreviewCountryCode: parseOptionalPositiveInt(values.get("phone-preview-country"), "phone-preview-country"),
    templateFile: parseOptionalString(values.get("template-file")),
    save: parseOptionalString(values.get("save")),
    json: values.get("json") === true
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
        where: {
          dtUserId: { not: null },
          dtToken: { not: null }
        },
        orderBy: { updatedAt: "desc" }
      });

  if (!account) {
    throw new Error(
      "No captured account found. Use --account-id, or pass --dt-user-id and --token directly."
    );
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
    deviceId: options.deviceId ?? account.dtDeviceId,
    email: account.email,
    phone: account.phone
  };
}

async function readCustomTemplates(filePath: string): Promise<DirectProbeCustomTemplate[]> {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];

  return list.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Template item #${index + 1} must be an object.`);
    }
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : `custom_${index + 1}`;
    if (typeof item.hex !== "string" || !item.hex.trim()) {
      throw new Error(`Template item ${name} is missing hex.`);
    }
    if (item.params !== undefined && !isRecord(item.params)) {
      throw new Error(`Template item ${name} params must be an object.`);
    }
    return {
      name,
      hex: item.hex,
      params: item.params as DirectProbeCustomTemplate["params"]
    };
  });
}

function printSummary(result: DirectProbeResult & { accountId?: number; token: string }, options: CliOptions) {
  const accountLabel = result.accountId ? `account #${result.accountId}` : `dtUserId ${result.dtUserId}`;
  console.log(`Direct session probe for ${accountLabel}`);
  console.log(`Host: ${result.host}`);
  console.log(`Device: ${result.deviceId ?? "(none)"}`);
  console.log(`Token: ${result.token}`);
  console.log("");
  console.log("Post-login API checks:");

  for (const call of result.calls) {
    const status = call.ok ? "OK" : "FAIL";
    const detail = call.ok ? summarizePayload(call.payload) : call.error ?? "unknown error";
    console.log(`- ${status} ${call.name} (${call.durationMs}ms): ${detail}`);
  }

  if (options.listenSeconds > 0) {
    console.log("");
    console.log(`Push listen window: ${options.listenSeconds}s`);
    if (result.pushes.length === 0) {
      console.log("- No push frame observed in this window.");
    }
    for (const push of result.pushes) {
      const sms = push.sms;
      const smsSummary = sms
        ? ` sms k1=${sms.msgType} from=${sms.fromNumber ?? "(unknown)"} content=${JSON.stringify(sms.content)}`
        : "";
      console.log(`- PUSH status=${push.status ?? "(unknown)"} bytes=${push.bodyLength}${smsSummary}`);
    }
  }

  if (options.save) {
    console.log("");
    console.log(`Full JSON saved to ${path.resolve(options.save)}`);
  }
}

function summarizePayload(payload: unknown) {
  if (!isRecord(payload)) {
    return "received non-object payload";
  }
  const keys = Object.keys(payload);
  const code = payload.code ?? payload.errCode ?? payload.errorCode;
  const listSize = findFirstArray(payload)?.length;
  const pieces = [`keys=${keys.slice(0, 8).join(",") || "(none)"}`];
  if (code !== undefined) {
    pieces.push(`code=${String(code)}`);
  }
  if (listSize !== undefined) {
    pieces.push(`arrayItems=${listSize}`);
  }
  return pieces.join(" ");
}

function findFirstArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const item of Object.values(value)) {
    const found = findFirstArray(item);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function parseOptionalString(value: string | boolean | undefined) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalPositiveInt(value: string | boolean | undefined, label: string) {
  const text = parseOptionalString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer.`);
  }
  return parsed;
}

function redactSecret(value: string) {
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printHelp() {
  console.log(`Usage:
  npm run verify:direct-session -- --account-id 1 --listen-seconds 30
  npm run verify:direct-session -- --dt-user-id 123 --token xxx --device-id Android.xxx.dttalk

Options:
  --account-id <id>          Read a captured account from Prisma and decrypt dtToken.
  --dt-user-id <id>          Use a raw Dingtone user id instead of database lookup.
  --token <token>            Use a raw token with --dt-user-id.
  --device-id <deviceId>     Override device id when using raw credentials.
  --listen-seconds <sec>     Keep the direct socket open and wait for PUSH frames.
  --max-push-frames <n>      Stop listening after n PUSH frames. Default: 5.
  --phone-preview-country <countryCode>
                             Also run a safe requestPrivateNumber preview probe for this country.
  --template-file <path>     Optional JSON template(s) captured from Android traffic.
  --save <path>              Save full JSON result.
  --json                     Print full JSON result to stdout.
`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
