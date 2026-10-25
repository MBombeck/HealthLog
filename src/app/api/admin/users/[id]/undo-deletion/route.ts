/**
 * POST /api/admin/users/[id]/undo-deletion — give back an account pending
 * deletion.
 *
 * Account deletion, and a Guardian's deletion of a managed profile, lock the
 * account for a grace window before the purge job erases it
 * (`ACCOUNT_DELETION_GRACE_DAYS`). Until then the record, its stored copies
 * and its off-host objects are untouched, so undoing it clears the pending
 * stamp and nothing else: everything the account held is there as it was.
 * Every credential stays revoked; the person signs in again (a managed
 * profile is reached through its Guardians, as before).
 *
 * Cookie-only (`requireAdmin`), audit-logged for the admin and on the account
 * itself. Serialised with the purge job on the account row, so an undo either
 * lands before the erasure or answers 404 after it.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { cancelAccountDeletion } from "@/lib/account-deletion/lifecycle";

export const dynamic = "force-dynamic";

export const POST = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;
    annotate({
      action: {
        name: "admin.users.undo-deletion",
        entity_type: "user",
        entity_id: id,
      },
    });

    const outcome = await cancelAccountDeletion({
      userId: id,
      adminId: admin.id,
      ipAddress: getClientIp(request),
    });
    if (outcome === "not_found") return apiError("User not found", 404);
    if (outcome === "not_pending") {
      return apiError("This account is not pending deletion", 409, {
        errorCode: "account.deletion.not_pending",
      });
    }
    return apiSuccess({ restored: true });
  },
);
