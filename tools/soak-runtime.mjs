#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIB = 1024 * 1024;

export function linearSlopePerHour(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return 0;
  }
  const origin = Number(points[0].timestampMs);
  const normalized = points
    .map((point) => ({
      x: (Number(point.timestampMs) - origin) / (60 * 60 * 1000),
      y: Number(point.value) / MIB
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (normalized.length < 2) {
    return 0;
  }
  const meanX = normalized.reduce((sum, point) => sum + point.x, 0) / normalized.length;
  const meanY = normalized.reduce((sum, point) => sum + point.y, 0) / normalized.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of normalized) {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function safeNumericRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => /^[a-zA-Z0-9_.-]+$/.test(key) && Number.isFinite(Number(item)))
      .map(([key, item]) => [key, Number(item)])
  );
}

export function sanitizeRuntimeSample(input) {
  const memory = input?.metrics?.process?.memory ?? {};
  const processCpu = input?.metrics?.process?.cpu ?? {};
  return {
    timestamp: String(input?.timestamp ?? new Date().toISOString()),
    instanceId: input?.health?.instanceId == null ? null : String(input.health.instanceId),
    startedAt: input?.health?.startedAt == null ? null : String(input.health.startedAt),
    uptimeSeconds: safeNumber(input?.health?.uptimeSeconds),
    memory: {
      rss: safeNumber(memory.rss),
      heapUsed: safeNumber(memory.heapUsed),
      heapTotal: safeNumber(memory.heapTotal),
      external: safeNumber(memory.external),
      arrayBuffers: safeNumber(memory.arrayBuffers)
    },
    processCpu: {
      userMicros: safeNumber(processCpu.userMicros),
      systemMicros: safeNumber(processCpu.systemMicros)
    },
    cpu: {
      singleCorePercent: safeNumber(input?.cpu?.singleCorePercent)
    },
    counters: safeNumericRecord(input?.metrics?.counters),
    gauges: safeNumericRecord(input?.metrics?.gauges)
  };
}

export function analyzeRuntimeSamples(samples, options = {}) {
  const warmupMinutes = safeNumber(options.warmupMinutes ?? 10);
  const maxMemorySlopeMbHour = safeNumber(options.maxMemorySlopeMbHour ?? 5);
  const maxIdleSingleCorePercent = safeNumber(options.maxIdleSingleCorePercent ?? 10);
  const parsed = samples
    .map((sample) => ({ ...sample, timestampMs: Date.parse(sample.timestamp) }))
    .filter((sample) => Number.isFinite(sample.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const warmupCutoff = parsed.length === 0 ? 0 : parsed[0].timestampMs + warmupMinutes * 60 * 1000;
  const stable = parsed.filter((sample) => sample.timestampMs >= warmupCutoff);
  const memorySlopeMbHour = linearSlopePerHour(
    stable.map((sample) => ({ timestampMs: sample.timestampMs, value: safeNumber(sample.memory?.rss) }))
  );
  const averageSingleCorePercent = stable.length === 0
    ? 0
    : stable.reduce((sum, sample) => sum + safeNumber(sample.cpu?.singleCorePercent), 0) / stable.length;
  const failures = [];
  if (stable.length < 2) {
    failures.push("insufficient-samples");
  }
  const instanceIds = new Set(stable.map((sample) => sample.instanceId).filter(Boolean));
  const startedAtValues = new Set(stable.map((sample) => sample.startedAt).filter(Boolean));
  const uptimeRestarted = stable.some((sample, index) => index > 0 &&
    safeNumber(sample.uptimeSeconds) < safeNumber(stable[index - 1]?.uptimeSeconds));
  if (instanceIds.size > 1 || startedAtValues.size > 1 || uptimeRestarted) {
    failures.push("restart");
  }
  if (memorySlopeMbHour > maxMemorySlopeMbHour) {
    failures.push("memory");
  }
  if (averageSingleCorePercent > maxIdleSingleCorePercent) {
    failures.push("cpu");
  }
  return {
    ok: failures.length === 0,
    failures,
    sampleCount: stable.length,
    memorySlopeMbHour,
    averageSingleCorePercent
  };
}

export function resolveRuntimeToken({ directToken = "", envName = "DT_ADMIN_TOKEN", environment = process.env } = {}) {
  if (directToken) {
    return { token: directToken, source: "command-line" };
  }
  return { token: String(environment[envName] ?? ""), source: "environment" };
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      values.set(item.slice(2), "true");
      continue;
    }
    values.set(item.slice(2), value);
    index += 1;
  }
  return {
    healthUrl: values.get("health-url") ?? "http://127.0.0.1:5174/health",
    metricsUrl: values.get("metrics-url") ?? "http://127.0.0.1:5174/api/runtime/metrics",
    token: values.get("token") ?? "",
    tokenEnv: values.get("token-env") ?? "DT_ADMIN_TOKEN",
    durationMinutes: safeNumber(values.get("duration-minutes") ?? 120),
    intervalSeconds: safeNumber(values.get("interval-seconds") ?? 30),
    output: values.get("output") ?? "_tmp/runtime/soak-runtime.jsonl",
    warmupMinutes: safeNumber(values.get("warmup-minutes") ?? 10),
    maxMemorySlopeMbHour: safeNumber(values.get("max-memory-slope-mb-hour") ?? 5),
    maxIdleSingleCorePercent: safeNumber(values.get("max-idle-single-core-percent") ?? 10)
  };
}

async function fetchJson(url, token = "") {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from runtime endpoint`);
  }
  const payload = await response.json();
  return payload?.data ?? payload;
}

function calculateCpuPercent(previous, current, elapsedMs) {
  if (!previous || elapsedMs <= 0) {
    return 0;
  }
  const previousTotal = safeNumber(previous.userMicros) + safeNumber(previous.systemMicros);
  const currentTotal = safeNumber(current.userMicros) + safeNumber(current.systemMicros);
  const deltaMicros = Math.max(0, currentTotal - previousTotal);
  return deltaMicros / (elapsedMs * 1000) * 100;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.durationMinutes <= 0 || options.intervalSeconds <= 0) {
    throw new Error("duration and interval must be positive");
  }
  const outputPath = path.resolve(options.output);
  const resolvedToken = resolveRuntimeToken({ directToken: options.token, envName: options.tokenEnv });
  if (resolvedToken.source === "command-line") {
    process.stderr.write("warning: --token may be visible in process listings; prefer DT_ADMIN_TOKEN or --token-env\n");
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  const samples = [];
  const deadline = Date.now() + options.durationMinutes * 60 * 1000;
  let previousCpu = null;
  let previousAt = null;

  while (Date.now() < deadline) {
    const sampledAt = Date.now();
    const [health, metrics] = await Promise.all([
      fetchJson(options.healthUrl),
      fetchJson(options.metricsUrl, resolvedToken.token)
    ]);
    const processCpu = metrics?.process?.cpu ?? {};
    const sample = sanitizeRuntimeSample({
      timestamp: new Date(sampledAt).toISOString(),
      health,
      metrics,
      cpu: {
        singleCorePercent: calculateCpuPercent(previousCpu, processCpu, previousAt == null ? 0 : sampledAt - previousAt)
      }
    });
    previousCpu = sample.processCpu;
    previousAt = sampledAt;
    samples.push(sample);
    await appendFile(outputPath, `${JSON.stringify(sample)}\n`, "utf8");
    if (Date.now() < deadline) {
      await sleep(Math.min(options.intervalSeconds * 1000, Math.max(0, deadline - Date.now())));
    }
  }

  const result = analyzeRuntimeSamples(samples, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryUrl === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
