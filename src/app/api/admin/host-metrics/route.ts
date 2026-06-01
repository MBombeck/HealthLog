import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { NextRequest } from "next/server";
import { z } from "zod/v4";

/**
 * v1.4.16 phase B3: serve the host-load chart that sits above
 * `/admin/system-status`. The pg-boss `host-metric-sample` worker writes
 * one row per minute; this endpoint returns the last `?since=` window
 * (default 2h, max 24h) ordered by `capturedAt` ascending so the chart
 * can render without a client-side sort.
 *
 * Response shape (per row):
 *   - capturedAt          ISO-8601
 *   - loadAvg1            number — Linux-style 1-minute load average
 *   - memUsedPercent      number 0..100, derived from raw bytes
 *   - diskReadBps         number | null — bytes-per-second since the
 *                         previous sample. Null on the first row, on
 *                         non-Linux hosts, or when the previous sample
 *                         had no disk counter (the chart hides the line
 *                         until enough samples accumulate).
 *   - diskWriteBps        number | null
 *
 * Computing the BPS server-side keeps the chart component stateless and
 * makes every consumer (admin UI today, hypothetical CLI later) get the
 * same units. requireAdmin() gates this endpoint — host-load is admin-
 * only telemetry, no Bearer-token surface.
 */

const SINCE_PRESETS = ["30m", "1h", "2h", "6h", "12h", "24h"] as const;

const querySchema = z.object({
  since: z.enum(SINCE_PRESETS).default("2h"),
});

function presetToMs(preset: (typeof SINCE_PRESETS)[number]): number {
  switch (preset) {
    case "30m":
      return 30 * 60_000;
    case "1h":
      return 60 * 60_000;
    case "2h":
      return 2 * 60 * 60_000;
    case "6h":
      return 6 * 60 * 60_000;
    case "12h":
      return 12 * 60 * 60_000;
    case "24h":
      return 24 * 60 * 60_000;
  }
}

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAdmin();
  annotate({ action: { name: "admin.host-metrics.list" } });

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.parse({
    since: searchParams.get("since") ?? undefined,
  });

  const sinceMs = presetToMs(parsed.since);
  const cutoff = new Date(Date.now() - sinceMs);

  const rows = await prisma.hostMetric.findMany({
    where: { capturedAt: { gte: cutoff } },
    orderBy: { capturedAt: "asc" },
    select: {
      capturedAt: true,
      loadAvg1: true,
      memUsedBytes: true,
      memTotalBytes: true,
      diskReadBytes: true,
      diskWriteBytes: true,
    },
  });

  // Convert raw cumulative byte counters into per-second deltas. The
  // chart renders bytes-per-second so the y-axis stays comparable
  // regardless of sampling cadence.
  let prevReadBytes: bigint | null = null;
  let prevWriteBytes: bigint | null = null;
  let prevAt: Date | null = null;

  const samples = rows.map((row) => {
    const memTotal = Number(row.memTotalBytes);
    const memUsed = Number(row.memUsedBytes);
    const memUsedPercent =
      memTotal > 0 ? Math.max(0, Math.min(100, (memUsed / memTotal) * 100)) : 0;

    let diskReadBps: number | null = null;
    let diskWriteBps: number | null = null;

    if (
      row.diskReadBytes !== null &&
      row.diskWriteBytes !== null &&
      prevReadBytes !== null &&
      prevWriteBytes !== null &&
      prevAt !== null
    ) {
      const elapsedSec = (row.capturedAt.getTime() - prevAt.getTime()) / 1000;
      if (elapsedSec > 0) {
        const readDelta = row.diskReadBytes - prevReadBytes;
        const writeDelta = row.diskWriteBytes - prevWriteBytes;
        // Counters can reset (host reboot) — don't surface a negative
        // BPS, just hide the row's disk values.
        if (readDelta >= BigInt(0)) {
          diskReadBps = Number(readDelta) / elapsedSec;
        }
        if (writeDelta >= BigInt(0)) {
          diskWriteBps = Number(writeDelta) / elapsedSec;
        }
      }
    }

    prevReadBytes = row.diskReadBytes;
    prevWriteBytes = row.diskWriteBytes;
    prevAt = row.capturedAt;

    return {
      capturedAt: row.capturedAt.toISOString(),
      loadAvg1: row.loadAvg1,
      memUsedPercent: Math.round(memUsedPercent * 100) / 100,
      diskReadBps: diskReadBps !== null ? Math.round(diskReadBps) : null,
      diskWriteBps: diskWriteBps !== null ? Math.round(diskWriteBps) : null,
    };
  });

  return apiSuccess({
    samples,
    meta: {
      since: parsed.since,
      count: samples.length,
      // Memory total in bytes feeds the tooltip's absolute label
      // ("X.X / Y.Y GiB") so the percentage isn't read in a vacuum.
      // Latest row wins; falls back to 0 on empty.
      memTotalBytes: rows.length
        ? Number(rows[rows.length - 1].memTotalBytes)
        : 0,
    },
  });
});
