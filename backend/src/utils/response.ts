import type { Response } from "express";

export function ok<T>(res: Response, data?: T, message = "ok") {
  return res.json({
    code: 0,
    message,
    data: data ?? null
  });
}

export function paged<T>(res: Response, payload: { list: T[]; total: number; page: number; pageSize: number }) {
  return ok(res, payload);
}
