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
import { toCSV, type ExportableRecord } from "@/lib/export";
import {
  formatMeasurementPageChunks,
  iterateMeasurementPages,
} from "@/lib/export/paged-measurements";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { resolveGlucoseUnit } from "@/lib/glucose";
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
  const granularity =
    new URL(request.url).searchParams.get("granularity") === "raw"
      ? "raw"
      : "night";
  await auditLog("user.export.measurements", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      outcome: "attempted",
      since: since?.toISOString() ?? null,
      until: until?.toISOString() ?? null,
    },
  });
  annotate({
    meta: {
      export_outcome: "attempted",
      export_since: since?.toISOString() ?? null,
      export_until: until?.toISOString() ?? null,
    },
  });
  const pageIterator = iterateMeasurementPages(prisma, where, {
    id: true,
    type: true,
    value: true,
    unit: true,
    measuredAt: true,
    source: true,
    notes: true,
    notesEncrypted: true,
    glucoseContext: true,
    sleepStage: true,
    deviceType: true,
  })[Symbol.asyncIterator]();

  // Prime one bounded page before sending headers. Authentication, metadata,
  // and first-query failures therefore keep the historical API error
  // behaviour; later pages are pulled only as the client consumes the body.
  const [firstPage, userTz, sourcePriorityJson, profile] = await Promise.all([
    pageIterator.next(),
    resolveUserTimezone(user.id),
    loadUserSourcePriority(user.id),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { glucoseUnit: true },
    }),
  ]).catch(async (error: unknown) => {
    await pageIterator.return?.();
    throw error;
  });
  const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
  const pages = prefetchedPages(pageIterator, firstPage);
  const recordChunks = formatMeasurementPageChunks(pages, userTz, {
    granularity,
    sourcePriorityJson,
    glucoseUnit,
  });
  const body = streamText(csvChunks(recordChunks));

  return csvResponse(body, `healthlog-measurements-${user.id}`);
});

async function* prefetchedPages<T>(
  iterator: AsyncIterator<T[]>,
  first: IteratorResult<T[]>,
): AsyncGenerator<readonly T[], void, void> {
  try {
    let next = first;
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}

async function* csvChunks(
  chunks: AsyncIterable<ExportableRecord[]>,
): AsyncGenerator<string, void, void> {
  let wroteHeader = false;
  for await (const records of chunks) {
    const csv = toCSV(records);
    if (csv.length === 0) continue;
    if (!wroteHeader) {
      wroteHeader = true;
      yield csv;
      continue;
    }
    const headerEnd = csv.indexOf("\n");
    if (headerEnd >= 0 && headerEnd + 1 < csv.length) {
      yield `\n${csv.slice(headerEnd + 1)}`;
    }
  }
}

function streamText(chunks: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

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

function csvResponse(
  body: ReadableStream<Uint8Array>,
  prefix: string,
): NextResponse {
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
