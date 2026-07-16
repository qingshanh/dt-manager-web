import { Router } from "express";
import type { Request, Response } from "express";
import { eventBus } from "../services/event-bus.js";
import { verifyAuthToken } from "../middleware/auth.js";
import type { AppEvent } from "../services/event-bus.js";

export const eventsRouter = Router();

type SseEventSource = {
  once(event: string, listener: (...args: unknown[]) => void): unknown;
};

type SseResponse = SseEventSource & {
  writableEnded?: boolean;
  destroyed?: boolean;
  end(): unknown;
};

const activeSseCleanups = new Map<SseResponse, () => void>();

export function attachSseCleanup(input: {
  req: SseEventSource;
  res: SseResponse;
  clearHeartbeat: () => void;
  removeListener: () => void;
}) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    activeSseCleanups.delete(input.res);
    input.clearHeartbeat();
    input.removeListener();
    if (!input.res.writableEnded && !input.res.destroyed) {
      input.res.end();
    }
  };
  activeSseCleanups.set(input.res, cleanup);
  input.req.once("close", cleanup);
  input.res.once("close", cleanup);
  input.res.once("error", cleanup);
  return cleanup;
}

export function closeAllSseConnections() {
  for (const cleanup of [...activeSseCleanups.values()]) {
    cleanup();
  }
}

export function getActiveSseConnectionCountForTest() {
  return activeSseCleanups.size;
}

export function writeSseEvent(
  response: { write(chunk: string): boolean },
  type: string,
  payload: unknown
) {
  const eventWritten = response.write(`event: ${type}\n`);
  const dataWritten = response.write(`data: ${JSON.stringify(payload)}\n\n`);
  return eventWritten && dataWritten;
}

eventsRouter.get("/", (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) {
    return res.status(401).json({ code: 401, message: "Missing token", data: null });
  }

  let auth;
  try {
    auth = verifyAuthToken(token);
  } catch {
    return res.status(401).json({ code: 401, message: "Invalid token", data: null });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let cleanup: () => void = () => undefined;
  const send = (type: string, payload: unknown) => {
    if (!writeSseEvent(res, type, payload)) {
      cleanup();
    }
  };

  const listener = (event: AppEvent) => {
    if (event.adminId !== auth.userId) {
      return;
    }
    send(event.type, event.payload);
  };
  eventBus.on("event", listener);

  const timer = setInterval(() => {
    send("heartbeat", { time: new Date().toISOString() });
  }, 30000);

  cleanup = attachSseCleanup({
    req,
    res,
    clearHeartbeat: () => clearInterval(timer),
    removeListener: () => eventBus.off("event", listener)
  });
  send("connected", { time: new Date().toISOString() });
});
