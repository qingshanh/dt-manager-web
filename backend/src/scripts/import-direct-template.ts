import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { prisma } from "../lib/prisma.js";
import { DIRECT_TEMPLATE_SETTING_KEY_SET, validateDirectTemplateHex } from "../services/dingtone/direct-template.js";

export type CaptureFile = {
  adbEnvironment?: {
    cpuAbiList?: unknown;
    cpuAbi?: unknown;
    nativeBridge?: unknown;
    arm64Likely?: unknown;
    x86Likely?: unknown;
  };
  fridaEnvironment?: {
    arch?: unknown;
    java?: unknown;
    hasTzim?: unknown;
    nativeBridgeLikely?: unknown;
  };
  captures?: unknown[];
};

export type CaptureCandidate = {
  index: number;
  reason: string;
  fn: string;
  len: number;
  hex: string;
  score: number;
  frameType: string;
  status?: string;
  apiHints: string[];
  zlibPreview?: string;
  stringHints: string[];
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.captureFile || !options.settingKey) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (!DIRECT_TEMPLATE_SETTING_KEY_SET.has(options.settingKey)) {
    throw new Error(`Unsupported setting key: ${options.settingKey}`);
  }

  const absolute = path.resolve(options.captureFile);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8")) as CaptureFile;
  const environmentWarnings = getCaptureEnvironmentWarnings(parsed);
  for (const warning of environmentWarnings) {
    console.warn(`Warning: ${warning}`);
  }
  const candidates = collectCandidates(parsed, options.settingKey);
  if (candidates.length === 0) {
    throw new Error("No complete 0107 frames were found in capture file.");
  }
  if (requiresExplicitWriteIndex(options)) {
    throw new Error("Writing a direct template requires --index <candidate-index>. Run dry-run first, inspect the candidate hints, then write the chosen index.");
  }

  const selected =
    options.index === undefined ? candidates[0] : candidates.find((item) => item.index === options.index);
  if (!selected) {
    throw new Error(`No candidate with index ${options.index}. Run without --write to list candidates.`);
  }
  const selectedHex = validateDirectTemplateHex(options.settingKey, selected.hex);
  const confidence = candidateConfidence(selected, options.settingKey);
  if (options.write && confidence === "low" && (!options.allowLowConfidence || options.index === undefined)) {
    throw new Error(
      "Selected candidate has low confidence for this setting key. Re-run dry-run, inspect the candidate, then pass both --index <n> and --allow-low-confidence if you still want to write it."
    );
  }

  const template = {
    name: options.name ?? (selected.reason || options.settingKey),
    hex: selectedHex,
    params: defaultParamsFor(options.settingKey)
  };
  const value = JSON.stringify(template);

  console.log(`Capture file: ${absolute}`);
  console.log(`Setting key: ${options.settingKey}`);
  console.log(`Candidates: ${candidates.length}`);
  for (const item of candidates.slice(0, 10)) {
    console.log(
      `${item.index}. score=${item.score} type=${item.frameType} status=${item.status ?? "-"} reason=${item.reason || "-"} fn=${item.fn || "-"} len=${item.len} hex=${item.hex.slice(0, 32)}...`
    );
    if (item.apiHints.length > 0) {
      console.log(`   apiHints=${item.apiHints.join(",")}`);
    }
    if (item.zlibPreview) {
      console.log(`   zlib=${item.zlibPreview}`);
    } else if (item.stringHints.length > 0) {
      console.log(`   strings=${item.stringHints.join(" | ")}`);
    }
  }
  console.log("");
  console.log(`Selected: ${selected.index} (${confidence} confidence)`);
  console.log(value);

  if (options.write) {
    await prisma.setting.upsert({
      where: { key: options.settingKey },
      update: { value },
      create: {
        key: options.settingKey,
        value,
        description: `Imported direct template from ${path.basename(absolute)}`
      }
    });
    console.log(`Wrote ${options.settingKey}`);
  } else {
    console.log("Dry run only. Add --write to save this template into settings.");
    if (confidence === "low") {
      console.log("Low-confidence candidates are blocked from --write unless you also pass --index and --allow-low-confidence.");
    }
  }
}

