import { z } from "zod/v4";

export const telegramSettingsSchema = z.object({
  botToken: z.string().max(100).optional(),
  chatId: z.string().max(50).optional(),
  enabled: z.boolean(),
});
