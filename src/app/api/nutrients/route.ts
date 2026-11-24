/**
 * `GET /api/nutrients?days=N` — synced-nutrient window summary (v1.28).
 *
 * Feeds the read-only settings card (Settings → Sources): per nutrient
 * with data inside the window, the latest synced day + total and the
 * count of days carrying data — the smallest honest surface for "what
 * does the server hold". Catalog order, no pagination (one row per catalog
 * code at most).
 * Module-gated like the ingest path: 403 `module.disabled` when the
 * opt-in `nutrients` module is off. `userId` is narrowed from auth.
 *
 * `lastAttempt` (v1.34.3): non-null only when the window is empty AND the
 * most recent `nutrient.batch.ingest` audit row shows a call that landed
 * nothing, so `/insights/nutrients` can say a sync arrived and why instead
 * of a bare "no data yet". See the lookup below for the AuditLog-retention
 * coupling this introduces.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { readNutrientOverview } from "@/lib/nutrients/read";
import { nutrientOverviewQuerySchema } from "@/lib/validations/nutrients";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { ownRecord } from "@/lib/own-key";

export const dynamic = "force-dynamic";

/** Highest-count skip reason; ties break on this fixed declaration order. */
const SKIP_REASON_PRIORITY = [
  "unit_mismatch",
  "value_out_of_range",
  "day_invalid",
  "upsert_failed",
] as const;

interface LastIngestDetails {
  inserted: number;
  updated: number;
  skipped: number;
  skippedByReason: Record<string, number>;
}

/**
 * `AuditLog.details` is a free-form JSON string; parse it back into the
 * shape `nutrient.batch.ingest` (`src/app/api/nutrients/batch/route.ts`)
 * writes, rejecting anything that doesn't match rather than trusting the
 * blob.
 */
function parseLastIngestDetails(raw: string | null): LastIngestDetails | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const { inserted, updated, skipped } = obj;
  if (
    typeof inserted !== "number" ||
    typeof updated !== "number" ||
    typeof skipped !== "number"
  ) {
    return null;
  }
  const skippedByReason = ownRecord<number>();
  const rawByReason = obj.skippedByReason;
  if (rawByReason && typeof rawByReason === "object") {
    for (const [reason, count] of Object.entries(
      rawByReason as Record<string, unknown>,
    )) {
      if (typeof count === "number") skippedByReason[reason] = count;
    }
  }
  return { inserted, updated, skipped, skippedByReason };
}

function pickTopSkipReason(byReason: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const reason of SKIP_REASON_PRIORITY) {
    const count = byReason[reason] ?? 0;
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const gate = await requireModuleEnabled(user.id, "nutrients");
  if (!gate.enabled) return gate.response;

  const parsed = nutrientOverviewQuerySchema.safeParse({
    days: request.nextUrl.searchParams.get("days") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "nutrient.read.invalid",
    });
  }
  const { days } = parsed.data;

  // v1.30 (DATAINT L4) — window floor anchored on the caller's own local
  // "today" (`User.timezone`), mirroring the sibling `GET
  // /api/nutrients/daily` route. v1.43 — the fold (sum across sources, one
  // day counted once however many source rows it has) lives in
  // `readNutrientOverview`, which also keeps the latest day's split by source
  // and judges it against the upper intake level.
  const userTz = user.timezone || DEFAULT_TIMEZONE;
  const { nutrients, rowCount } = await readNutrientOverview(
    user.id,
    userTz,
    days,
  );

  // The account holder's only signal that a sync ever arrived is this
  // lookup — the read path stays honest instead of a bare "no data yet"
  // when a batch actually landed and every entry was rejected. Gated on
  // the zero-rows path ONLY: an AuditLog read must never run on the happy
  // path just to serve a read endpoint. COUPLING: this depends on the row
  // still existing — `cleanupOldAuditLogs` (`src/lib/jobs/audit-log-cleanup.ts`)
  // prunes AuditLog nightly past `AUDIT_LOG_RETENTION_DAYS` (365 days by
  // default), so a dormant account whose last failed attempt ages past
  // that window silently loses the explanation and falls back to the
  // plain empty state — anyone changing that retention job should know a
  // user-facing message depends on it.
  let lastAttempt: { at: string; topReason: string } | null = null;
  if (nutrients.length === 0) {
    // Fail soft, deliberately. This lookup exists only to explain an empty
    // page; it is not the page. If it throws — a ledger read that errors, a
    // shape nobody expected — the nutrients read must still answer, with the
    // plain empty state rather than a 500. An explanation that can take down
    // the thing it explains is worse than no explanation.
    try {
      const lastIngest = await prisma.auditLog.findFirst({
        where: { userId: user.id, action: "nutrient.batch.ingest" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, details: true },
      });
      const details = parseLastIngestDetails(lastIngest?.details ?? null);
      // Only surface a reason when the last attempt landed NOTHING: a
      // succeeded attempt whose day just falls outside this window is a
      // different, unrelated situation — showing a failure notice over it
      // would be the very false claim this feature exists to prevent.
      if (details && details.inserted === 0 && details.updated === 0) {
        const topReason = pickTopSkipReason(details.skippedByReason);
        if (topReason) {
          lastAttempt = { at: lastIngest!.createdAt.toISOString(), topReason };
        }
      }
    } catch (err) {
      // Recorded, never rendered: the operator sees it, the person sees the
      // ordinary empty state.
      annotate({
        action: { name: "nutrient.intake.last_attempt_lookup_failed" },
        meta: { reason: err instanceof Error ? err.name : "unknown" },
      });
    }
  }

  annotate({
    action: { name: "nutrient.intake.read" },
    meta: {
      window_days: days,
      nutrient_count: nutrients.length,
      row_count: rowCount,
    },
  });

  return apiSuccess({ windowDays: days, nutrients, lastAttempt });
});
