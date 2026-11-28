import { z } from "zod/v4";

/** `PATCH /api/setup`: hide the setup card, or show it again. */
export const setupPatchSchema = z
  .object({ cardDismissed: z.boolean() })
  .strict();
