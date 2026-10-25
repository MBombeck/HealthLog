/**
 * POST /api/admin/recovery-kit/verify  { kind, id, keyCopy }
 *
 * "Check my copy": the admin pastes the copy of one key the kit lists and
 * learns whether it is that key. The value is compared in memory (constant
 * time on the compared bytes) and dropped. It is never stored, never logged,
 * never echoed: the Zod issue list is not returned for this body (a
 * validation failure is a plain 422), and the field name is on the
 * observability denylist.
 *
 * A boolean answer is no oracle against a 256-bit key; the 5 per minute limit
 * per admin is there to keep the route from being anyone's busy loop. Over
 * plain HTTP the value crosses the network in clear, as the admin's password
 * does; the client says so before sending.
 */
import type { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, safeJson } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyKitKey } from "@/lib/recovery/kit";
import { KIT_KEY_KINDS } from "@/lib/recovery/kit-rules";

export const dynamic = "force-dynamic";

const KIT_VERIFY_LIMIT = 5;
const KIT_VERIFY_WINDOW_MS = 60 * 1000;

const verifySchema = z
  .object({
    kind: z.enum(KIT_KEY_KINDS),
    id: z.string().min(1).max(64),
    keyCopy: z.string().min(1).max(512),
  })
  .strict();

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.recoveryKit.verify" } });

  const limit = await checkRateLimit(
    `recovery-kit-verify:${user.id}`,
    KIT_VERIFY_LIMIT,
    KIT_VERIFY_WINDOW_MS,
  );
  if (!limit.allowed) {
    return apiError("Too many checks. Try again in a minute.", 429);
  }

  const body = await safeJson(request, { maxBytes: 2048 });
  if (body.error) return body.error;
  const parsed = verifySchema.safeParse(body.data);
  if (!parsed.success) {
    // Deliberately not `returnAllZodIssues`: nothing derived from this body
    // goes back over the wire.
    return apiError("Paste the key exactly as it is set.", 422);
  }

  const { kind, id } = parsed.data;
  const matches = verifyKitKey({ kind, id, value: parsed.data.keyCopy });
  annotate({ meta: { recovery_kit_verify_matches: matches } });
  await auditLog("recovery.kit.verified", {
    userId: user.id,
    details: { kind, keyId: id, matches },
  });
  return apiSuccess({ matches, kind, id });
});
