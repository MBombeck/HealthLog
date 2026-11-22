/**
 * 1.49 — `PATCH /api/admin/server-setup`: one step answered or passed.
 *
 * Strict, so a field the route does not read is a 422 that names it rather
 * than ignored. Settings themselves never ride this body: each step's admin
 * cards save through their own routes, and this records the step.
 */
import { z } from "zod/v4";

import { SERVER_SETUP_STEP_IDS } from "@/lib/admin/server-setup";

export const serverSetupStepPatchSchema = z
  .object({
    step: z.enum(SERVER_SETUP_STEP_IDS),
    status: z.enum(["done", "skipped"]),
  })
  .strict();

