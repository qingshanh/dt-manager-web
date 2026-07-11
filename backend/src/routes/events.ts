import { Router } from "express";
import type { Request, Response } from "express";
import { eventBus } from "../services/event-bus.js";
import { verifyAuthToken } from "../middleware/auth.js";
import type { AppEvent } from "../services/event-bus.js";

export const eventsRouter = Router();

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

  const send = (type: string, payload: unknown) => {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send("connected", { time: new Date().toISOString() });

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

  req.on("close", () => {
    clearInterval(timer);
    eventBus.off("event", listener);
    res.end();
  });
});
