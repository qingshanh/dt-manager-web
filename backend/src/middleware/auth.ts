import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import { config } from "../config.js";
import { AppError } from "../utils/errors.js";

type TokenPayload = {
  userId: number;
  username: string;
};

declare global {
  namespace Express {
    interface Request {
      auth?: TokenPayload;
    }
  }
}

export function signToken(payload: TokenPayload) {
  return jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as SignOptions["expiresIn"]
  });
}

export function verifyAuthToken(token: string) {
  return jwt.verify(token, config.JWT_SECRET) as TokenPayload;
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next(new AppError("Missing bearer token", 401, 401));
  }

  try {
    const token = authHeader.slice(7);
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    next(new AppError("Invalid or expired token", 401, 401));
  }
}
