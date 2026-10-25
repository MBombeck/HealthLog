/**
 * GET /api/admin/recovery-kit
 *
 * The recovery kit: every key a restore of this instance needs (the
 * application keys, including retired ones a backup still lists, the off-host
 * backup keys and the token key), each with its fingerprint and why it is
 * needed, and whether the admin's confirmation covers it. Ids and
 * fingerprints only, never key material. Cookie-only admin.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readRecoveryKit } from "@/lib/recovery/kit";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.recoveryKit.status" } });
  const kit = await readRecoveryKit();
  annotate({
    meta: {
      recovery_kit_due: kit.due,
      recovery_kit_keys: kit.keys.length,
      recovery_kit_unconfirmed: kit.unconfirmed.length,
    },
  });
  return apiSuccess(kit);
});