export function collectCandidates(input: CaptureFile, settingKey: string): CaptureCandidate[] {
  return collectRawCaptures(input)
    .map((capture, index) => normalizeCapture(capture, index, settingKey))
    .filter((item): item is CaptureCandidate => Boolean(item))
    .sort((a, b) => b.score - a.score || b.len - a.len || a.index - b.index);
}

export function requiresExplicitWriteIndex(input: { write: boolean; index?: number }) {
  return input.write && input.index === undefined;
}

export function getCaptureEnvironmentWarnings(input: CaptureFile) {
  const warnings: string[] = [];
  const adb = input.adbEnvironment ?? {};
  const frida = input.fridaEnvironment ?? {};
  const abi = `${adb.cpuAbiList ?? ""} ${adb.cpuAbi ?? ""}`.trim();
  const nativeBridge = String(adb.nativeBridge ?? "").trim();
  const fridaArch = String(frida.arch ?? "").trim();
  const java = String(frida.java ?? "").trim();
  const hasTzim = frida.hasTzim === true;
  const nativeBridgeLikely = frida.nativeBridgeLikely === true;
  const x86Likely = adb.x86Likely === true || /\bx86/i.test(abi) || /^x64$/i.test(fridaArch);
  const arm64Likely = adb.arm64Likely === true || /arm64/i.test(abi);

  if (nativeBridgeLikely) {
    warnings.push(
      `Capture environment looks like x86/x86_64 native translation (abi=${abi || "-"}, fridaArch=${fridaArch || "-"}, nativeBridge=${nativeBridge || "-"}). Missing native frames from this capture are not reliable; use an arm64 emulator or real Android device before writing offline SMS or first-login templates.`
    );
  } else if (x86Likely && !arm64Likely) {
    warnings.push(
      `Capture environment appears x86/x86_64 only (abi=${abi || "-"}, fridaArch=${fridaArch || "-"}). Prefer an arm64 emulator or real Android device for TalkU native-frame evidence.`
    );
  }

  if (java && java !== "true") {
    warnings.push(`Frida Java availability was ${java}; Java login-candidate hooks may be incomplete in this capture.`);
  }
  if (nativeBridgeLikely && !hasTzim) {
    warnings.push("The TalkU native module was not visible in Frida; do not treat an empty capture as proof that the app skipped a request.");
  }

  return warnings;
}

