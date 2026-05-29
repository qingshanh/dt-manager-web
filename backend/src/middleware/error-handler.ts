import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) {
    return res.status(400).json({
      code: 400,
      message: error.issues[0]?.message ?? "Invalid request payload",
      data: error.flatten()
    });
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json({
      code: error.code,
      message: error.message,
      data: null
    });
  }

  logger.error("Unhandled error", error);
  return res.status(500).json({
    code: 500,
    message: "Internal server error",
    data: null
  });
}
