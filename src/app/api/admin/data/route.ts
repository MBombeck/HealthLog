import { prisma } from "@/lib/db";
import {
  apiHandler,
  requireAdmin,
  assertRecentCookieProof,
} from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { invalidateAllCaches } from "@/lib/cache/invalidate";
import {
  ADMIN_WIPE_MODELS,
  USER_RESET,
  wipeDelegateKey,
  WIPE_TRANSACTION_MAX_WAIT_MS,
  WIPE_TRANSACTION_TIMEOUT_MS,
} from "@/lib/data-wipe/wipe-plan";
import { resolveGlobalWipeDelegate } from "@/lib/data-wipe/wipe-delegates";

export const dynamic = "force-dynamic";

/**
 * Admin-only global wipe of every account's data.
 * Keeps users/passkeys so access to the app remains possible.
 *
 * The set of tables is not written here. It is declared once in
 * `@/lib/data-wipe/wipe-plan` — the same declaration the per-account wipe
 * reads — and held against `prisma/schema.prisma` by
 * `src/__tests__/data-wipe-completeness.test.ts` plus its admin-scope sibling,
 * so a model added to the schema cannot quietly land outside this wipe. It had
 * done exactly that: the inline list this route used to carry named nine
 * tables, written when nine was most of the schema, and stayed at nine while
 * the schema grew past a hundred. Laboratory results, documents, cycle logs,
 * journals, mood, workouts, sleep and Coach conversations all survived the
 * wipe an operator runs before handing the box on.
 *
 * `ADMIN_WIPE_MODELS` is `WIPE_MODELS` minus the entries in
 * `ADMIN_WIPE_EXEMPT`, and every survivor — sign-in credentials, instance
 * configuration, the delegation grants that keep managed profiles reachable —
 * carries its reason in that file.
 */
export const DELETE = apiHandler(async (request: NextRequest) => {
  const ip = getClientIp(request);
  const rl = await checkRateLimit(`admin-data-delete:${ip}`, 5, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  const { user, session } = await requireAdmin();
  // A fresh proof on top of the admin session: this reaches every account's
  // data, so a stolen admin session alone must not be enough.
  await assertRecentCookieProof(user, session.id);
  annotate({ action: { name: "admin.data.delete" } });

  // v1.18.1 — the documented convention buckets authenticated admin
  // mutations on `userId`, not the (pre-auth, spoofable) client IP. The
  // IP bucket above is the anonymous first-line throttle; this is the
  // canonical per-admin bucket the rate-limit contract specifies.
  const userRl = await checkRateLimit(
    `admin-data-delete:${user.id}`,
    5,
    60 * 1000,
  );
  if (!userRl.allowed) {
    return NextResponse.json(
      { data: null, error: "Rate limit exceeded" },
      { status: 429, headers: rateLimitHeaders(userRl) },
    );
  }

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

  if (confirm !== "DELETE ALL") {
    return apiError("Confirmation missing", 422);
  }

  // Audit-log the *intent* before the transaction begins so the trail
  // describing "an admin is about to wipe data" survives a crash midway or a
  // rollback. On success the transaction takes this row with the rest of the
  // history — an audit trail is a record of who did what from where, which is
  // exactly the personal data an operator clearing a box means to remove — and
  // the receipt written after the commit replaces it.
  await auditLog("admin.data.clear.start", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { confirm: "DELETE ALL" },
  });

  const counts = await prisma.$transaction(
    async (tx) => {
      const perModel: Record<string, number> = {};
      for (const model of ADMIN_WIPE_MODELS) {
        const { count } = await resolveGlobalWipeDelegate(tx, model).deleteMany(
          {},
        );
        if (count > 0) perModel[wipeDelegateKey(model)] = count;
      }

      // Every account row survives; the personal data carried on its own
      // columns does not. Same classification contract as the model list.
      // Paired clients drop their delta cursors and start over, instead of
      // catching up from a position whose rows are gone (`syncResetAt`).
      await tx.user.updateMany({
        data: { ...USER_RESET, syncResetAt: new Date() },
      });

      return perModel;
    },
    {
      timeout: WIPE_TRANSACTION_TIMEOUT_MS,
      maxWait: WIPE_TRANSACTION_MAX_WAIT_MS,
    },
  );

  const deletedRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

  // Written after the transaction commits, so the row cannot be removed by the
  // AuditLog delete inside it. The instance's whole audit history goes; this
  // one row stays as the receipt for the erasure the operator asked for.
  await auditLog("admin.data.clear", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { deletedRows, models: counts },
  });

  annotate({
    meta: {
      deleted_rows: deletedRows,
      models_wiped: ADMIN_WIPE_MODELS.length,
      models_with_rows: Object.keys(counts).length,
    },
  });

  // v1.16.9 — the wipe touched every user's rows; clear every cache
  // bucket so no per-user payload survives the reset.
  invalidateAllCaches();

  return apiSuccess({ cleared: true, deletedRows, models: counts });
});
