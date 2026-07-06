import type { AppVariant } from "@prisma/client";
import type { DingtoneSnapshot } from "./dingtone/types.js";

import net from "node:net";
import tls from "node:tls";
import { config } from "../config.js";
import { AppError } from "../utils/errors.js";
import { getSettingsMap } from "./settings.service.js";

type JsonRecord = Record<string, unknown>;

type PublicAccountEnrichmentInput = {
  appVariant: AppVariant;
  dtUserId: string;
  snapshot: DingtoneSnapshot;
  previousRawJson?: string | null;
};

const POINT_API_BASE = "https://dt-apigatewayv2.dt-pn1.com";
const DEFAULT_CREDIT_EXCHANGE_RATIO = 0.02;
const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 13; M2012K11AC Build/TKQ1.220829.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.119 Mobile Safari/537.36 TengZhan/3"
};

export async function enrichSnapshotWithPublicData(input: PublicAccountEnrichmentInput): Promise<DingtoneSnapshot> {
  const currentRaw = parseJsonRecord(input.snapshot.rawJson);
  const previousRaw = parseJsonRecord(input.previousRawJson);
  const currentPointUid = pickFirstString([
    readPathString(currentRaw, ["point", "uid"]),
    readPathString(currentRaw, ["point", "summary", "uid"]),
    readPathString(currentRaw, ["point", "summary", "data", "uid"]),
    readPathString(currentRaw, ["point", "summary", "result", "uid"]),
    readPathString(currentRaw, ["publicPoint", "uid"]),
    readPathString(currentRaw, ["pointExtras", "pointUid"]),
    readPathString(currentRaw, ["pointExtras", "context", "pointUid"]),
    readPathString(currentRaw, ["context", "pointUid"])
  ]);
  const previousPointUid = pickFirstString([
    readPathString(previousRaw, ["point", "uid"]),
    readPathString(previousRaw, ["point", "summary", "uid"]),
    readPathString(previousRaw, ["point", "summary", "data", "uid"]),
    readPathString(previousRaw, ["point", "summary", "result", "uid"]),
    readPathString(previousRaw, ["publicPoint", "uid"]),
    readPathString(previousRaw, ["pointExtras", "pointUid"]),
    readPathString(previousRaw, ["pointExtras", "context", "pointUid"]),
    readPathString(previousRaw, ["context", "pointUid"])
  ]);
  const pointUid = currentPointUid ?? previousPointUid;
  const pointUserId = pickFirstString([
    readPathString(currentRaw, ["pointExtras", "dtUserId"]),
    readPathString(currentRaw, ["pointExtras", "context", "dtUserId"]),
    readPathString(currentRaw, ["context", "dtUserId"]),
    readPathString(previousRaw, ["pointExtras", "dtUserId"]),
    readPathString(previousRaw, ["pointExtras", "context", "dtUserId"]),
    readPathString(previousRaw, ["context", "dtUserId"]),
    input.dtUserId
  ]);
  const appType = input.appVariant === "dingdong" ? 0 : 3;
  const gameAppId = input.appVariant === "dingdong" ? 66 : 67;

  const rawPointGradeInfo =
    readPathRecord(currentRaw, ["point", "gradeInfo"]) ??
    readPathRecord(currentRaw, ["point", "pointGradeInfo"]) ??
    readPathRecord(currentRaw, ["point", "gradeInfo", "data"]) ??
    readPathRecord(previousRaw, ["point", "gradeInfo"]) ??
    readPathRecord(previousRaw, ["point", "pointGradeInfo"]) ??
    readPathRecord(previousRaw, ["point", "gradeInfo", "data"]);
  const pointGradeInfo = rawPointGradeInfo ?? (pointUid
    ? await fetchPublicJson(`/point/gradeinfo?uid=${encodeURIComponent(pointUid)}`).catch(() => null)
    : null);
  const pointUserInfo = pointUid
    ? await fetchPublicJson(`/point/userinfo?uid=${encodeURIComponent(pointUid)}&zone=800`).catch(() => null)
    : null;
  const pointStore = pointUid
    ? await fetchPublicJson(`/pointstore/entrance?uid=${encodeURIComponent(pointUid)}&lang=cn&osType=2`).catch(() => null)
    : null;

  const gameHomePage = pointUserId
    ? await fetchPublicJson(
        `/game/homePage?userId=${encodeURIComponent(pointUserId)}&appId=${gameAppId}&zone=-800&timeStamp=${Date.now()}`
      ).catch(() => null)
    : null;
  const gameHomePageData =
    unwrapData(gameHomePage) ??
    readPathRecord(currentRaw, ["publicPoint", "gameHomePage"]) ??
    readPathRecord(previousRaw, ["publicPoint", "gameHomePage"]);
  const gameUid =
    pickString(gameHomePageData, ["uid"]) ??
    readPathString(currentRaw, ["publicPoint", "gameUid"]) ??
    readPathString(previousRaw, ["publicPoint", "gameUid"]);
  const gameRedeemInfo = gameUid
    ? await fetchPublicJson(`/game/point/redeemInfo?uid=${encodeURIComponent(gameUid)}&timeStamp=${Date.now()}`).catch(() => null)
    : null;

  const pointGradeInfoData =
    unwrapData(pointGradeInfo) ??
    readPathRecord(currentRaw, ["publicPoint", "gradeInfo"]) ??
    readPathRecord(previousRaw, ["publicPoint", "gradeInfo"]);
  const pointUserData =
    unwrapData(pointUserInfo) ??
    readPathRecord(currentRaw, ["publicPoint", "userInfo"]) ??
    readPathRecord(previousRaw, ["publicPoint", "userInfo"]);
  const pointStoreData =
    unwrapData(pointStore) ??
    readPathRecord(currentRaw, ["publicPoint", "store"]) ??
    readPathRecord(previousRaw, ["publicPoint", "store"]);
  const gameRedeemInfoData =
    unwrapData(gameRedeemInfo) ??
    readPathRecord(currentRaw, ["publicPoint", "gameRedeemInfo"]) ??
    readPathRecord(previousRaw, ["publicPoint", "gameRedeemInfo"]);
  const exchangeRatio =
    pickNumber(readPathRecord(currentRaw, ["balance"]), ["creditExchangeRatio"]) ??
    pickNumber(readPathRecord(previousRaw, ["balance"]), ["creditExchangeRatio"]) ??
    (looksLikeRawCreditBalance(input.snapshot.primaryBalance) ? DEFAULT_CREDIT_EXCHANGE_RATIO : null);

  const baseBalance =
    input.snapshot.primaryBalance ??
    pickNumber(readPathRecord(currentRaw, ["balance"]), ["primaryBalance", "balance"]) ??
    pickNumber(readPathRecord(previousRaw, ["balance"]), ["primaryBalance", "balance"]);

  const displayBalance = resolveDisplayBalance(baseBalance, exchangeRatio);

  const userGradeLevel = toGradeLevel(
    incrementGradeLevel(pickNumber(pointUserData, ["userGrade"])) ??
      incrementGradeLevel(pickNumber(pointGradeInfoData, ["userGrade"])) ??
      input.snapshot.userGrade ??
      pickNumber(readPathRecord(currentRaw, ["point"]), ["pointGradeLevel", "userGrade"])
  );
  const membershipLevelLabel =
    buildMembershipLevelLabel(userGradeLevel) ?? input.snapshot.membershipLevelLabel ?? undefined;
  const rawValidPoint =
    normalizeMemberPoint(pickNumber(pointUserData, ["validPoint"])) ??
    normalizeMemberPoint(pickNumber(pointGradeInfoData, ["validPoint"])) ??
    pickReasonableMemberPoint(readPathRecord(currentRaw, ["publicPoint"]), ["validPoint"]) ??
    pickReasonableMemberPoint(readPathRecord(previousRaw, ["publicPoint"]), ["validPoint"]) ??
    normalizeMemberPoint(input.snapshot.validPoint);
  const progressPoint =
    normalizeMemberPoint(pickNumber(pointGradeInfoData, ["progessPoint", "progressPoint", "historyPoint"])) ??
    normalizeMemberPoint(pickNumber(pointUserData, ["historyPoint"])) ??
    normalizeMemberPoint(input.snapshot.progressPoint);
  const validPoint = rawValidPoint ?? normalizeMemberPoint(progressPoint);
  const progressPointTotal =
    resolveProgressPointTotal(userGradeLevel, pointGradeInfoData, pointUserData) ?? input.snapshot.progressPointTotal;
  const pointStoreBenefits = buildPointStoreBenefits(pointStoreData);
  const gamePointBenefits = buildGamePointBenefits(gameRedeemInfoData);
  const billingBenefits = buildBillingProductBenefits(readPathRecord(currentRaw, ["point", "billingProducts"]) ?? readPathRecord(previousRaw, ["point", "billingProducts"]));

  const mergedRaw = {
    ...currentRaw,
    publicPoint: {
      uid: pointUid,
      userId: pointUserId,
      appType,
      gameAppId,
      gameUid,
      gradeInfo: pointGradeInfoData,
      userInfo: pointUserData,
      store: pointStoreData,
      gameHomePage: gameHomePageData,
      gameRedeemInfo: gameRedeemInfoData,
      validPoint,
      progressPoint,
      progressPointTotal,
      historyPoint: pickNumber(pointUserData, ["historyPoint"]),
      expirePoint: pickNumber(pointUserData, ["expirePoint"]),
      expireTime: pickString(pointUserData, ["expireTime"]),
      membershipLevelLabel,
      balanceDisplay: displayBalance,
      membershipBenefits: pointStoreBenefits,
      gamePointBenefits,
      billingProductBenefits: billingBenefits,
      fetchedAt: new Date().toISOString()
    }
  };

  return {
    ...input.snapshot,
    fullName: input.snapshot.fullName ?? pickString(pointUserData, ["userName", "name", "nickName", "nickname"]) ?? undefined,
    primaryBalance: displayBalance && displayBalance > 0 ? displayBalance : undefined,
    userGrade: userGradeLevel ?? input.snapshot.userGrade,
    validPoint: validPoint ?? input.snapshot.validPoint,
    progressPoint: progressPoint ?? input.snapshot.progressPoint,
    progressPointTotal,
    membershipType: input.snapshot.membershipType ?? membershipLevelLabel ?? undefined,
    membershipLevelLabel,
    rawJson: JSON.stringify(mergedRaw)
  };
}

