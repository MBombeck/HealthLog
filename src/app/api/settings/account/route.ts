import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";
import {
  apiHandler,
  requireFreshMfaOrElevationIfEnrolled,
  MFA_STEP_UP_MAX_AGE_SECONDS,
} from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { kickOffhostPurge } from "@/lib/jobs/offhost-purge";
import {
  deleteGuardianAccountWithLifecycle,
  LastManagedGuardianError,
} from "@/lib/managed-profiles/lifecycle";
import {
  accountDeletionGraceDays,
  accountDeletionPurgeAt,
} from "@/lib/account-deletion/grace";
import {
  eraseAccount,
  lockAccountForDeletion,
} from "@/lib/account-deletion/lifecycle";
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import {
  assertAnotherAdminStays,
  LastAdminError,
} from "@/lib/auth/admin-roster";

export const dynamic = "force-dynamic";

/**
 * Delete the user account and ALL associated data.
 *
 * With a grace window (`ACCOUNT_DELETION_GRACE_DAYS`, 14 by default)
 * the account is locked rather than erased: every credential is revoked and
 * sign-in is refused at once, nothing acts for the account any more, and the
 * purge job erases it when the window ends. Until then an admin can undo it,
 * and the record, its stored copies and its off-host objects are exactly as
 * they were. With the window set to 0 the account is erased here, as before:
 * cascading deletes in the schema handle all related records.
 *
 * v1.23 — for an account with a second factor active this requires a fresh
 * step-up (within MFA_STEP_UP_MAX_AGE_SECONDS) in addition to the typed
 * confirmation, so a hijacked live session cannot erase the record. Accounts
 * without MFA are unaffected and keep the typed-confirmation-only contract.
 *
 * Over Bearer the fresh step-up is a single-use elevation from
 * `POST /api/auth/step-up` in the `X-Step-Up` header, minted against a TOTP,
 * security-key, or passkey proof — a password proof is refused. App Store
 * guideline 5.1.1(v) requires in-app deletion, and until this arm existed an
 * MFA-enrolled account could not delete itself from the native app at all.
 * The elevation is spent immediately before the erasure, after every cheap
 * refusal, so a bad confirmation does not burn it.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const auth = await requireFreshMfaOrElevationIfEnrolled(
    MFA_STEP_UP_MAX_AGE_SECONDS,
  );
  const { user } = auth;

  let confirm = "";
  try {
    const raw = await request.text();
    if (raw.length > 64 * 1024) {
      return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
    }
    const body = JSON.parse(raw);
    confirm = typeof body?.confirm === "string" ? body.confirm : "";
  } catch {
    return apiError("Invalid request", 422);
  }

  if (confirm !== "DELETE_ACCOUNT") {
    return apiError(
      "Confirmation missing. Send { confirm: 'DELETE_ACCOUNT' }",
      422,
    );
  }

  // Prevent last admin from deleting themselves
  if (user.role === "ADMIN") {
    // An admin already pending deletion is on their way out and cannot sign
    // in: they do not count as the one who stays.
    const adminCount = await prisma.user.count({
      where: { role: "ADMIN", ...ACTIVE_ACCOUNT },
    });
    if (adminCount <= 1) {
      return apiError("The last admin account cannot be deleted", 400);
    }
  }

  const userId = user.id;
  const username = user.username;

  // Every refusal that costs nothing has passed; spend the Bearer elevation
  // now (a no-op on the cookie path). A lost claim throws the same 401 as a
  // missing one, so a concurrent redemption still has exactly one winner.
  //
  // One refusal can still land after this: the last-Guardian 409, which is
  // decided under the record lock inside the lifecycle transaction and has no
  // cheap pre-check. That caller spends a proof on a refusal and has to mint
  // another. Moving the spend past the transaction would be the worse trade —
  // the elevation would stay redeemable while the erasure was already running.
  await auth.commitElevation();

  const requestedAt = new Date();
  const purgeAt = accountDeletionPurgeAt(
    requestedAt,
    accountDeletionGraceDays(),
  );

  try {
    await deleteGuardianAccountWithLifecycle(
      userId,
      async (tx) => {
        // Checked again under the roster lock: two admins deleting at the
        // same moment must not each count the other.
        if (user.role === "ADMIN") await assertAnotherAdminStays(tx, userId);
        // The invariant has now passed, so this success event cannot survive
        // a refusal. On an immediate erasure it is purged with the rest of the
        // account's audit history; during a grace window it is the account's
        // own record of the request.
        await auditLog("user.account.delete", {
          userId,
          ipAddress: getClientIp(request),
          details: {
            username,
            scheduledPurgeAt: purgeAt?.toISOString() ?? null,
          },
          client: tx,
        });

        if (purgeAt) {
          // Locked, not erased: credentials revoked in this transaction,
          // the record untouched until the purge job reaches `purgeAt`.
          await lockAccountForDeletion(tx, {
            userId,
            requestedById: userId,
            requestedAt,
            purgeAt,
          });
          return;
        }

        // No window: erase now, inside the same record lifecycle transaction
        // so a refusal leaves every account state intact (sessions, the
        // account's audit history — GDPR Art. 17 — the off-host purge
        // request, then the row with everything cascading from it).
        await eraseAccount(tx, userId, "account_deleted");
      },
      { erasing: purgeAt === null },
    );
  } catch (error) {
    if (error instanceof LastAdminError) {
      return apiError("The last admin account cannot be deleted", 400);
    }
    if (error instanceof LastManagedGuardianError) {
      return apiError(
        "Add another Guardian or delete the managed profile first",
        409,
        { errorCode: "managed_profile.guardian.required" },
      );
    }
    throw error;
  }

  if (!purgeAt) await kickOffhostPurge();

  annotate({
    action: { name: "settings.account.delete" },
    meta: { username, deletion_scheduled: purgeAt !== null },
  });

  // `deleted` stays true either way: from the person's side the account is
  // gone now. `scheduledPurgeAt` says when it is erased, null when it already
  // was.
  return apiSuccess({
    deleted: true,
    scheduledPurgeAt: purgeAt?.toISOString() ?? null,
  });
});
