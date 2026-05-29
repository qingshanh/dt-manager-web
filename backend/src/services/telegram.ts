import { AppError } from "../utils/errors.js";

export class TelegramService {
  async sendMessage(input: { botToken: string; chatId: string; text: string; apiBaseUrl?: string | null; replyMarkup?: unknown }) {
    if (!input.botToken || !input.chatId) {
      throw new AppError("Telegram config is incomplete", 400, 400);
    }
    const json = await this.callApi<{ result?: { message_id?: number } }>(input.botToken, "sendMessage", {
      chat_id: input.chatId,
      text: input.text,
      ...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {})
    }, input.apiBaseUrl);
    return json.result?.message_id?.toString() ?? "";
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
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new AppError(`Telegram ${method} failed: ${response.status}`, 502, 502);
    }
    return (await response.json()) as T;
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
