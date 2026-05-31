/**
 * GET /api/export/mood
 *
 * v1.4.16 phase B7. Per-type CSV download for the consolidated
 * `/settings/export` UI. Filterable by `since` / `until` (inclusive
 * date strings parsed via the standard Date constructor — invalid
 * values are silently dropped from the where-clause).
 *
 * Response is `text/csv` with an attachment filename ending in `.csv`.
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h).
 * Audit: `user.export.mood` with the resolved filter.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { toCSV, formatMoodEntriesForExport } from "@/lib/export";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.mood" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const params = new URL(request.url).searchParams;
  const since = params.get("since")
    ? safeDate(params.get("since")!)
    : undefined;
  const until = params.get("until")
    ? safeDate(params.get("until")!)
    : undefined;

  const where: {
    userId: string;
    deletedAt: null;
    moodLoggedAt?: { gte?: Date; lte?: Date };
  } = {
    userId: user.id,
    // v1.7.0 sync — exclude tombstoned rows from the export.
    deletedAt: null,
  };
  if (since || until) {
    where.moodLoggedAt = {};
    if (since) where.moodLoggedAt.gte = since;
    if (until) where.moodLoggedAt.lte = until;
  }

  const [entries, userTz] = await Promise.all([
    prisma.moodEntry.findMany({
      where,
      orderBy: { moodLoggedAt: "desc" },
    }),
    resolveUserTimezone(user.id),
  ]);

  const csv = toCSV(formatMoodEntriesForExport(entries, userTz));

  await auditLog("user.export.mood", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      count: entries.length,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    },
  });

  annotate({
    meta: {
      export_count: entries.length,
    },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="healthlog-mood-${user.id}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});

function safeDate(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
