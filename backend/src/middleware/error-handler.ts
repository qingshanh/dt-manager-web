import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";

export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    logger.warn("Request validation failed", {
      method: req.method,
      path: req.originalUrl,
      issue: error.issues[0]?.message
    });
    return res.status(400).json({
      code: 400,
      message: error.issues[0]?.message ?? "Invalid request payload",
      data: error.flatten()
    });
  }

  if (error instanceof AppError) {
    logger.warn("Request failed", {
      method: req.method,
      path: req.originalUrl,
      statusCode: error.statusCode,
      message: error.message
    });
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      data: null
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error("Unhandled request error", {
    method: req.method,
    path: req.originalUrl,
    message,
    stack: error instanceof Error ? error.stack : undefined
  });
  return res.status(500).json({
    code: 500,
    message: config.NODE_ENV === "production" ? "Internal server error" : message || "Internal server error",
    data: config.NODE_ENV === "production" ? null : { path: req.originalUrl }
  });
}
