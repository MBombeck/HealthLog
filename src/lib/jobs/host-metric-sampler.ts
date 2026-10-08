/**
 * Host-load sampler (every five minutes since v1.42) that backs the admin /admin/system-status
 * "last 2 hours" chart (v1.4.16 phase B3).
 *
 * The maintainer asked for a small at-a-glance graph above the system-status facts
 * grid showing CPU + memory + disk-IO so a glance at /admin tells them
 * whether the apps-01 host is healthy. We considered scraping Coolify's
 * Sentinel collector, but the Coolify HTTP API does not expose a clean
 * read endpoint for per-server metrics — every approach ended up either
 * scraping the Coolify dashboard HTML or hitting a private RPC. An
 * in-process sampler costs us a single 7-column row per tick, never
 * leaves the app's own DB, and works identically on dev (macOS) and
 * production (Linux).
 *
 * The sampler uses `os.loadavg()` (1/5/15-minute averages) and
 * `os.totalmem() - os.freemem()` for memory. On Linux it also reads the
 * cumulative /proc/diskstats counters; non-Linux hosts return null disk
 * fields, which the API endpoint then surfaces as "no disk data" instead
 * of failing the whole chart.
 *
 * Retention: rows older than 7 days are deleted at the end of every
 * tick. With one insert every five minutes that's 2,016 rows steady-state,
 * indexed by `captured_at` so the 2h query stays under 30 rows.
 */
import { loadavg, totalmem, freemem } from "node:os";
import { readFile } from "node:fs/promises";
import type { PrismaClient } from "@/generated/prisma/client";

export const DEFAULT_HOST_METRIC_RETENTION_DAYS = 7;

export interface HostMetricSample {
  loadAvg1: number;
  loadAvg5: number;
  loadAvg15: number;
  memUsedBytes: bigint;
  memTotalBytes: bigint;
  diskReadBytes: bigint | null;
  diskWriteBytes: bigint | null;
}

/**
 * Capture a single host-load snapshot. Pure-ish — only `os.*` and
 * `/proc/diskstats` are touched, so the unit test can stub
 * `readDiskStats` to assert the disk path without mocking `node:os`.
 */
export async function captureHostMetric(
  readDiskStats: () => Promise<{
    readBytes: bigint;
    writeBytes: bigint;
  } | null> = readLinuxDiskStats,
): Promise<HostMetricSample> {
  const [load1, load5, load15] = loadavg();
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const disk = await readDiskStats().catch(() => null);

  return {
    loadAvg1: round(load1),
    loadAvg5: round(load5),
    loadAvg15: round(load15),
    memUsedBytes: BigInt(used),
    memTotalBytes: BigInt(total),
    diskReadBytes: disk?.readBytes ?? null,
    diskWriteBytes: disk?.writeBytes ?? null,
  };
}

/**
 * Linux /proc/diskstats reader. Returns the sum of read + write byte
 * counters across all non-virtual block devices (loop/ram/dm-* are
 * excluded — they double-count or report meaningless numbers).
 *
 * Each /proc/diskstats line is whitespace-separated:
 *   3:major  4:minor  ...  6:sectors_read  ...  10:sectors_written  ...
 * Multiplying sectors by the canonical 512 B sector size gives the
 * cumulative byte counters the chart uses to derive bytes-per-second
 * between samples.
 */
async function readLinuxDiskStats(): Promise<{
  readBytes: bigint;
  writeBytes: bigint;
} | null> {
  let raw: string;
  try {
    raw = await readFile("/proc/diskstats", "utf-8");
  } catch {
    return null;
  }

  let totalRead = BigInt(0);
  let totalWrite = BigInt(0);
  const SECTOR_BYTES = BigInt(512);

  for (const line of raw.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;
    const device = parts[2];
    // Skip virtual / synthetic devices that double-count or report
    // bogus numbers. ram*/loop* are pseudo-devices; dm-* and md* are
    // device-mapper / RAID overlays whose underlying disks are already
    // counted by the physical device line.
    if (
      !device ||
      /^(loop|ram|dm-|md|sr|fd)/.test(device) ||
      /^(nbd|zram)/.test(device)
    ) {
      continue;
    }

    const sectorsRead = BigInt(parts[5] ?? "0");
    const sectorsWritten = BigInt(parts[9] ?? "0");
    totalRead += sectorsRead * SECTOR_BYTES;
    totalWrite += sectorsWritten * SECTOR_BYTES;
  }

  return { readBytes: totalRead, writeBytes: totalWrite };
}

export function getHostMetricRetentionDays(): number {
  const raw = process.env.HOST_METRIC_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_HOST_METRIC_RETENTION_DAYS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HOST_METRIC_RETENTION_DAYS;
  }
  // Refuse a misconfigured value below 1 day — the chart needs at least
  // 2h of data, but cron drift + missed ticks make 1d the safe floor.
  if (parsed < 1) return DEFAULT_HOST_METRIC_RETENTION_DAYS;
  return parsed;
}

/**
 * Insert a single sample row + delete expired rows. Returns the number
 * of rows pruned so the worker can annotate its Wide Event.
 */
export async function runHostMetricTick(
  prisma: PrismaClient,
  options: {
    now?: Date;
    captureFn?: () => Promise<HostMetricSample>;
  } = {},
): Promise<{ inserted: 1; pruned: number }> {
  const now = options.now ?? new Date();
  const sample = await (options.captureFn ?? (() => captureHostMetric()))();

  await prisma.hostMetric.create({
    data: {
      capturedAt: now,
      loadAvg1: sample.loadAvg1,
      loadAvg5: sample.loadAvg5,
      loadAvg15: sample.loadAvg15,
      memUsedBytes: sample.memUsedBytes,
      memTotalBytes: sample.memTotalBytes,
      diskReadBytes: sample.diskReadBytes,
      diskWriteBytes: sample.diskWriteBytes,
    },
  });

  const cutoff = new Date(
    now.getTime() - getHostMetricRetentionDays() * 86_400_000,
  );
  const { count } = await prisma.hostMetric.deleteMany({
    where: { capturedAt: { lt: cutoff } },
  });

  return { inserted: 1, pruned: count };
}

function round(value: number): number {
  // 2-decimal precision is enough for a chart whose y-axis spans 0–4
  // load — and it keeps Postgres `DOUBLE PRECISION` rows compact.
  return Math.round(value * 100) / 100;
}