function collectRawCaptures(input: unknown) {
  const captures: unknown[] = [];
  const seen = new Set<unknown>();

  function visit(value: unknown, pathName: string) {
    if (!value || typeof value !== "object") {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pathName}[${index}]`));
      return;
    }

    const record = value as Record<string, unknown>;
    const hasHex = ["preview", "hex", "templateHex", "frameHex", "rawHex", "rawHexPreview"].some((key) => typeof record[key] === "string");
    if (hasHex) {
      captures.push({ ...record, path: pathName });
    }

    for (const [key, child] of Object.entries(record)) {
      if (child && typeof child === "object") {
        visit(child, pathName ? `${pathName}.${key}` : key);
      }
    }
  }

  visit(input, "");
  return captures;
}

function normalizeCapture(value: unknown, index: number, settingKey: string): CaptureCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  const hex = trimCompleteDirectFrame(normalizeHex(String(value.preview ?? value.hex ?? value.templateHex ?? value.frameHex ?? value.rawHex ?? value.rawHexPreview ?? "")));
  if (!hex) {
    return null;
  }
  const reason = String(value.reason ?? value.name ?? value.path ?? "");
  const fn = String(value.fn ?? "");
  const len = Number(value.len ?? hex.length / 2);
  const analysis = analyzeDirectFrame(Buffer.from(hex, "hex"));
  return {
    index,
    reason,
    fn,
    len: Number.isFinite(len) ? len : hex.length / 2,
    hex,
    score: scoreCandidate(reason, fn, hex, settingKey, analysis),
    ...analysis
  };
}

function scoreCandidate(reason: string, fn: string, hex: string, settingKey: string, analysis: CaptureFrameAnalysis) {
  const text = `${reason} ${fn} ${analysis.apiHints.join(" ")} ${analysis.zlibPreview ?? ""} ${analysis.stringHints.join(" ")}`.toLowerCase();
  let score = 0;
  for (const hint of expectedHintsFor(settingKey)) {
    if (text.includes(hint)) {
      score += 120;
    }
  }
  if (text.includes("requestallofflinemessage")) score += 100;
  if (text.includes("offline")) score += 50;
  if (text.includes("recoverpassword") || text.includes("verifyaccesscode")) score += 80;
  if (text.includes("login") || text.includes("sms") || text.includes("verification") || text.includes("code")) score += 25;
  if (text.includes("native-offset") || text.includes("native-symbol")) score += 10;
  if (hex.slice(12, 16).toLowerCase() === "8107") score += 5;
  return score;
}

export function candidateConfidence(candidate: CaptureCandidate, settingKey: string) {
  const text = `${candidate.reason} ${candidate.fn} ${candidate.apiHints.join(" ")} ${candidate.zlibPreview ?? ""} ${candidate.stringHints.join(" ")}`.toLowerCase();
  const expected = expectedHintsFor(settingKey);
  if (expected.some((hint) => text.includes(hint))) {
    return "high";
  }
  if (candidate.score >= 80) {
    return "medium";
  }
  return "low";
}

type CaptureFrameAnalysis = {
  frameType: string;
  status?: string;
  apiHints: string[];
  zlibPreview?: string;
  stringHints: string[];
};

function analyzeDirectFrame(frame: Buffer): CaptureFrameAnalysis {
  const body = frame.subarray(22);
  const frameType = frame.length >= 8 ? `0x${frame.readUInt16BE(6).toString(16).padStart(4, "0")}` : "unknown";
  const status = frame.length >= 18 ? `0x${frame.readUInt16BE(16).toString(16).padStart(4, "0")}` : undefined;
  const inflated = inflateFirstZlibText(body);
  const stringHints = extractPrintableStrings(body).filter((item) => looksInteresting(item)).slice(0, 5);
  const apiHints = findApiHints([inflated ?? "", ...stringHints].join(" "));
  return {
    frameType,
    status,
    apiHints,
    zlibPreview: inflated ? summarizeText(inflated, 220) : undefined,
    stringHints: stringHints.map((item) => summarizeText(item, 120))
  };
}

function inflateFirstZlibText(buffer: Buffer) {
  for (const offset of findZlibOffsets(buffer)) {
    try {
      return zlib.inflateSync(buffer.subarray(offset)).toString("utf8");
    } catch {
      continue;
    }
  }
  return undefined;
}

function findZlibOffsets(buffer: Buffer) {
  const offsets: number[] = [];
  for (let index = 0; index < buffer.length - 1; index += 1) {
    const current = buffer[index];
    const next = buffer[index + 1];
    if (current === 0x78 && next !== undefined && [0x01, 0x9c, 0xda].includes(next)) {
      offsets.push(index);
    }
  }
  return offsets;
}

function extractPrintableStrings(buffer: Buffer) {
  const strings: string[] = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte < 127) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length >= 4) {
      strings.push(current);
    }
    current = "";
  }
  if (current.length >= 4) {
    strings.push(current);
  }
  return strings;
}

function looksInteresting(value: string) {
  return /(api|rest|offline|login|verify|verification|sms|code|phone|email|token|userid|trackcode|pstn|share)/i.test(value);
}

function findApiHints(text: string) {
  const normalized = text.toLowerCase();
  return [
    "checkActivatedUser",
    "registerEmail",
    "activateEmail",
    "requestAllOfflineMessage",
    "getWebOfflineMessage",
    "recoverPassword",
    "verifyAccessCode",
    "login",
    "sms",
    "phone",
    "email",
    "/pstn/share"
  ].filter((hint) => normalized.includes(hint.toLowerCase()));
}

function expectedHintsFor(settingKey: string) {
  switch (baseTemplateSettingKey(settingKey)) {
    case "dt_direct_template_check_activated_user":
      return ["checkactivateduser", "check_activated_user"];
    case "dt_direct_template_register_email":
      return ["registeremail", "register_email"];
    case "dt_direct_template_activate_email":
      return ["activateemail", "activate_email", "activatecommon", "confirmcode"];
    case "dt_direct_template_request_phone":
      return ["getprivatenumber", "/pstn/share/getprivatenumber"];
    case "dt_direct_template_purchase_phone":
    case "dt_direct_template_renew_phone":
      return ["orderprivatenumber", "/pstn/share/orderprivatenumber"];
    case "dt_direct_template_cancel_phone":
      return ["deletephonenumber", "/pstn/share/deletephonenumber"];
    case "dt_direct_template_pause_phone":
    case "dt_direct_template_resume_phone":
    case "dt_direct_template_phone_setting":
      return ["privatenumbersetting", "/pstn/share/privatenumbersetting"];
    case "dt_direct_template_offline_messages":
      return ["requestallofflinemessage", "offline"];
    default:
      return [];
  }
}

function summarizeText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function normalizeHex(value: string) {
  const pairs = value.match(/[0-9a-fA-F]{2}/g);
  return pairs ? pairs.join("").toLowerCase() : "";
}

function trimCompleteDirectFrame(hex: string) {
  if (!hex.startsWith("0107") || hex.length < 24 || hex.length % 2 !== 0) {
    return null;
  }
  const lengthHex = hex.slice(4, 12);
  const declared = Number.parseInt(lengthHex, 16);
  if (!Number.isFinite(declared) || declared < 22 || declared * 2 > hex.length) {
    return null;
  }
  return hex.slice(0, declared * 2);
}

export function defaultParamsFor(settingKey: string) {
  const baseKey = baseTemplateSettingKey(settingKey);
  if (baseKey === "dt_direct_template_check_activated_user") {
    return {
      deviceId: "$deviceId",
      deviceID: "$deviceId",
      json: "$jsonCondition",
      jsonCondition: "$jsonCondition",
      countryCode: "$countryCode",
      areaCode: "$areaCode",
      trackCode: "$TrackCode"
    };
  }
  if (baseKey === "dt_direct_template_register_email") {
    return {
      deviceId: "$deviceId",
      deviceID: "$deviceId",
      email: "$email",
      Email: "$json.Email",
      json_Email: "$json.Email",
      clientInfo: "$clientInfo"
    };
  }
  if (baseKey === "dt_direct_template_activate_email") {
    return {
      deviceId: "$deviceId",
      deviceID: "$deviceId",
      confirmCode: "$confirmCode",
      json: "$json",
      Email: "$json.Email",
      json_Email: "$json.Email",
      clientInfo: "$clientInfo"
    };
  }
  if (settingKey === "dt_direct_template_offline_messages") {
    return {
      deviceId: "$deviceId",
      userId: "$userId",
      token: "$token",
      trackCode: "$trackCode",
      action: "$action"
    };
  }
  return {
    deviceId: "$deviceId",
    userId: "$userId",
    token: "$token",
    trackCode: "$trackCode"
  };
}

function baseTemplateSettingKey(settingKey: string) {
  return settingKey.replace(/_(talku|dingdong)$/i, "");
}

function parseArgs(args: string[]) {
  const options: {
    captureFile?: string;
    settingKey?: string;
    index?: number;
    name?: string;
    write: boolean;
    allowLowConfidence: boolean;
  } = { write: false, allowLowConfidence: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--capture-file") {
      options.captureFile = args[++i];
    } else if (arg === "--setting-key") {
      options.settingKey = args[++i];
    } else if (arg === "--index") {
      const parsed = Number(args[++i]);
      options.index = Number.isInteger(parsed) ? parsed : undefined;
    } else if (arg === "--name") {
      options.name = args[++i];
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--allow-low-confidence") {
      options.allowLowConfidence = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage() {
  console.log(`Usage:
  npm run import:direct-template -- --capture-file ../_tmp/talku-offline-capture.json --setting-key dt_direct_template_offline_messages
  npm run import:direct-template -- --capture-file ../_tmp/talku-offline-capture.json --setting-key dt_direct_template_offline_messages --index <candidate-index> --write

Options:
  --capture-file <path>     JSON generated by tools/run-talku-offline-capture.py
  --setting-key <key>       Direct template setting key to write
  --index <n>               Pick a specific capture candidate index; required with --write
  --name <name>             Override template name
  --allow-low-confidence    Permit writing an explicitly selected low-confidence candidate
  --write                   Save into settings; otherwise dry-run only`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
