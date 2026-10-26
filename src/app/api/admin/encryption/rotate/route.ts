/**
 * POST /api/admin/encryption/rotate
 *
 * v1.23 — admin-triggered encryption-key rotation. Enqueues the
 * `encryption-key-rotate` pg-boss job, which re-encrypts the whole encrypted-
 * column corpus to the configured ACTIVE key id. This is the primary path on
 * the published image, which contains neither a package manager nor
 * `scripts/rotate-encryption-key.ts`; the CLI runs from a source checkout and
 * reuses the same column registry. Safe by construction:
 *
 *  - ACTIVE-KEY-ONLY + NEVER ADDS / DROPS A KEY: the job only writes the active
 *    key and never touches `ENCRYPTION_KEYS`. Dropping a key remains an env +
 *    redeploy act.
 *  - IDEMPOTENT: rows already on the active key are skipped; the singleton key
 *    coalesces duplicate triggers into one queued run.
 *
 * Auth: cookie-only `requireAdmin` (Bearer can never reach admin) PLUS
 * `requireFreshMfa` step-up — re-encrypting the whole sensitive corpus is a
 * high-blast-radius action. An admin without a second factor cannot use the
 * button and falls back to the CLI from a source checkout (intentional:
 * step-up cannot be softened).
 */
import {
  apiHandler,
  requireAdmin,
  requireFreshMfa,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  ENCRYPTION_KEY_ROTATE_SINGLETON,
  ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS,
} from "@/lib/jobs/encryption-key-rotate";
import { ENCRYPTION_KEY_ROTATE_QUEUE } from "@/lib/jobs/encryption-key-rotate-queue";
import { getActiveKeyId } from "@/lib/crypto";
import { NextRequest } from "next/server";

export const POST = apiHandler(async (request: NextRequest) => {
  // Cookie-only admin, then a fresh second factor. Both resolution paths are
  // cookie-only, so a Bearer token cannot reach either.
  await requireAdmin();
  const { user } = await requireFreshMfa(MFA_STEP_UP_MAX_AGE_SECONDS);
  annotate({ action: { name: "admin.encryption.rotate.requested" } });

  const boss = getGlobalBoss();
  if (!boss) {
    return apiError("Background worker is not available", 503);
  }

  const jobId = await boss.send(
    ENCRYPTION_KEY_ROTATE_QUEUE,
    { requestedByUserId: user.id, enqueuedAt: new Date().toISOString() },
    {
      // Coalesce duplicate triggers: at most one queued run at a time.
      singletonKey: ENCRYPTION_KEY_ROTATE_SINGLETON,
      retryLimit: 2,
      retryDelay: 60,
      expireInSeconds: ENCRYPTION_KEY_ROTATE_EXPIRE_SECONDS,
    },
  );

  await auditLog("admin.encryption.rotate.requested", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { activeKeyId: getActiveKeyId(), enqueued: Boolean(jobId) },
  });

  annotate({ meta: { rotate_enqueued: Boolean(jobId) } });

  // A null jobId means the singleton coalesced this trigger onto an already-
  // queued run — still "accepted" from the operator's point of view.
  return apiSuccess({ accepted: true, alreadyQueued: !jobId });
});
