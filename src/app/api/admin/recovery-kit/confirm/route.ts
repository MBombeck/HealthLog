/**
 * POST /api/admin/recovery-kit/confirm  { entries: [{ kind, id, fingerprint }] }
 *
 * The admin states that a copy of every key in the kit is kept outside the
 * server. The body is the kit as the admin was shown it; when that is no
 * longer the kit (a rotation, a new backup key, a restart with other keys
 * since the page loaded) the answer is 409 `recovery.kit.stale` with the
 * current kit, and nothing is recorded. No step-up: confirming is a low-risk
 * write that reveals nothing.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { confirmRecoveryKit } from "@/lib/recovery/kit";
import {
  kitConfirmationSchema,
  RECOVERY_KIT_STALE_CODE,
} from "@/lib/recovery/kit-rules";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAdmin();
  annotate({ action: { name: "admin.recoveryKit.confirm" } });

  const parsed = await parseJsonBody(request, kitConfirmationSchema, {
    maxBytes: 8 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const result = await confirmRecoveryKit({
    shown: parsed.data.entries,
    userId: user.id,
  });
  if (!result.ok) {
    annotate({ meta: { recovery_kit_stale: true } });
    return apiError(
      "The recovery kit changed since this page was loaded. Reload, check the keys it lists now, and confirm again.",
      409,
      { errorCode: RECOVERY_KIT_STALE_CODE },
    );
  }

  await auditLog("recovery.kit.confirmed", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      keys: result.kit.keys.map(({ kind, id, fingerprint }) => ({
        kind,
        id,
        fingerprint,
      })),
    },
  });
  return apiSuccess(result.kit);
});
