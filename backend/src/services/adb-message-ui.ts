import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { HelperSmsMessageRecord } from "./message-runtime.js";
import { execAdb, resolveAdbApp, resolveAdbSerial, type AdbAppVariant } from "./adb-app.js";

const execFileAsync = promisify(execFile);

export async function dumpSmsMessagesFromUi(limit: number, variant: AdbAppVariant = "dingtone"): Promise<HelperSmsMessageRecord[]> {
  await openMessagesInbox(variant);
  const app = resolveAdbApp(variant);
  const serial = await resolveAdbSerial();
  const localXmlPath = join("C:\\tmp", `${app.variant}-messages-${Date.now()}-${Math.random().toString(16).slice(2)}.xml`);
  try {
    const xml = await dumpUiXml(serial, "/sdcard/uidump_live_messages.xml", localXmlPath);
    const items = extractMessageItems(xml, app.packageName).slice(0, Math.max(1, Math.min(30, limit)));
    return items
      .filter((item) => isLikelySmsConversation(item))
      .map((item) => {
        const parsedTime = parseUiMessageTime(item.timeLabel);
        return {
          id: null,
          conversationId: null,
          conversationUserId: item.senderId,
          type: 1,
          senderId: item.senderId,
        msgId: null,
        content: item.content,
        timestamp: parsedTime,
        time: parsedTime,
          isRead: 0,
          data1: item.senderId,
          data2: item.timeLabel,
          data3: "adb-ui"
        };
      });
  } finally {
    await rm(localXmlPath, { force: true }).catch(() => undefined);
  }
}

export async function openMessagesInbox(variant: AdbAppVariant = "dingtone") {
  const app = resolveAdbApp(variant);
  const serial = await resolveAdbSerial();
  await execAdb(["-s", serial, "shell", "am", "start", "-n", `${app.packageName}/${app.mainActivity}`]);
  await delay(1200);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const localXmlPath = join("C:\\tmp", `${app.variant}-messages-prep-${Date.now()}-${attempt}.xml`);
    try {
      const xml = await dumpUiXml(serial, "/sdcard/uidump_live_messages_prep.xml", localXmlPath);
      if (xml.includes(`${app.packageName}:id/button3`) || xml.includes(`${app.packageName}:id/btn_ok`)) {
        await dismissCommonDialog(serial, xml, app.packageName);
        await delay(1200);
        continue;
      }
      await execAdb(["-s", serial, "shell", "input", "tap", "360", "1860"]);
      await delay(1400);
      await execAdb(["-s", serial, "shell", "input", "swipe", "600", "760", "600", "1500", "280"]).catch(() => undefined);
      await delay(1500);
      return;
    } finally {
      await rm(localXmlPath, { force: true }).catch(() => undefined);
    }
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
      await delay(600 + attempt * 400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractMessageItems(xml: string, packageName: string) {
  const items: Array<{ senderId: string; timeLabel: string; content: string }> = [];
  const escapedPackage = packageName.replace(/\./g, "\\.");
  const chunks = xml.split(`resource-id="${packageName}:id/messages_first_listitem_layout"`);
  for (const chunk of chunks.slice(1)) {
    const senderMatch = chunk.match(new RegExp(`text="([^"]*)"[^>]*resource-id="${escapedPackage}:id/messages_first_listitem_name"`));
    const timeMatch = chunk.match(new RegExp(`text="([^"]*)"[^>]*resource-id="${escapedPackage}:id/messages_first_listitem_time"`));
    const contentMatch = chunk.match(new RegExp(`text="([^"]*)"[^>]*resource-id="${escapedPackage}:id/messages_first_listitem_text"`));
    const senderId = normalizeConversationName(decodeUiText(senderMatch?.[1] ?? ""));
    const timeLabel = decodeUiText(timeMatch?.[1] ?? "");
    const content = decodeUiText(contentMatch?.[1] ?? "");
    if (!senderId || !content) {
      continue;
    }
    items.push({ senderId, timeLabel, content });
  }
  return items;
}

function isLikelySmsConversation(item: { senderId: string; content: string }) {
  const text = `${item.senderId}\n${item.content}`;
  if (/talku team|dingtone team|dingdong team|talkyou team|private number order|number order succeeded|will expire|order succeeded|number purchase|purchase succeeded|has expired|expires in|credits?|points?|balance changed|说道团队|叮咚团队|系统消息|号码订购|订购成功|购买成功|即将到期|已到期|过期|续费/i.test(text)) {
    return true;
  }
  if (/\d{4,8}/.test(item.content)) {
    return true;
  }
  if (/^[A-Z0-9 ()+-]+$/.test(item.senderId)) {
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

function normalizeConversationName(value: string) {
  return value.replace(/\s*\(\d+\)\s*$/, "").trim();
}

function parseUiMessageTime(value: string) {
  const text = value.trim();
  const now = new Date();
  if (!text) {
    return Date.now();
  }

  const halfDayMatch = text.match(/^(上午|下午)\s*(\d{1,2}):(\d{2})$/);
  if (halfDayMatch) {
    let hour = Number(halfDayMatch[2]);
    const minute = Number(halfDayMatch[3]);
    if (halfDayMatch[1] === "下午" && hour < 12) {
      hour += 12;
    }
    if (halfDayMatch[1] === "上午" && hour === 12) {
      hour = 0;
    }
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0
    ).getTime();
  }

  const hmMatch = text.match(/^(\d{1,2}):(\d{2})$/);
  if (hmMatch) {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(hmMatch[1]),
      Number(hmMatch[2]),
      0,
      0
    ).getTime();
  }

  const mdMatch = text.match(/^(\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (mdMatch) {
    const month = Number(mdMatch[1]) - 1;
    const day = Number(mdMatch[2]);
    const hour = Number(mdMatch[3] ?? "0");
    const minute = Number(mdMatch[4] ?? "0");
    let year = now.getFullYear();
    const candidate = new Date(year, month, day, hour, minute, 0, 0);
    if (candidate.getTime() > now.getTime() + 12 * 60 * 60_000) {
      year -= 1;
    }
    return new Date(year, month, day, hour, minute, 0, 0).getTime();
  }

  const ymdMatch = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (ymdMatch) {
    return new Date(
      Number(ymdMatch[1]),
      Number(ymdMatch[2]) - 1,
      Number(ymdMatch[3]),
      12,
      0,
      0,
      0
    ).getTime();
  }

  if (text === "昨天") {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      12,
      0,
      0,
      0
    ).getTime();
  }

  return Date.now();
}

async function dismissCommonDialog(serial: string, xml: string, packageName: string) {
  const escapedPackage = packageName.replace(/\./g, "\\.");
  const match =
    xml.match(new RegExp(`resource-id="${escapedPackage}:id/button3"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)) ??
    xml.match(new RegExp(`resource-id="${escapedPackage}:id/button1"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`)) ??
    xml.match(new RegExp(`resource-id="${escapedPackage}:id/btn_ok"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  if (!match) {
    return;
  }
  const centerX = Math.floor((Number(match[1]) + Number(match[3])) / 2);
  const centerY = Math.floor((Number(match[2]) + Number(match[4])) / 2);
  await execAdb(["-s", serial, "shell", "input", "tap", String(centerX), String(centerY)]).catch(() => undefined);
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
