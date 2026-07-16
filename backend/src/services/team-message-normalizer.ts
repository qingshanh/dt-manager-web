export type TeamAppVariant = "dingtone" | "dingdong";

export type ParsedTeamMessageMeta = {
  k1: number | null;
  actionType: number | null;
  credits: number | null;
  expiryDays: number | null;
  raw: string | null;
};

type JsonRecord = Record<string, unknown>;

type MetadataCandidate = {
  record: JsonRecord;
  priority: number;
  order: number;
};

type MetadataTask = {
  record: JsonRecord;
  priority: number;
  depth: number;
};

const MAX_METADATA_CANDIDATES = 64;
const MAX_METADATA_DEPTH = 16;
const MAX_TEAM_CREDITS = 1_000_000;

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonRecord
      : null;
  } catch {
    return null;
  }
}

function toFiniteNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseTeamMessageMeta(...sources: unknown[]): ParsedTeamMessageMeta {
  const candidates: MetadataCandidate[] = [];
  const queue: MetadataTask[] = [];
  const visited = new WeakSet<JsonRecord>();
  let order = 0;

  sources.forEach((source, index) => {
    const record = parseJsonRecord(source);
    if (!record) {
      return;
    }
    const directPriority = index === 1
      ? 1
      : record.params !== undefined
        ? 2
        : 4 + index;
    queue.push({ record, priority: directPriority, depth: 0 });
  });

  while (queue.length > 0 && candidates.length < MAX_METADATA_CANDIDATES) {
    const task = queue.shift()!;
    if (visited.has(task.record)) {
      continue;
    }
    visited.add(task.record);
    candidates.push({ record: task.record, priority: task.priority, order: order++ });
    if (task.depth >= MAX_METADATA_DEPTH) {
      continue;
    }

    const nested: MetadataTask[] = [];
    for (const [key, priority] of [["msgMeta", 0], ["data2", 1], ["args", 2], ["params", 3]] as const) {
      const record = parseJsonRecord(task.record[key]);
      if (record) {
        nested.push({ record, priority, depth: task.depth + 1 });
      }
    }
    nested.sort((left, right) => left.priority - right.priority);
    queue.unshift(...nested);
  }

  const ordered = candidates.sort((left, right) => left.priority - right.priority || left.order - right.order);
  const pickNumber = (reader: (record: JsonRecord) => number | null) => {
    for (const { record } of ordered) {
      const value = reader(record);
      if (value !== null) {
        return value;
      }
    }
    return null;
  };

  const k1 = pickNumber((record) => {
    const value = toFiniteNumber(record.k1);
    return value === 531 || value === 532 ? value : null;
  });
  const actionType = pickNumber((record) => {
    const value = toFiniteNumber(record.type);
    return value !== null && value !== 531 && value !== 532 && value !== 3300 ? value : null;
  });
  let credits: number | null = null;
  let rawRecord: JsonRecord | null = null;
  for (const { record } of ordered) {
    const hasCredits = Object.prototype.hasOwnProperty.call(record, "credits");
    const hasBalanceCredits = Object.prototype.hasOwnProperty.call(record, "bc");
    if (!hasCredits && !hasBalanceCredits) {
      continue;
    }
    const rawCredits = hasCredits ? record.credits : record.bc;
    if (rawCredits === undefined || rawCredits === null || (typeof rawCredits === "string" && !rawCredits.trim())) {
      continue;
    }
    const parsedCredits = toFiniteNumber(rawCredits);
    if (parsedCredits !== null && parsedCredits >= 0 && parsedCredits <= MAX_TEAM_CREDITS) {
      credits = parsedCredits;
      rawRecord = record;
    }
    break;
  }
  const expiryDays = pickNumber((record) => toFiniteNumber(record.ex));

  let raw: string | null = null;
  if (rawRecord) {
    const normalized: JsonRecord = { ...rawRecord };
    if (k1 !== null) normalized.k1 = k1;
    if (actionType !== null) normalized.type = actionType;
    if (credits !== null) normalized.credits = credits;
    if (expiryDays !== null) normalized.ex = expiryDays;
    try {
      raw = JSON.stringify(normalized);
    } catch {
      raw = null;
    }
  }

  return { k1, actionType, credits, expiryDays, raw };
}

export function buildTeamMessageEnvelope(input: {
  title?: string | null;
  body?: string | null;
  meta?: unknown;
}) {
  const parsed = parseTeamMessageMeta(input.meta);
  return JSON.stringify({
    msgContent: input.body?.trim() ?? "",
    msgTitle: input.title?.trim() ?? "",
    msgMeta: parsed.raw ?? ""
  });
}

export function renderTeamMessageContent(
  input: { content?: string | null; data2?: string | null; type?: number | null },
  appVariant: TeamAppVariant
) {
  const meta = parseTeamMessageMeta(input.content, input.data2, { k1: input.type });
  if (meta.credits === null) {
    return null;
  }
  const coin = appVariant === "dingdong" ? "叮咚币" : "说道币";
  const amount = meta.credits.toFixed(2);
  if (meta.actionType === 5) {
    return `任务完成，获得 ${amount} ${coin}`;
  }
  if (meta.actionType === 34) {
    return `兑换成功，${amount} ${coin}已到账`;
  }
  return `获得 ${amount} ${coin}`;
}
