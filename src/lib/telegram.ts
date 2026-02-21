/**
 * Minimal Telegram Bot API client for sending messages.
 * Uses the HTTP API directly — no library needed.
 */

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
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
    return (await res.json()) as TelegramResponse;
  } catch (err) {
    console.error(`[telegram] ${method} error:`, err);
    return { ok: false, description: "request_failed" };
  }
}

/**
 * Send a text message via the Telegram Bot API.
 * Returns true on success, false on failure (never throws).
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<boolean> {
  const json = await telegramApiRequest(botToken, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode ?? "HTML",
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
  if (!json.ok) {
    console.error("[telegram] sendMessage failed:", json.description);
  }
  return json.ok;
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
    console.error("[telegram] answerCallbackQuery failed:", json.description);
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
    console.error("[telegram] setWebhook failed:", json.description);
    return false;
  }
  return true;
}

export async function deleteTelegramWebhook(
  botToken: string,
): Promise<boolean> {
  const json = await telegramApiRequest(botToken, "deleteWebhook", {
    drop_pending_updates: false,
  });
  if (!json.ok) {
    console.error("[telegram] deleteWebhook failed:", json.description);
    return false;
  }
  return true;
}
