import { z } from "zod/v4";

export const withingsCredentialsSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
});
