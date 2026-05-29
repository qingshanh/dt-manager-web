import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { HelperSmsMessageRecord } from "./message-runtime.js";
import { ADB_PATH, resolveAdbApp, type AdbAppVariant } from "./adb-app.js";

const execFileAsync = promisify(execFile);

export async function dumpSmsMessagesFromNotifications(limit: number, variant: AdbAppVariant = "dingtone"): Promise<HelperSmsMessageRecord[]> {
  const app = resolveAdbApp(variant);
  const serial = await resolveAdbSerial();
  const localXmlPath = join("C:\\tmp", `${app.variant}-notification-${Date.now()}-${Math.random().toString(16).slice(2)}.xml`);
  try {
    await execAdb(["-s", serial, "shell", "cmd", "statusbar", "expand-notifications"]);
    await delay(1200);
    const xml = await dumpUiXml(serial, "/sdcard/uidump_notification.xml", localXmlPath);
    const items = extractNotificationItems(xml)
      .filter((item) => notificationBelongsToApp(item, app.packageName, app.variant))
      .filter(isLikelySmsNotification)
      .slice(0, Math.max(1, Math.min(20, limit)));
    return items.map((item) => ({
      id: null,
      conversationId: null,
      conversationUserId: item.sender,
      type: 1,
      senderId: item.sender,
      msgId: null,
      content: item.content,
      timestamp: Date.now(),
      time: Date.now(),
      isRead: 0,
      data1: item.appName,
      data2: item.sender,
      data3: "notification-ui"
    }));
  } finally {
    await execAdb(["-s", serial, "shell", "cmd", "statusbar", "collapse"]).catch(() => undefined);
    await rm(localXmlPath, { force: true }).catch(() => undefined);
  }
}

function extractNotificationItems(xml: string) {
  const blocks = xml.split('resource-id="android:id/status_bar_latest_event_content"');
  const items: Array<{ packageName?: string; appName: string; sender: string; content: string }> = [];
  for (const block of blocks.slice(1)) {
    const packageName = block.match(/package="([^"]+)"/)?.[1];
    const appName = decodeUiText(matchText(block, "android:id/app_name_text") ?? "");
    const title = decodeUiText(matchText(block, "android:id/title") ?? "");
    const text = decodeUiText(matchText(block, "android:id/text") ?? "");
    if (!title || !text) {
      continue;
    }
    items.push({
      packageName,
      appName,
      sender: normalizeSender(title, appName),
      content: text
    });
  }
  return items;
}

function notificationBelongsToApp(item: { packageName?: string; appName: string }, packageName: string, variant: AdbAppVariant) {
  if (item.packageName && item.packageName === packageName) {
    return true;
  }
  const appName = item.appName.toLowerCase();
  return variant === "dingdong"
    ? /dingtone|叮咚|丁通/.test(appName)
    : /talku|talkyou|说道|說道/.test(appName);
}

function matchText(block: string, resourceId: string) {
  const escaped = resourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`text="([^"]*)"[^>]*resource-id="${escaped}"`));
  return match?.[1] ?? null;
}

function normalizeSender(title: string, appName: string) {
  const value = title.trim();
  if (value && value !== appName) {
    return value;
  }
  return appName.trim() || value;
}

function isLikelySmsNotification(item: { appName: string; sender: string; content: string }) {
  const appName = item.appName.toLowerCase();
  if (appName.includes("android")) {
    return false;
  }
  if (/\d{4,8}/.test(item.content)) {
    return true;
  }
  if (/verification|verify|code/i.test(item.content)) {
    return true;
  }
  if (/^[A-Z0-9 ()+-]{3,}$/.test(item.sender)) {
    return true;
  }
  return false;
}

function decodeUiText(value: string) {
  return repairUtf8Mojibake(
    value
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim()
  );
}

function repairUtf8Mojibake(value: string) {
  if (!value) {
    return value;
  }
  if (/[\u4e00-\u9fff]/.test(value)) {
    return value;
  }
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (!repaired || repaired === value || repaired.includes("�")) {
      return value;
    }
    return repaired;
  } catch {
    return value;
  }
}

async function dumpUiXml(serial: string, remotePath: string, localPath: string) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await execAdb(["-s", serial, "shell", "uiautomator", "dump", remotePath]);
      await execAdb(["-s", serial, "pull", remotePath, localPath]);
      return await readFile(localPath, "utf8");
    } catch (error) {
      lastError = error;
      await delay(500 + attempt * 400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function resolveAdbSerial() {
  const { stdout } = await execAdb(["devices"]);
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("List of devices"));
  const first = lines
    .map((line) => line.split(/\s+/))
    .find((parts) => parts[1] === "device");
  if (!first?.[0]) {
    throw new Error("No adb device is online");
  }
  return first[0];
}

async function execAdb(args: string[]) {
  return execFileAsync(ADB_PATH, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
