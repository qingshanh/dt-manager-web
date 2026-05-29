import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { AppError } from "../utils/errors.js";
import type { DingtoneSessionExport } from "./dingtone/types.js";
import { execAdb, resolveAdbApp, resolveAdbSerial, type AdbAppVariant } from "./adb-app.js";

export async function exportSessionFromAdbConfig(variant: AdbAppVariant): Promise<DingtoneSessionExport> {
  const serial = await resolveAdbSerial();
  const app = resolveAdbApp(variant);
  const remotePaths = [
    `/data/user/0/${app.packageName}/app_config/coreconfigex.bin`,
    `/data/data/${app.packageName}/app_config/coreconfigex.bin`,
    `/data/user/0/${app.packageName}/app_config/coreconfigexbackup`,
    `/data/data/${app.packageName}/app_config/coreconfigexbackup`
  ];

  let lastError: unknown;
  for (const remotePath of remotePaths) {
    const localPath = join("C:\\tmp", `${app.variant}-session-${Date.now()}-${Math.random().toString(16).slice(2)}-${basename(remotePath)}`);
    try {
      await pullAppFile(serial, remotePath, localPath);
      const session = parseCoreConfigSession(await readFile(localPath), variant, app.packageName);
      if (session) {
        return session;
      }
      lastError = new Error(`${remotePath} did not contain a complete session`);
    } catch (error) {
      lastError = error;
    } finally {
      await rm(localPath, { force: true }).catch(() => undefined);
    }
  }

  throw new AppError(
    `Unable to export ${variant} session from ADB app config: ${lastError instanceof Error ? lastError.message : String(lastError ?? "unknown error")}`,
    503,
    503
  );
}

async function pullAppFile(serial: string, remotePath: string, localPath: string) {
  await execAdb(["-s", serial, "root"]).catch(() => undefined);
  try {
    await execAdb(["-s", serial, "pull", remotePath, localPath]);
    return;
  } catch {
    const remoteTempPath = `/sdcard/${Date.now()}-${Math.random().toString(16).slice(2)}-${basename(remotePath)}`;
    await execAdb(["-s", serial, "shell", "su", "0", "cp", remotePath, remoteTempPath]);
    await execAdb(["-s", serial, "pull", remoteTempPath, localPath]);
  }
}

function parseCoreConfigSession(buffer: Buffer, variant: AdbAppVariant, packageName: string): DingtoneSessionExport | null {
  const strings = uniqueNonEmptyStrings(buffer.toString("latin1").match(/[\x20-\x7e]{6,}/g) ?? []);
  const dtUserId = strings.find((item) => /^\d{12,18}$/.test(item));
  const token = strings.find((item) => /^[0-9a-f]{32}$/i.test(item));
  const deviceIdCandidates = strings.filter((item) => /^And\.[A-Za-z0-9._-]{8,}$/.test(item));
  const deviceId = deviceIdCandidates[0];

  if (!dtUserId || !token || !deviceId) {
    return null;
  }

  return {
    dtUserId,
    token,
    deviceId,
    deviceIdCandidates,
    appVariant: variant,
    packageName
  };
}

function uniqueNonEmptyStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
