/**
 * v1.4.40 SB-10 — AI consent latest-receipt reader + revoke endpoint.
 *
 *   GET /api/consent/ai/latest?kind=ai_full
 *     Returns the latest non-revoked receipt for that kind, or null.
 *
 *   GET /api/consent/ai/latest
 *     Returns the latest non-revoked receipt per kind, keyed by kind.
 *
 *   DELETE /api/consent/ai/latest?kind=ai_full
 *     Marks the latest active receipt for that kind as revoked.
 *
 *   DELETE /api/consent/ai/latest
 *     Master toggle — revokes the latest active receipt across every
 *     consent kind. Returns the list of revoked rows.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  returnAllZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  consentKindEnum,
  consentLatestQuery,
  type ConsentKind,
} from "@/lib/validations/consent";
import {
  latestActiveReceipt,
  latestActiveReceiptsByKind,
  revokeLatest,
} from "@/lib/consent/receipts";
import { serialiseReceipt } from "../route";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = consentLatestQuery.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 400 (consent routes use 400 not 422).
    return returnAllZodIssues(parsed.error, 400);
  }

  const { kind } = parsed.data;

  if (kind) {
    const receipt = await latestActiveReceipt(user.id, kind);
    annotate({
      action: { name: "consent.ai.latest" },
      meta: { kind, found: receipt != null },
    });
    return apiSuccess({
      kind,
      receipt: receipt ? serialiseReceipt(receipt) : null,
    });
  }

  const byKind = await latestActiveReceiptsByKind(user.id);
  // Map each enum value to either the serialised row or `null` so the
  // client always sees the full keyspace and never has to guess
  // whether a missing key means "not granted" or "schema gap".
  const result: Record<ConsentKind, ReturnType<typeof serialiseReceipt> | null> = {
    ai_full: byKind.ai_full ? serialiseReceipt(byKind.ai_full) : null,
    ai_insights_only: byKind.ai_insights_only
      ? serialiseReceipt(byKind.ai_insights_only)
      : null,
    ai_coach: byKind.ai_coach ? serialiseReceipt(byKind.ai_coach) : null,
  };

  annotate({
    action: { name: "consent.ai.latest" },
    meta: {
      kinds_active: Object.entries(result)
        .filter(([, v]) => v != null)
        .map(([k]) => k),
    },
  });

  return apiSuccess(result);
});

export const DELETE = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const parsed = consentLatestQuery.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // v1.4.43 W6 — multi-issue 400 (consent routes use 400 not 422).
    return returnAllZodIssues(parsed.error, 400);
  }

  const { kind } = parsed.data;

  if (kind) {
    const revoked = await revokeLatest(user.id, kind);
    if (!revoked) {
      // Idempotent: "no active receipt to revoke" is success-shaped.
      // The iOS toggle hammers this on every flip; returning 404
      // would surface as a spurious error in the client.
      annotate({
        action: { name: "consent.ai.revoke" },
        meta: { kind, revoked: false },
      });
      return apiSuccess({ kind, receipt: null });
    }
    auditLog("consent.ai.revoke", {
      userId: user.id,
      details: { kind, receiptId: revoked.id },
    }).catch(() => {});
    annotate({
      action: { name: "consent.ai.revoke" },
      meta: { kind, receiptId: revoked.id },
    });
    return apiSuccess({ kind, receipt: serialiseReceipt(revoked) });
  }

  // No kind specified — master "AI deaktivieren" toggle. Revoke the
  // latest active row for every kind that currently has one.
  const revokedRows: Array<{
    kind: ConsentKind;
    receipt: ReturnType<typeof serialiseReceipt>;
  }> = [];
  for (const k of consentKindEnum.options) {
    const r = await revokeLatest(user.id, k);
    if (r) {
      revokedRows.push({ kind: k, receipt: serialiseReceipt(r) });
      auditLog("consent.ai.revoke", {
        userId: user.id,
        details: { kind: k, receiptId: r.id },
      }).catch(() => {});
    }
  }

  annotate({
    action: { name: "consent.ai.revoke" },
    meta: {
      kinds_revoked: revokedRows.map((r) => r.kind),
      count: revokedRows.length,
    },
  });

  return apiSuccess({ revoked: revokedRows });
});
