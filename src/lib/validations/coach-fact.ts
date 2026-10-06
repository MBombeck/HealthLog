/**
 * v1.41 — request schemas for the Coach memory list
 * (`/api/insights/coach/facts` + `/api/insights/coach/facts/[id]`).
 *
 * Lives outside the route files so the OpenAPI registry can import it without
 * touching the route modules. No `userId` field anywhere: the owner is always
 * narrowed from the session.
 *
 * - POST saves one of the person's own Coach messages as a fact (the remember
 *   button). The body names the message, never the text: the server reads
 *   the message it stored, so a client cannot write arbitrary memory through
 *   this surface.
 * - PATCH edits a fact's wording. Only the text; the category and the source
 *   stay as they are.
 */
import { z } from "zod/v4";

import { REMEMBER_FACT_MAX_CHARS } from "@/lib/ai/coach/memory/shared";

export const coachFactCreateSchema = z
  .object({
    messageId: z.string().min(1).max(64),
  })
  .strict();

export const coachFactPatchSchema = z
  .object({
    fact: z.string().trim().min(3).max(REMEMBER_FACT_MAX_CHARS),
  })
  .strict();
