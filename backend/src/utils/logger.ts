type Level = "debug" | "info" | "warn" | "error";

const priority: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let currentLevel: Level = "info";

export const logger = {
  setLevel(level: Level) {
    currentLevel = level;
  },
  debug(message: string, meta?: unknown) {
    log("debug", message, meta);
  },
  info(message: string, meta?: unknown) {
    log("info", message, meta);
  },
  warn(message: string, meta?: unknown) {
    log("warn", message, meta);
  },
  error(message: string, meta?: unknown) {
    log("error", message, meta);
  }
};

function log(level: Level, message: string, meta?: unknown) {
  if (priority[level] < priority[currentLevel]) {
    return;
  }
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  if (meta === undefined) {
    console.log(prefix, message);
    return;
  }
  console.log(prefix, message, meta);
}
