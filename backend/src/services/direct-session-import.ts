import { AppError } from "../utils/errors.js";

type DirectSessionImportDependencies<TSession, TValidation, TStored> = {
  validate(value: TSession): Promise<TValidation | null>;
  persist(value: TSession): Promise<TStored>;
};

export type DirectSessionValidationFailureCategory = "timeout" | "unauthorized" | "device" | "generic";

export function classifyDirectSessionValidationFailure(
  error: unknown,
): Exclude<DirectSessionValidationFailureCategory, "timeout"> {
  const message = error instanceof Error ? error.message : String(error);
  if (/unauthorized|token|401/i.test(message)) {
    return "unauthorized";
  }
  if (/device/i.test(message)) {
    return "device";
  }
  return "generic";
}

export function persistedSessionValidationFailureMessage(category: DirectSessionValidationFailureCategory) {
  if (category === "timeout") {
    return "Direct 会话校验超时，请重新导入有效会话。";
  }
  if (category === "unauthorized") {
    return "Token 已失效或过期，请重新导入有效会话。";
  }
  if (category === "device") {
    return "设备参数与会话不匹配，请重新导入有效会话。";
  }
  return "Direct 会话校验失败，请重新导入有效会话。";
}

export async function validateThenPersistDirectSession<
  TSession extends { deviceId: string },
  TValidation extends { deviceId: string },
  TStored,
>(
  session: TSession,
  dependencies: DirectSessionImportDependencies<TSession, TValidation, TStored>,
) {
  let validation: TValidation | null;
  try {
    validation = await dependencies.validate(session);
  } catch (error) {
    const category = classifyDirectSessionValidationFailure(error);
    if (category === "unauthorized") {
      throw new AppError("Token 已失效或过期，未保存任何会话信息。", 409, 409);
    }
    if (category === "device") {
      throw new AppError("设备参数与会话不匹配，未保存任何会话信息。", 409, 409);
    }
    throw new AppError("Direct 会话校验失败，未保存任何会话信息。", 409, 409);
  }

  if (!validation) {
    throw new AppError("Direct 会话校验超时，未保存任何会话信息。", 409, 409);
  }

  const validatedSession = { ...session, deviceId: validation.deviceId };
  const storedSession = await dependencies.persist(validatedSession);
  return { storedSession, validation };
}
