export class AppError extends Error {
  statusCode: number;
  code: number;

  constructor(message: string, statusCode = 400, code = statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function assertFound<T>(value: T | null | undefined, message = "Resource not found"): T {
  if (!value) {
    throw new AppError(message, 404, 404);
  }
  return value;
}
