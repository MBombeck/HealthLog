/**
 * v1.4.40 SB-10 — AI consent receipts CRUD helper.
 *
 * Append-only audit trail. Every grant + revoke mints a fresh row;
 * no updates, no deletes outside of cascade-on-user-delete. The
 * `revokeLatest` helper writes the current row's `revokedAt` and
 * returns it — that single field flip is the only mutation the
 * helper performs. A subsequent re-grant inserts a new row, so the
 * historical chain stays intact for legal review.
 *
 * Source of truth for "is AI active right now?" is
 * `latestActiveReceipt(userId, kind)` returning non-null. Reader
 * routes never inspect older rows.
 */
import { prisma } from "@/lib/db";
import type { ConsentReceiptModel } from "@/generated/prisma/models/ConsentReceipt";
import type { ConsentKind } from "@/lib/validations/consent";

export type ConsentReceipt = ConsentReceiptModel;

/**
 * Insert a fresh consent receipt for (userId, kind). Always appends;
 * never collides with an earlier row. The caller has already
 * Zod-validated `artefact` (≤ 64 KB) and `signedAt` (ISO-8601).
 */
export async function createReceipt(
  userId: string,
  kind: ConsentKind,
  artefact: string,
  signedAt: Date,
): Promise<ConsentReceipt> {
  return prisma.consentReceipt.create({
    data: {
      userId,
      kind,
      artefact,
      signedAt,
    },
  });
}

/**
 * Return the most recent non-revoked receipt for (userId, kind), or
 * `null` if none exists. Ordering is by `createdAt DESC` — the same
 * index direction declared on the schema, so the planner walks the
 * compound index forward without a sort.
 *
 * "Non-revoked" = `revokedAt IS NULL`. A revoked row never resurrects;
 * a new grant must mint a new row.
 */
export async function latestActiveReceipt(
  userId: string,
  kind: ConsentKind,
): Promise<ConsentReceipt | null> {
  return prisma.consentReceipt.findFirst({
    where: { userId, kind, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Return the latest non-revoked receipt across every kind for the
 * user, keyed by kind. Used by `GET /api/consent/ai/latest` when the
 * caller omits the `?kind` query param.
 */
export async function latestActiveReceiptsByKind(
  userId: string,
): Promise<Partial<Record<ConsentKind, ConsentReceipt>>> {
  const rows = await prisma.consentReceipt.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  // First-wins reduce over `createdAt DESC`. `findMany` returns every
  // historical grant for the user; we keep the freshest per kind.
  const out: Partial<Record<ConsentKind, ConsentReceipt>> = {};
  for (const r of rows) {
    const k = r.kind as ConsentKind;
    if (!(k in out)) out[k] = r;
  }
  return out;
}

/**
 * Mark the latest active receipt for (userId, kind) as revoked.
 * Returns the updated row, or `null` if no active receipt exists.
 *
 * Implementation note: a two-step "read latest → update by id" is
 * race-tolerant for the single-user revoke flow (iOS toggle is a
 * per-device action; no concurrent revoke from a second device is
 * plausible inside the same millisecond). If two devices race we end
 * up writing `revokedAt` to the same row twice with identical
 * timestamps — semantically idempotent.
 */
export async function revokeLatest(
  userId: string,
  kind: ConsentKind,
  now: Date = new Date(),
): Promise<ConsentReceipt | null> {
  const latest = await latestActiveReceipt(userId, kind);
  if (!latest) return null;
  return prisma.consentReceipt.update({
    where: { id: latest.id },
    data: { revokedAt: now },
  });
}
