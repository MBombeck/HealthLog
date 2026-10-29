import { prisma } from "@/lib/db";
import {
  assertAnotherAdminStays,
  LastAdminError,
} from "@/lib/auth/admin-roster";
import {
  apiHandler,
  assertRecentCookieProof,
  requireAdmin,
} from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requestAccountDeletion } from "@/lib/account-deletion/request";
import { lockPendingAccount } from "@/lib/account-deletion/lifecycle";
import { LastManagedGuardianError } from "@/lib/managed-profiles/lifecycle";
import { adminDeleteUserSchema } from "@/lib/validations/admin";

const updateUserSchema = z
  .object({
    username: z.string().min(3).max(30).optional(),
    email: z.string().email().nullable().optional(),
    role: z.enum(["ADMIN", "USER"]).optional(),
    // v1.23 — per-user "require a second factor" override. Effective requirement
    // is the OR of this and the instance-wide AppSettings.mfaRequired policy.
    mfaEnforced: z.boolean().optional(),
    // Document vault — per-user storage-quota override in bytes. Null clears
    // the override (the instance default applies again). Same bounds as the
    // instance-wide setting.
    documentQuotaBytes: z
      .number()
      .int()
      .min(10_485_760)
      .max(1_099_511_627_776)
      .nullable()
      .optional(),
  })
  .strict();

export const PUT = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user } = await requireAdmin();

    const { id } = await params;
    annotate({
      action: {
        name: "admin.users.update",
        entity_type: "user",
        entity_id: id,
      },
    });

    const parsed = await parseJsonBody(request, updateUserSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { role: true },
    });
    if (!target) return apiError("User not found", 404);

    const demoting = parsed.data.role === "USER" && target.role === "ADMIN";

    let updatedUser;
    try {
      updatedUser = await prisma.$transaction(async (tx) => {
        // Another admin who can sign in must stay: one pending deletion does
        // not count, and the count holds the roster lock an admin's own
        // deletion takes too.
        if (demoting) await assertAnotherAdminStays(tx, id);
        return tx.user.update({
          where: { id },
          data: {
            ...(parsed.data.username !== undefined && {
              username: parsed.data.username,
            }),
            ...(parsed.data.email !== undefined && {
              email: parsed.data.email,
            }),
            ...(parsed.data.role !== undefined && { role: parsed.data.role }),
            ...(parsed.data.mfaEnforced !== undefined && {
              mfaEnforced: parsed.data.mfaEnforced,
            }),
            ...(parsed.data.documentQuotaBytes !== undefined && {
              documentQuotaBytes:
                parsed.data.documentQuotaBytes === null
                  ? null
                  : BigInt(parsed.data.documentQuotaBytes),
            }),
          },
          select: {
            id: true,
            username: true,
            email: true,
            role: true,
            createdAt: true,
            mfaEnforced: true,
            documentQuotaBytes: true,
          },
        });
      });
    } catch (error) {
      if (error instanceof LastAdminError) {
        return apiError("The last admin cannot be demoted", 400);
      }
      throw error;
    }

    await auditLog("admin.user.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { targetUserId: id, changes: parsed.data },
    });

    return apiSuccess({
      ...updatedUser,
      // BigInt → Number for the JSON envelope; null = no override.
      documentQuotaBytes:
        updatedUser.documentQuotaBytes === null
          ? null
          : Number(updatedUser.documentQuotaBytes),
    });
  },
);

/** A refusal decided under the account's row lock, inside the transaction. */
class DeletionRefusal extends Error {
  constructor(readonly kind: "not_found" | "managed_profile" | "pending") {
    super(`admin deletion refused: ${kind}`);
    this.name = "DeletionRefusal";
  }
}

function deletionRefusalResponse(kind: DeletionRefusal["kind"]): Response {
  if (kind === "not_found") return apiError("User not found", 404);
  if (kind === "managed_profile") {
    return apiError("A managed profile is deleted by its Guardians", 409, {
      errorCode: "admin.users.delete.managed_profile",
    });
  }
  return apiError("This account is already pending deletion", 409, {
    errorCode: "account.deletion.already_pending",
  });
}

/**
 * DELETE /api/admin/users/{id} — an admin deletes another account.
 *
 * The same request the account's own deletion makes
 * (`requestAccountDeletion`): with a grace window the account is locked at
 * once (every credential revoked, sign-in refused) and erased by the purge job
 * when the window ends, and `POST /api/admin/users/{id}/undo-deletion` gives it
 * back until then; with `ACCOUNT_DELETION_GRACE_DAYS=0` it is erased here.
 *
 * Cookie-only (`requireAdmin`) behind a fresh proof (`assertRecentCookieProof`,
 * the gate in front of the other admin acts on someone's data), with the typed
 * confirmation the self-deletion asks for. Refused for the caller's own
 * account (that is the account settings' deletion, with its own step-up), for
 * the last admin who can sign in, for a managed profile (its Guardians delete
 * it), for an account already pending deletion, and for the last Guardian of
 * a managed profile. Audit-logged for the admin and on the account itself.
 */
export const DELETE = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin, session } = await requireAdmin();
    await assertRecentCookieProof(admin, session.id);

    const { id } = await params;
    annotate({
      action: {
        name: "admin.users.delete",
        entity_type: "user",
        entity_id: id,
      },
    });

    const parsed = await parseJsonBody(request, adminDeleteUserSchema, {
      maxBytes: 4 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    if (id === admin.id) {
      return apiError(
        "Delete your own account from your account settings",
        400,
        { errorCode: "admin.users.delete.self" },
      );
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { role: true, username: true },
    });
    if (!target) return apiError("User not found", 404);

    let purgeAt: Date | null;
    try {
      ({ purgeAt } = await requestAccountDeletion({
        userId: id,
        targetIsAdmin: target.role === "ADMIN",
        requestedById: admin.id,
        inTransaction: async (tx, scheduledPurgeAt) => {
          const state = await lockPendingAccount(tx, id);
          if (!state) throw new DeletionRefusal("not_found");
          if (state.managedProfile)
            throw new DeletionRefusal("managed_profile");
          if (state.pending) throw new DeletionRefusal("pending");
          const details = {
            targetUserId: id,
            username: target.username,
            scheduledPurgeAt: scheduledPurgeAt?.toISOString() ?? null,
          };
          await auditLog("admin.user.delete", {
            userId: admin.id,
            ipAddress: getClientIp(request),
            details,
            client: tx,
          });
          // On the account itself too, so its own activity shows who asked.
          // An immediate erasure takes this row with the account's history.
          await auditLog("user.account.delete", {
            userId: id,
            actorUserId: admin.id,
            details: { ...details, requestedBy: "admin" },
            client: tx,
          });
        },
      }));
    } catch (error) {
      if (error instanceof DeletionRefusal) {
        return deletionRefusalResponse(error.kind);
      }
      if (error instanceof LastAdminError) {
        return apiError("The last admin account cannot be deleted", 400);
      }
      if (error instanceof LastManagedGuardianError) {
        return apiError(
          "This account is the last Guardian of a managed profile. Add another Guardian or delete the profile first",
          409,
          { errorCode: "managed_profile.guardian.required" },
        );
      }
      throw error;
    }

    annotate({ meta: { deletion_scheduled: purgeAt !== null } });
    return apiSuccess({
      deleted: true,
      scheduledPurgeAt: purgeAt?.toISOString() ?? null,
    });
  },
);
