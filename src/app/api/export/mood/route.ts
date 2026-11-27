/**
 * GET /api/export/mood
 *
 * v1.4.16. Per-type CSV download for the consolidated
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
import { shapeMoodNote } from "@/lib/crypto/note-cipher";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { parseExportRange } from "@/lib/export/export-range";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.mood" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const userTz = await resolveUserTimezone(user.id);
  const range = parseExportRange(new URL(request.url).searchParams, userTz);
  const where = range
    ? // v1.7.0 sync — exclude tombstoned rows from the export.
      { userId: user.id, deletedAt: null, moodLoggedAt: range }
    : { userId: user.id, deletedAt: null };

  const entries = await prisma.moodEntry.findMany({
    where,
    orderBy: { moodLoggedAt: "desc" },
  });

  const csv = toCSV(
    formatMoodEntriesForExport(entries.map(shapeMoodNote), userTz),
  );

  await auditLog("user.export.mood", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      count: entries.length,
      since: range?.gte?.toISOString() ?? null,
      until: (range?.lt ?? range?.lte)?.toISOString() ?? null,
    },
  });

  annotate({
    meta: {
      export_count: entries.length,
    },
  });

  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: file name stamp, not a day shown or compared
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
