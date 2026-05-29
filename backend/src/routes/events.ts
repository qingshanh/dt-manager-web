import { Router } from "express";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { eventBus } from "../services/event-bus.js";

export const eventsRouter = Router();

eventsRouter.get("/", (req: Request, res: Response) => {
  const token = String(req.query.token ?? "");
  if (!token) {
    return res.status(401).json({ code: 401, message: "Missing token", data: null });
  }

  try {
    jwt.verify(token, config.JWT_SECRET);
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

  const listener = (event: { type: string; payload: unknown }) => {
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
