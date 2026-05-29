import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { DingtonePhoneNumber } from "./dingtone/types.js";
import type { HelperSmsMessageRecord } from "./message-runtime.js";
import { ADB_PATH, execAdb, resolveAdbApp, resolveAdbSerial, type AdbAppVariant } from "./adb-app.js";

const execFileAsync = promisify(execFile);

export async function dumpSmsMessagesFromAdb(limit: number, variant: AdbAppVariant = "dingtone"): Promise<HelperSmsMessageRecord[]> {
  const rowLimit = Math.max(20, Math.min(200, limit * 6));
  const sql =
    "select _id,conversationId,conversationUserId,type,senderId,msgId,content,timestamp,time,isRead,data1,data2,data3 " +
    `from dt_message where conversationType = 3 order by _id desc limit ${rowLimit}`;
  const rows = await queryDatabase(sql, variant);
  return rows
    .map((row) => ({
      id: toNumber(row._id),
      conversationId: cleanString(row.conversationId),
      conversationUserId: cleanString(row.conversationUserId),
      type: toNumber(row.type),
      senderId: cleanString(row.senderId),
      msgId: cleanString(row.msgId),
      content: cleanString(row.content),
      timestamp: toNumber(row.timestamp),
      time: toNumber(row.time),
      isRead: toNumber(row.isRead),
      data1: cleanString(row.data1),
      data2: cleanString(row.data2),
      data3: cleanString(row.data3)
    }))
    .filter((row) => row.content)
    .slice(0, Math.max(1, Math.min(100, limit)));
}

export async function listPhoneNumbersFromAdb(variant: AdbAppVariant = "dingtone"): Promise<DingtonePhoneNumber[]> {
  const sql =
    "select _id,countryCode,areaCode,phoneNumber,payType,gainTime,payTime,expireTime,displayName,primaryFlag," +
    "silentFlag,suspendFlag,callForwardFlag,forwardNumber,forwardCountryCode,forwardDestCode,provision,isExpire," +
    "reserved1,reserved2,reserved3,reserved4,reserved5,reserved6,reserved7,reserved8,reserved9,reserved10 " +
    "from private_phone order by _id desc";
  const rows = await queryDatabase(sql, variant);
  return rows
    .map((row, index) => {
      const reservedJson = parseJsonRecord(cleanString(row.reserved10));
      const usePeriod = toNumber(reservedJson.usePeriod);
      return {
        phoneNumber: cleanString(row.phoneNumber) ?? "",
        countryCode: toOptionalNumber(row.countryCode),
        providerId: toOptionalNumber(row.reserved3),
        displayName: toOptionalString(row.displayName),
        status: resolvePhoneStatus(row),
        purchaseType: toOptionalNumber(reservedJson.purchaseType),
        payType: toOptionalNumber(row.payType),
        validPeriodDays: usePeriod !== null ? usePeriod * 31 : undefined,
        gainTime: toOptionalString(stringifyNumber(row.gainTime)),
        expiredTime: toOptionalString(stringifyNumber(row.expireTime)),
        autoRenew: cleanString(row.reserved8) === "1",
        isPrimary: toNumber(row.primaryFlag) === 1 || index === rows.length - 1,
        isGoodNumber: false,
        portoutInfo: toOptionalString(reservedJson.portoutInfo),
        rawJson: JSON.stringify(row)
      } satisfies DingtonePhoneNumber;
    })
    .filter((item) => item.phoneNumber);
}

async function queryDatabase(sql: string, variant: AdbAppVariant) {
  const serial = await resolveAdbSerial();
  const app = resolveAdbApp(variant);
  const remoteDbPath = `/data/user/0/${app.packageName}/databases/Dingtone.db`;
  const remoteDbWalPath = `${remoteDbPath}-wal`;
  const remoteDbShmPath = `${remoteDbPath}-shm`;
  const localDbPath = join("C:\\tmp", `${app.variant}-db-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  const localWalPath = `${localDbPath}-wal`;
  const localShmPath = `${localDbPath}-shm`;
  try {
    await execAdb(["-s", serial, "root"]).catch(() => undefined);
    await execAdb(["-s", serial, "pull", remoteDbPath, localDbPath]);
    await execAdb(["-s", serial, "pull", remoteDbWalPath, localWalPath]).catch(() => undefined);
    await execAdb(["-s", serial, "pull", remoteDbShmPath, localShmPath]).catch(() => undefined);
    const pythonScript = [
      "import json, sqlite3, sys",
      `con = sqlite3.connect(r'''${localDbPath}''')`,
      "con.row_factory = sqlite3.Row",
      "cur = con.cursor()",
      `rows = cur.execute(r'''${sql.replace(/'/g, "''")}''').fetchall()`,
      "print(json.dumps([dict(row) for row in rows], ensure_ascii=False))"
    ].join("; ");
    const { stdout } = await execFileAsync("python", ["-c", pythonScript], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    });
    return JSON.parse(stdout) as Array<Record<string, unknown>>;
  } finally {
    await rm(localDbPath, { force: true }).catch(() => undefined);
    await rm(localWalPath, { force: true }).catch(() => undefined);
    await rm(localShmPath, { force: true }).catch(() => undefined);
  }
}

function resolvePhoneStatus(row: Record<string, unknown>) {
  if (toNumber(row.isExpire) === 1) {
    return "expired";
  }
  if (toNumber(row.suspendFlag) === 1) {
    return "paused";
  }
  return "active";
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringifyNumber(value: unknown) {
  const parsed = toNumber(value);
  return parsed === null ? null : String(parsed);
}

function cleanString(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return repairUtf8Mojibake(value.trim());
}

function toOptionalString(value: unknown) {
  return cleanString(value) ?? undefined;
}

function toOptionalNumber(value: unknown) {
  return toNumber(value) ?? undefined;
}

function parseJsonRecord(value: string | null) {
  if (!value) {
    return {} as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
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
