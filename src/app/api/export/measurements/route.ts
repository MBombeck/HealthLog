/**
 * GET /api/export/measurements
 *
 * v1.4.16 phase B7. Per-type CSV download for the consolidated
 * `/settings/export` UI. Filterable by `since` / `until` (inclusive
 * date strings parsed via the standard Date constructor — invalid
 * values are silently dropped from the where-clause).
 *
 * Response is `text/csv` with an attachment filename ending in `.csv`,
 * so the browser writes a `.csv` file even though the route segment
 * itself doesn't carry the extension (Next.js + vitest can't resolve
 * dotted route segments cleanly — see commit log for context).
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h) so the user can't
 *   sidestep the global cap by hitting per-type endpoints in parallel.
 * Audit: `user.export.measurements` with the resolved filter.
 */
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { toCSV, formatMeasurementsForExport } from "@/lib/export";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { NextRequest, NextResponse } from "next/server";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.export.measurements" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const { since, until } = parseRange(request.url);
  const where = buildWhere(user.id, { since, until });

  const [measurements, userTz] = await Promise.all([
    prisma.measurement.findMany({
      where,
      orderBy: { measuredAt: "desc" },
    }),
    resolveUserTimezone(user.id),
  ]);

  const csv = toCSV(formatMeasurementsForExport(measurements, userTz));

  await auditLog("user.export.measurements", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      count: measurements.length,
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    },
  });

  annotate({
    meta: {
      export_count: measurements.length,
      export_since: since?.toISOString() ?? null,
      export_until: until?.toISOString() ?? null,
    },
  });

  return csvResponse(csv, `healthlog-measurements-${user.id}`);
});

function parseRange(url: string): {
  since: Date | undefined;
  until: Date | undefined;
} {
  const params = new URL(url).searchParams;
  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");
  const since = sinceRaw ? safeDate(sinceRaw) : undefined;
  const until = untilRaw ? safeDate(untilRaw) : undefined;
  return { since, until };
}

function safeDate(value: string): Date | undefined {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function buildWhere(
  userId: string,
  range: { since?: Date; until?: Date },
): {
  userId: string;
  deletedAt: null;
  measuredAt?: { gte?: Date; lte?: Date };
} {
  // v1.4.41 W-DELETED-2 — soft-deleted measurements stay out of every
  // per-type CSV download so an undo or pending-sync row never reaches
  // the user's local file.
  const where: {
    userId: string;
    deletedAt: null;
    measuredAt?: { gte?: Date; lte?: Date };
  } = {
    userId,
    deletedAt: null,
  };
  if (range.since || range.until) {
    where.measuredAt = {};
    if (range.since) where.measuredAt.gte = range.since;
    if (range.until) where.measuredAt.lte = range.until;
  }
  return where;
}

function csvResponse(body: string, prefix: string): NextResponse {
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${prefix}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