export async function fetchPublicJson(path: string) {
  const url = `${POINT_API_BASE}${path}`;
  const proxyUrl = await resolvePublicApiProxyUrl();
  if (proxyUrl) {
    return fetchPublicJsonViaProxy(url, proxyUrl);
  }

  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    throw new Error(`Public point request failed: ${response.status} ${path}`);
  }
  return (await response.json()) as JsonRecord;
}

async function resolvePublicApiProxyUrl() {
  const settings = await getSettingsMap().catch(() => ({} as Record<string, string>));
  return (settings.dt_proxy_url || config.DT_PROXY_URL || "").trim();
}

async function fetchPublicJsonViaProxy(url: string, proxyUrl: string) {
  const response = await httpsGetViaHttpConnectProxy({
    url,
    proxyUrl,
    headers: DEFAULT_HEADERS,
    timeoutMs: 15_000
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Public point request failed through proxy: ${response.statusCode} ${url}`);
  }
  return JSON.parse(response.body) as JsonRecord;
}

function httpsGetViaHttpConnectProxy(input: {
  url: string;
  proxyUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    let target: URL;
    let proxy: URL;
    try {
      target = new URL(input.url);
      proxy = new URL(input.proxyUrl);
    } catch {
      reject(new AppError("DT_PROXY_URL must be a valid http:// or https:// proxy URL.", 400, 400));
      return;
    }
    if (target.protocol !== "https:") {
      reject(new AppError("Public point proxy fetch currently supports https:// targets only.", 400, 400));
      return;
    }
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
      reject(new AppError("DT_PROXY_URL currently supports HTTP CONNECT proxies only. Use http:// or https://.", 400, 400));
      return;
    }

    const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const proxySocket = proxy.protocol === "https:"
      ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname, rejectUnauthorized: false })
      : net.connect({ host: proxy.hostname, port: proxyPort });
    let completed = false;
    let connectBuffer = Buffer.alloc(0);
    let tunnelSocket: tls.TLSSocket | null = null;

    const timer = setTimeout(() => {
      cleanup();
      reject(new AppError(`Public point proxy request timed out: ${target.hostname}`, 504, 504));
    }, input.timeoutMs);

    const cleanup = () => {
      completed = true;
      clearTimeout(timer);
      proxySocket.removeAllListeners();
      tunnelSocket?.removeAllListeners();
      proxySocket.destroy();
      tunnelSocket?.destroy();
    };

    const fail = (error: unknown) => {
      if (completed) {
        return;
      }
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    proxySocket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
      proxySocket.write(buildConnectRequest(proxy, target.hostname, 443));
    });
    proxySocket.on("error", fail);
    proxySocket.on("data", (chunk) => {
      connectBuffer = Buffer.concat([connectBuffer, chunk]);
      const headerEnd = connectBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const headerText = connectBuffer.subarray(0, headerEnd).toString("latin1");
      const status = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? NaN);
      if (status < 200 || status >= 300) {
        fail(new AppError(`Public point proxy CONNECT failed with HTTP ${Number.isFinite(status) ? status : "unknown"}.`, 502, 502));
        return;
      }
      proxySocket.removeAllListeners("data");
      tunnelSocket = tls.connect({
        socket: proxySocket,
        servername: target.hostname,
        rejectUnauthorized: false
      });
      const responseChunks: Buffer[] = [];
      const finish = () => {
        if (completed) {
          return;
        }
        try {
          const parsed = parseHttpResponse(Buffer.concat(responseChunks));
          cleanup();
          resolve(parsed);
        } catch (error) {
          fail(error);
        }
      };
      tunnelSocket.once("secureConnect", () => {
        const requestPath = `${target.pathname}${target.search}`;
        tunnelSocket?.write(buildGetRequest(target.hostname, requestPath, input.headers));
      });
      tunnelSocket.on("data", (data) => responseChunks.push(data));
      tunnelSocket.once("end", finish);
      tunnelSocket.once("close", finish);
      tunnelSocket.on("error", fail);
    });
  });
}

function buildConnectRequest(proxy: URL, host: string, port: number) {
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Connection: close"
  ];
  if (proxy.username || proxy.password) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function buildGetRequest(host: string, path: string, headers: Record<string, string>) {
  const lines = [
    `GET ${path || "/"} HTTP/1.1`,
    `Host: ${host}`,
    "Connection: close",
    "Accept-Encoding: identity",
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
  ];
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function parseHttpResponse(buffer: Buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("Public point proxy response did not contain HTTP headers.");
  }
  const headerText = buffer.subarray(0, headerEnd).toString("latin1");
  const statusCode = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/i)?.[1] ?? NaN);
  if (!Number.isFinite(statusCode)) {
    throw new Error("Public point proxy response did not contain a valid HTTP status.");
  }
  const headers = Object.fromEntries(
    headerText
      .split(/\r?\n/)
      .slice(1)
      .map((line) => {
        const index = line.indexOf(":");
        return index === -1 ? null : [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
      })
      .filter((item): item is [string, string] => Boolean(item))
  );
  const rawBody = buffer.subarray(headerEnd + 4);
  const body = headers["transfer-encoding"]?.toLowerCase().includes("chunked") ? decodeChunkedBody(rawBody) : rawBody;
  return {
    statusCode,
    headers,
    body: body.toString("utf8")
  };
}

function decodeChunkedBody(buffer: Buffer) {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd === -1) {
      break;
    }
    const sizeText = buffer.subarray(offset, lineEnd).toString("ascii").split(";")[0] ?? "";
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) {
      break;
    }
    offset = lineEnd + 2;
    if (size === 0) {
      break;
    }
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function buildPointStoreBenefits(pointStoreData: JsonRecord | null) {
  const benefits: Array<{ code: string; name: string; price: number | null; stock?: number | null }> = [];
  const pointProducts = Array.isArray(pointStoreData?.products) ? pointStoreData.products : [];

  for (const product of pointProducts) {
    if (!isRecord(product)) {
      continue;
    }
    const name = pickString(product, ["name"]);
    if (!name) {
      continue;
    }

    const stock = pickNumber(product, ["stock"]);
    const price = pickNumber(product, ["price"]);
    const suffix =
      stock !== null && price !== null
        ? `（剩余 ${stock}，需 ${price} 积分）`
        : stock !== null
          ? `（剩余 ${stock}）`
          : price !== null
            ? `（需 ${price} 积分）`
            : "";

    benefits.push({
      code: String(product.id ?? name),
      name: `${name}${suffix}`,
      price,
      stock
    });
  }

  return benefits;
}

function buildGamePointBenefits(gameRedeemInfoData: JsonRecord | null) {
  const benefits: Array<{ code: string; name: string; price: number | null; stock?: number | null }> = [];
  const products = Array.isArray(gameRedeemInfoData?.products) ? gameRedeemInfoData.products : [];

  for (const product of products) {
    if (!isRecord(product)) {
      continue;
    }
    const name = pickString(product, ["productName", "name"]);
    if (!name) {
      continue;
    }

    benefits.push({
      code: String(product.productId ?? product.id ?? name),
      name,
      price: pickNumber(product, ["price"]),
      stock: pickNumber(product, ["convertibleNum", "stock"])
    });
  }

  return benefits;
}

function buildBillingProductBenefits(billingProducts: JsonRecord | null) {
  const benefits: Array<{ code: string; name: string; price: number | null; stock?: number | null }> = [];
  const data = unwrapData(billingProducts);
  const products = Array.isArray(data?.products) ? data.products : [];

  for (const product of products) {
    if (!isRecord(product)) {
      continue;
    }
    const name = pickString(product, ["name", "subject", "description"]);
    if (!name) {
      continue;
    }
    const amount = pickNumber(product, ["amount", "giveCreditNum"]);
    const price = pickNumber(product, ["price", "price_USD"]);
    benefits.push({
      code: String(product.id ?? product.gpProductId ?? name),
      name: amount !== null ? `${name} / ${amount} credits` : name,
      price,
      stock: null
    });
  }

  return benefits;
}

function mergeBenefits(
  primary: Array<{ code: string; name: string; price: number | null; stock?: number | null }>,
  secondary: Array<{ code: string; name: string; price: number | null; stock?: number | null }>
) {
  const merged = [...primary];
  for (const item of secondary) {
    if (!merged.some((candidate) => candidate.name === item.name)) {
      merged.push(item);
    }
  }
  return merged;
}

function buildMembershipLevelLabel(level: number | null) {
  if (level === null) {
    return null;
  }
  if (level === 4) {
    return "V4白金";
  }
  return `V${level}`;
}

function resolveProgressPointTotal(level: number | null, pointGradeInfoData: JsonRecord | null, pointUserData: JsonRecord | null) {
  const explicit =
    pickNumber(pointGradeInfoData, ["progressPointTotal", "nextGradePoint", "nextLevelPoint"]) ??
    pickNumber(pointUserData, ["progressPointTotal", "nextGradePoint", "nextLevelPoint"]);
  if (explicit !== null) {
    return explicit;
  }

  if (level === 4) {
    return 5000;
  }
  return null;
}

function toGradeLevel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value >= 1 && Number.isInteger(value) ? value : value + 1;
}

function incrementGradeLevel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return value + 1;
}

function unwrapData(value: JsonRecord | null) {
  if (!value) {
    return null;
  }
  return isRecord(value.data) ? value.data : value;
}

function parseJsonRecord(value: string | null | undefined) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readPathRecord(value: JsonRecord | null | undefined, path: string[]) {
  const resolved = readPath(value, path);
  return isRecord(resolved) ? resolved : null;
}

function readPathString(value: JsonRecord | null | undefined, path: string[]) {
  const resolved = readPath(value, path);
  return typeof resolved === "string" && resolved.trim() ? resolved.trim() : null;
}

function readPath(value: JsonRecord | null | undefined, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function pickFirstString(values: Array<string | null>) {
  return values.find((value) => Boolean(value)) ?? null;
}

function pickString(record: JsonRecord | null | undefined, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(record: JsonRecord | null | undefined, keys: string[]) {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function pickReasonableMemberPoint(record: JsonRecord | null | undefined, keys: string[]) {
  const value = pickNumber(record, keys);
  return normalizeMemberPoint(value);
}

function normalizeMemberPoint(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  return value > 0 && value <= 10_000 ? value : null;
}

function resolveDisplayBalance(baseBalance: number | null | undefined, exchangeRatio: number | null | undefined) {
  if (typeof baseBalance !== "number" || !Number.isFinite(baseBalance)) {
    return baseBalance ?? null;
  }
  if (baseBalance <= 0) {
    return null;
  }
  if (looksLikeRawCreditBalance(baseBalance) && typeof exchangeRatio === "number" && Number.isFinite(exchangeRatio) && exchangeRatio > 0) {
    return roundTo(baseBalance / exchangeRatio, 2);
  }
  if (looksLikeRawCreditBalance(baseBalance)) {
    return roundTo(baseBalance / DEFAULT_CREDIT_EXCHANGE_RATIO, 2);
  }
  return baseBalance;
}

function looksLikeRawCreditBalance(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1000;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundTo(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
