import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.users.list" } });

  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      createdAt: true,
      mfaEnforced: true,
      documentQuotaBytes: true,
      deletionRequestedAt: true,
      deletionPurgeAt: true,
      deletionRequestedById: true,
      managedProfileAt: true,
      _count: { select: { passkeys: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return apiSuccess(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt,
      // v1.23 — per-user "require a second factor" override. The effective
      // requirement is the OR of this and the instance-wide policy.
      mfaEnforced: u.mfaEnforced,
      // Document vault — per-user storage-quota override. Null = the
      // instance default applies. BigInt in Prisma, number on the wire
      // (max override 1 TiB, comfortably inside Number's safe range).
      documentQuotaBytes:
        u.documentQuotaBytes === null ? null : Number(u.documentQuotaBytes),
      passkeyCount: u._count.passkeys,
      // A record somebody else runs. Its Guardians delete it, so the list
      // offers no admin deletion on it.
      managedProfile: u.managedProfileAt != null,
      // An account pending deletion: when it was asked for, when the
      // purge job erases it, and who asked: the account itself, a Guardian
      // (a managed profile), or an admin. Null on every other account.
      // The list offers "Undo deletion" on these rows until `purgeAt`.
      deletion: u.deletionRequestedAt
        ? {
            requestedAt: u.deletionRequestedAt,
            purgeAt: u.deletionPurgeAt,
            requestedBy:
              u.deletionRequestedById === u.id
                ? ("self" as const)
                : u.managedProfileAt != null
                  ? ("guardian" as const)
                  : ("admin" as const),
          }
        : null,
    })),
  );
});
