import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";

const execFileAsync = promisify(execFile);

export type AdbAppVariant = "dingtone" | "dingdong";

export const ADB_PATH = config.ADB_PATH;

const DEFAULT_DINGTONE_PACKAGE = "me.talkyou.app.im";
const DEFAULT_DINGDONG_PACKAGE = "me.dingtone.app.im";
const DEFAULT_DINGTONE_MAIN_ACTIVITY = ".activity.TalkuSplashActivity";
const DEFAULT_DINGDONG_MAIN_ACTIVITY = ".activity.SplashActivity";

export function resolveAdbApp(variant: AdbAppVariant = "dingtone") {
  if (variant === "dingdong") {
    return {
      variant,
      packageName: config.DT_ADB_DINGDONG_PACKAGE || DEFAULT_DINGDONG_PACKAGE,
      mainActivity: config.DT_ADB_DINGDONG_MAIN_ACTIVITY || DEFAULT_DINGDONG_MAIN_ACTIVITY
    };
  }
  return {
    variant,
    packageName: config.DT_ADB_DINGTONE_PACKAGE || DEFAULT_DINGTONE_PACKAGE,
    mainActivity: config.DT_ADB_DINGTONE_MAIN_ACTIVITY || DEFAULT_DINGTONE_MAIN_ACTIVITY
  };
}

export async function resolveAdbSerial() {
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

export async function execAdb(args: string[]) {
  return execFileAsync(ADB_PATH, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
}
