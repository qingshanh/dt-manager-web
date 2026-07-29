import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { DingtonePhonePurchasePreview } from "./dingtone/types.js";
import { execAdb, resolveAdbApp, resolveAdbSerial, type AdbAppVariant } from "./adb-app.js";
import { assertAdbAppSessionMatchesExpectedUser } from "./adb-session.js";

const execFileAsync = promisify(execFile);
const SEARCH_ACTIVITY = "me.dingtone.app.im.activity.PrivatePhoneSearchActivity";

export async function previewPhoneNumbersFromAdb(
  countryCode: number,
  isoCountryCode: string | null | undefined,
  variant: AdbAppVariant,
  expectedDtUserId: string
): Promise<DingtonePhonePurchasePreview> {
  await assertAdbAppSessionMatchesExpectedUser(variant, expectedDtUserId);
  const serial = await resolveAdbSerial();
  const app = resolveAdbApp(variant);
  const applyPhoneType = resolveApplyPhoneType(countryCode, isoCountryCode);
  if (!applyPhoneType) {
    throw new Error(`No adb preview mapping for countryCode=${countryCode}`);
  }

  const localXmlPath = join("C:\\tmp", `${app.variant}-preview-${Date.now()}-${Math.random().toString(16).slice(2)}.xml`);
  try {
    await execAdb(["-s", serial, "shell", "am", "start", "-n", `${app.packageName}/${SEARCH_ACTIVITY}`, "--ei", "applyPhoneType", String(applyPhoneType)]);
    await delay(1500);

    let lastXml = "";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const remotePath = `/sdcard/uidump_phone_preview_${attempt}.xml`;
      const xml = await dumpUiHierarchy(serial, remotePath, localXmlPath);
      lastXml = xml;
      if (xml.includes(`${app.packageName}:id/button3`) || xml.includes(`${app.packageName}:id/title_message`)) {
        await dismissCommonDialog(serial, xml, app.packageName);
        await delay(1500);
        continue;
      }
      if (xml.includes(`${app.packageName}:id/btn_ok`)) {
        await dismissNoticeDialog(serial, xml, app.packageName);
        await delay(1800);
        continue;
      }

      const candidates = extractCandidatesFromXml(xml, countryCode, app.packageName);
      if (candidates.length > 0) {
        return {
          freeChance: undefined,
          candidates,
          rawJson: JSON.stringify({ source: "adb-ui", candidateCount: candidates.length, attempt: attempt + 1 })
        };
      }
      const isLoading = xml.includes(`${app.packageName}:id/custom_progress_display`) || xml.includes("请稍候");
      await delay(isLoading ? 2000 : 1200);
    }

    return {
      freeChance: undefined,
      candidates: [],
      rawJson: JSON.stringify({ source: "adb-ui", candidateCount: 0, reason: "empty_after_retry", hasNotice: lastXml.includes("btn_ok") })
    };
  } finally {
    await rm(localXmlPath, { force: true }).catch(() => undefined);
  }
}

async function dumpUiHierarchy(serial: string, remotePath: string, localPath: string) {
  await execAdb(["-s", serial, "shell", "uiautomator", "dump", remotePath]);
  await execAdb(["-s", serial, "pull", remotePath, localPath]);
  return readFile(localPath, "utf8");
}

function extractCandidatesFromXml(xml: string, countryCode: number, packageName: string) {
  const escapedPackage = packageName.replace(/\./g, "\\.");
  const matches = [
    ...xml.matchAll(new RegExp(`text="([^"]+)"[^>]*resource-id="${escapedPackage}:id/item_num"`, "g")),
    ...xml.matchAll(new RegExp(`resource-id="${escapedPackage}:id/item_num"[^>]*text="([^"]+)"`, "g"))
  ];
  return matches
    .map((match) => normalizePreviewText(match[1] ?? "", countryCode))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

async function dismissNoticeDialog(serial: string, xml: string, packageName: string) {
  const dontShowBounds = extractBoundsForResourceId(xml, `${packageName}:id/cl_dont_show_container`);
  if (dontShowBounds) {
    const centerX = Math.floor((dontShowBounds.left + dontShowBounds.right) / 2);
    const centerY = Math.floor((dontShowBounds.top + dontShowBounds.bottom) / 2);
    await execAdb(["-s", serial, "shell", "input", "tap", String(centerX), String(centerY)]).catch(() => undefined);
    await delay(250);
  }

  const okBounds = extractBoundsForResourceId(xml, `${packageName}:id/btn_ok`);
  if (!okBounds) {
    return;
  }
  const centerX = Math.floor((okBounds.left + okBounds.right) / 2);
  const centerY = Math.floor((okBounds.top + okBounds.bottom) / 2);
  await execAdb(["-s", serial, "shell", "input", "tap", String(centerX), String(centerY)]);
}

async function dismissCommonDialog(serial: string, xml: string, packageName: string) {
  const confirmBounds =
    extractBoundsForResourceId(xml, `${packageName}:id/button3`) ??
    extractBoundsForResourceId(xml, `${packageName}:id/button1`) ??
    extractBoundsForResourceId(xml, `${packageName}:id/btn_ok`);
  if (!confirmBounds) {
    return;
  }
  const centerX = Math.floor((confirmBounds.left + confirmBounds.right) / 2);
  const centerY = Math.floor((confirmBounds.top + confirmBounds.bottom) / 2);
  await execAdb(["-s", serial, "shell", "input", "tap", String(centerX), String(centerY)]).catch(() => undefined);
}

function normalizePreviewText(text: string, countryCode: number) {
  const raw = text.trim();
  if (!raw) {
    return null;
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) {
    return null;
  }
  const countryCodeText = String(countryCode);
  const phoneNumber = digits.startsWith(countryCodeText) ? digits : `${countryCodeText}${digits}`;
  return {
    phoneNumber,
    countryCode,
    displayName: undefined,
    cityName: undefined,
    stateName: undefined,
    price: undefined,
    rawJson: JSON.stringify({ sourceText: raw })
  };
}

function extractBoundsForResourceId(xml: string, resourceId: string) {
  const escaped = resourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`resource-id="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  if (!match) {
    return null;
  }
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4])
  };
}

function resolveApplyPhoneType(countryCode: number, isoCountryCode?: string | null) {
  if (countryCode === 1 && isoCountryCode?.trim().toUpperCase() === "CA") {
    return 2;
  }
  const mapping: Record<number, number> = {
    1: 1,
    7: 6,
    31: 9,
    32: 5,
    33: 15,
    34: 7,
    40: 24,
    43: 14,
    44: 3,
    45: 23,
    46: 16,
    48: 18,
    60: 22,
    61: 13,
    62: 19,
    65: 28,
    81: 27,
    82: 31,
    86: 11,
    230: 17,
    420: 21,
    852: 29,
    886: 30,
    1787: 20
  };
  return mapping[countryCode] ?? null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
