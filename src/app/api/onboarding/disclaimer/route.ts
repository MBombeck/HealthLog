import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError, safeJson } from "@/lib/api-response";
import { DISCLAIMER_VERSION } from "@/lib/onboarding/disclaimer";

/**
 * v1.18.6 (DISC-02) — one-time medical-disclaimer acknowledgment.
 *
 *   POST { version: string }
 *     → stamps `users.disclaimer_acknowledged_at = now()` +
 *       `disclaimer_acknowledged_version = <version>`. Idempotent: a repeat
 *       acknowledgment of the same version simply refreshes the timestamp.
 *
 * Replaces the per-page / per-chart disclaimer banners removed app-wide in
 * the same release. The acknowledged legal text stays reachable on the public
 * privacy page. Never auto-set; the onboarding welcome step is the one writer.
 */

const bodySchema = z.object({
  // Echoed back from the client so a stale shell cannot silently record an
  // acknowledgment of copy it never rendered. Bounded; the server pins the
  // canonical version it persists regardless.
  version: z.string().min(1).max(64),
});

export const POST = apiHandler(async (request) => {
  const { user } = await requireAuth();

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 4 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = z.safeParse(bodySchema, rawBody);
  if (!parsed.success) {
    return apiError("Invalid input", 422, {
      errorCode: "onboarding.disclaimer.invalid",
    });
  }

  // The server pins the canonical version it stamps — the body version is
  // only a freshness signal, never the source of truth.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      disclaimerAcknowledgedAt: new Date(),
      disclaimerAcknowledgedVersion: DISCLAIMER_VERSION,
    },
  });

  annotate({
    action: { name: "onboarding.disclaimer.acknowledge" },
    meta: {
      version: DISCLAIMER_VERSION,
      clientVersion: parsed.data.version,
    },
  });

  return apiSuccess({ acknowledgedVersion: DISCLAIMER_VERSION });
});
