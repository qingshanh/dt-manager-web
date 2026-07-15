import { AppError } from "../utils/errors.js";

const TELEGRAM_API_TIMEOUT_MS = 8_000;

export type TelegramParseMode = "HTML";

export class TelegramApiError extends AppError {
  readonly status: number;
  readonly description: string;
  readonly telegramErrorCode: number | null;
  readonly method: string;

  constructor(input: {
    method: string;
    status: number;
    description?: string;
    telegramErrorCode?: number | null;
  }) {
    const telegramErrorCode = input.telegramErrorCode ?? null;
    super(`Telegram ${input.method} failed: ${telegramErrorCode ?? input.status}`, 502, 502);
    this.name = "TelegramApiError";
    this.method = input.method;
    this.status = input.status;
    this.description = input.description ?? "";
    this.telegramErrorCode = telegramErrorCode;
  }
}

type TelegramMessageInput = {
  botToken: string;
  chatId: string;
  text: string;
  apiBaseUrl?: string | null;
  replyMarkup?: unknown;
  parseMode?: TelegramParseMode;
};

export class TelegramService {
  async sendMessage(input: TelegramMessageInput) {
    if (!input.botToken || !input.chatId) {
      throw new AppError("Telegram config is incomplete", 400, 400);
    }
    const json = await this.callApi<{ result?: { message_id?: number } }>(input.botToken, "sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {})
    }, input.apiBaseUrl);
    return json.result?.message_id?.toString() ?? "";
  }

  async editMessageText(input: TelegramMessageInput & { messageId: number }) {
    if (!input.botToken || !input.chatId || !Number.isSafeInteger(input.messageId) || input.messageId <= 0) {
      throw new AppError("Telegram edit config is incomplete", 400, 400);
    }
    await this.callApi(input.botToken, "editMessageText", {
      chat_id: input.chatId,
      message_id: input.messageId,
      text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {})
    }, input.apiBaseUrl);
  }

  async setMyCommands(input: {
    botToken: string;
    commands: Array<{ command: string; description: string }>;
    apiBaseUrl?: string | null;
  }) {
    if (!input.botToken) {
      return;
    }
    await this.callApi(input.botToken, "setMyCommands", { commands: input.commands }, input.apiBaseUrl);
  }

  async answerCallbackQuery(input: { botToken: string; callbackQueryId: string; text?: string; apiBaseUrl?: string | null }) {
    if (!input.botToken || !input.callbackQueryId) {
      return;
    }
    await this.callApi(input.botToken, "answerCallbackQuery", {
      callback_query_id: input.callbackQueryId,
      ...(input.text ? { text: input.text } : {})
    }, input.apiBaseUrl);
  }

  async getUpdates(input: { botToken: string; offset?: number; timeout?: number; limit?: number; apiBaseUrl?: string | null }) {
    if (!input.botToken) {
      return [];
    }
    const json = await this.callApi<{ result?: TelegramUpdate[] }>(
      input.botToken,
      "getUpdates",
      {
        offset: input.offset,
        timeout: input.timeout ?? 0,
        limit: input.limit ?? 10,
        allowed_updates: ["message", "callback_query"]
      },
      input.apiBaseUrl
    );
    return json.result ?? [];
  }

  async callApi<T = unknown>(botToken: string, method: string, body: unknown, apiBaseUrl?: string | null): Promise<T> {
    const baseUrl = normalizeTelegramBaseUrl(apiBaseUrl);
    const response = await fetch(`${baseUrl}/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TELEGRAM_API_TIMEOUT_MS)
    });

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (!response.ok) {
        throw new TelegramApiError({ method, status: response.status });
      }
      throw error;
    }

    if (!response.ok || isTelegramFailureResponse(json)) {
      throw new TelegramApiError({
        method,
        status: response.status,
        description: telegramDescription(json),
        telegramErrorCode: telegramErrorCode(json)
      });
    }
    return json as T;
  }
}

export const telegramService = new TelegramService();

export type TelegramUpdate = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat: {
        id: number;
        type?: string;
        title?: string;
        username?: string;
      };
    };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
  message?: {
    message_id: number;
    text?: string;
    chat: {
      id: number;
      type?: string;
      title?: string;
      username?: string;
    };
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
    };
  };
};

function normalizeTelegramBaseUrl(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "https://api.telegram.org";
}

function isTelegramFailureResponse(value: unknown) {
  return isRecord(value) && value.ok === false;
}

function telegramDescription(value: unknown) {
  return isRecord(value) && typeof value.description === "string" ? value.description : "";
}

function telegramErrorCode(value: unknown) {
  if (!isRecord(value)) return null;
  const errorCode = value.error_code;
  return typeof errorCode === "number" && Number.isSafeInteger(errorCode) && errorCode > 0 ? errorCode : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
