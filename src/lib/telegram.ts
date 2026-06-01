/**
 * Minimal Telegram Bot API client for sending messages.
 * Uses the HTTP API directly — no library needed.
 */
import { getEvent } from "@/lib/logging/context";
import { safeFetch } from "@/lib/safe-fetch";

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

interface SendMessageOptions {
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: TelegramReplyMarkup;
}

async function telegramApiRequest(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<TelegramResponse> {
  const start = performance.now();
  try {
    const res = await safeFetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 10_000 },
    );
    const data = (await res.json()) as TelegramResponse;
    getEvent()?.addExternalCall({
      service: "telegram",
      method,
      duration_ms: Math.round(performance.now() - start),
      status: res.status,
      error: data.ok ? undefined : data.description,
    });
    return data;
  } catch (err) {
    getEvent()?.addExternalCall({
      service: "telegram",
      method,
      duration_ms: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : "request_failed",
    });
    return { ok: false, description: "request_failed" };
  }
}

export interface SendMessageResult {
  ok: boolean;
  messageId?: number;
  /**
   * Bot-API `description` field on failure. Surfaced so the dispatcher
   * (v1.4.15 Phase B3) can classify "chat not found" / "blocked by the
   * user" as hard rejects vs a generic 5xx as a soft reject.
   */
  errorDescription?: string;
}

/**
 * Send a text message via the Telegram Bot API.
 * Returns { ok, messageId } on success, { ok: false, errorDescription } on
 * failure (never throws).
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  const json = await telegramApiRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode ?? "HTML",
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
  if (!json.ok) {
    getEvent()?.addWarning(
      `[telegram] sendMessage failed: ${json.description}`,
    );
    return { ok: false, errorDescription: json.description };
  }
  const messageId = (json.result as { message_id?: number })?.message_id;
  return { ok: true, messageId };
}

export async function answerTelegramCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  text?: string,
): Promise<boolean> {
  const json = await telegramApiRequest(botToken, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: false } : {}),
  });
  if (!json.ok) {
    getEvent()?.addWarning(
      `[telegram] answerCallbackQuery failed: ${json.description}`,
    );
  }
  return json.ok;
}

export async function setTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken?: string,
): Promise<boolean> {
  const json = await telegramApiRequest(botToken, "setWebhook", {
    url: webhookUrl,
    ...(secretToken ? { secret_token: secretToken } : {}),
    drop_pending_updates: false,
  });
  if (!json.ok) {
    getEvent()?.addWarning(`[telegram] setWebhook failed: ${json.description}`);
    return false;
  }
  return true;
}

export async function deleteMessage(
  botToken: string,
  chatId: string,
  messageId: number,
): Promise<boolean> {
  const json = await telegramApiRequest(botToken, "deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  });
  if (!json.ok) {
    getEvent()?.addWarning(
      `[telegram] deleteMessage failed: ${json.description}`,
    );
  }
  return json.ok;
}

export async function deleteTelegramWebhook(
  botToken: string,
): Promise<boolean> {
  const json = await telegramApiRequest(botToken, "deleteWebhook", {
    drop_pending_updates: false,
  });
  if (!json.ok) {
    getEvent()?.addWarning(
      `[telegram] deleteWebhook failed: ${json.description}`,
    );
    return false;
  }
  return true;
}
