/**
 * (issue #775) — bounded-memory regression proof for the Apple Health
 * import. A self-hoster's 238 MB export.zip with ~11 million records
 * exhausted the default 1 GB Node heap: the cumulative fold hashed the
 * raw `device` attribute (which embeds a volatile HKDevice runtime
 * address) into its per-day source buckets, fragmenting the map toward
 * one entry per record, and the extractor buffered the whole archive.
 *
 * This suite generates a synthetic archive on the fly — hundreds of
 * thousands of records streamed into a temp ZIP, never checked in and
 * never held in memory whole — and pushes it through the REAL pipeline
 * (extractExportXml → streamParseExportXml), sampling
 * `process.memoryUsage().heapUsed` throughout. The heap-growth bound it
 * asserts is a small fraction of the archive's decompressed size; both
 * historical failure modes (unbatched row accumulation, per-record
 * source buckets) blow past it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  createWriteStream,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Writable } from "node:stream";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// Plain async stubs, deliberately NOT vi.fn(): a vi.fn() retains every
// call's arguments, and the arrival emitter receives every inserted row
// — the harness itself would hold hundreds of thousands of rows live
// and drown the very measurement this test exists to take.
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: async () => undefined,
}));

vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: async () => undefined,
}));

// The spot flush writes through one raw `INSERT … ON CONFLICT DO NOTHING
// RETURNING` statement. These fakes model the table in memory, so route that
// statement to the fake's own skip-duplicates insert; the SQL itself is pinned
// against a real Postgres in tests/integration/measurement-bulk-insert.test.ts.
vi.mock("@/lib/export/measurement-bulk-insert", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/export/measurement-bulk-insert")
  >()),
  insertNewMeasurementRows: (
    db: { measurement: { createManyAndReturn: (args: unknown) => unknown } },
    rows: unknown[],
  ) =>
    db.measurement.createManyAndReturn({
      data: rows,
      skipDuplicates: true,
      select: { id: true, type: true, measuredAt: true, externalId: true },
    }),
}));

vi.mock("@/lib/arrivals/emit-shared", () => ({
  emitDataArrival: async () => undefined,
}));

import type { PrismaClient } from "@/generated/prisma/client";
import { extractExportXml } from "@/lib/import/unzip-export-xml";
import { streamParseExportXml } from "../import-apple-health-export";

/** Record volume — large enough that unbounded accumulation is obvious. */
const STEP_RECORDS = 500_000;
const SPOT_RECORDS = 200_000;
const TOTAL_RECORDS = STEP_RECORDS + SPOT_RECORDS;
/** Distinct local days the cumulative records spread across. */
const STEP_DAYS = 700;

/**
 * Heap-growth ceiling for the whole run. The decompressed fixture is
 * several times this bound (asserted below), so the parse provably does
 * not scale its heap with the data volume. Both watched failure modes
 * exceed it: 700k unflushed prepared rows and 500k fragmented source
 * buckets each retain well over this amount.
 */
const MAX_HEAP_GROWTH_BYTES = 48 * 1024 * 1024;

/** The fixture must dwarf the heap bound for the assertion to mean much. */
const MIN_XML_BYTES = 2 * MAX_HEAP_GROWTH_BYTES;

/**
 * The heap samples must measure LIVE state, not garbage a lazy major GC
 * has not collected yet — the test runner's multi-GB heap lets V8 defer
 * collection long enough to drown the signal in transient allocations.
 * Vitest does not run with `--expose-gc`, so obtain a `gc()` handle via
 * the documented late-flag route and collect before measuring.
 */
setFlagsFromString("--expose-gc");
const forceGc: () => void = runInNewContext("gc");
setFlagsFromString("--no-expose-gc");

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Apple's export timestamp format: `YYYY-MM-DD HH:MM:SS +0100`. */
function appleDate(dayIndex: number, secondOfDay: number): string {
  const base = Date.UTC(2020, 0, 1) + dayIndex * 86_400_000;
  const d = new Date(base + secondOfDay * 1000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)} ` +
    `${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)} +0000`
  );
}

async function writeChunk(stream: Writable, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, "drain");
  }
}

/**
 * Stream a synthetic `export.xml` to disk. Cumulative step records carry
 * a fresh HKDevice runtime address per record — exactly what Apple's
 * export writer produces and what fragmented the source buckets before
 * the fix. Spot body-mass rows interleave so the spot batch flush path
 * runs continuously.
 */
async function writeSyntheticExportXml(xmlPath: string): Promise<void> {
  const stream = createWriteStream(xmlPath);
  await writeChunk(
    stream,
    `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n` +
      ` <ExportDate value="${appleDate(STEP_DAYS, 0)}"/>\n`,
  );

  let steps = 0;
  let spots = 0;
  let buffer: string[] = [];
  for (let i = 0; i < TOTAL_RECORDS; i += 1) {
    // Interleave 5 cumulative records for every 2 spot records.
    const wantStep = i % 7 < 5 && steps < STEP_RECORDS;
    if (wantStep || spots >= SPOT_RECORDS) {
      const day = steps % STEP_DAYS;
      const second = 21_600 + (steps % 43_200);
      const start = appleDate(day, second);
      const end = appleDate(day, second + 60);
      // A unique runtime address per record, as Apple serialises it.
      const device =
        `&lt;&lt;HKDevice: 0x${(0x280000000 + steps).toString(16)}&gt;, ` +
        `name:iPhone, manufacturer:Apple Inc., model:iPhone, ` +
        `hardware:iPhone14,2, software:17.4&gt;`;
      buffer.push(
        `<Record type="HKQuantityTypeIdentifierStepCount" unit="count"` +
          ` startDate="${start}" endDate="${end}" value="${20 + (steps % 80)}"` +
          ` sourceName="iPhone" sourceVersion="17.4" device="${device}"/>\n`,
      );
      steps += 1;
    } else {
      const day = spots % STEP_DAYS;
      const second = spots % 86_340;
      const start = appleDate(day, second);
      const end = appleDate(day, second + 30);
      buffer.push(
        `<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg"` +
          ` startDate="${start}" endDate="${end}"` +
          ` value="${(60 + (spots % 300) / 10).toFixed(1)}"` +
          ` sourceName="Scale" sourceVersion="2.1"/>\n`,
      );
      spots += 1;
    }
    if (buffer.length >= 2_000) {
      await writeChunk(stream, buffer.join(""));
      buffer = [];
    }
  }
  if (buffer.length > 0) await writeChunk(stream, buffer.join(""));
  await writeChunk(stream, `</HealthData>\n`);
  stream.end();
  await once(stream, "finish");
}

/**
 * Wrap an on-disk file into a single-member STORED (method 0) ZIP by
 * streaming the payload — the archive is never buffered whole. The
 * extractor does not verify CRC-32, so the fixture writes 0 there.
 */
async function wrapFileInStoredZip(
  payloadPath: string,
  zipPath: string,
  memberName: string,
): Promise<void> {
  const payloadBytes = statSync(payloadPath).size;
  const nameBuf = Buffer.from(memberName, "utf8");

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8); // method 0 = stored
  localHeader.writeUInt32LE(0, 14); // crc32 — not verified by the extractor
  localHeader.writeUInt32LE(payloadBytes, 18);
  localHeader.writeUInt32LE(payloadBytes, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0, 10); // method 0
  cdh.writeUInt32LE(0, 16); // crc32
  cdh.writeUInt32LE(payloadBytes, 20);
  cdh.writeUInt32LE(payloadBytes, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42); // local header offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + payloadBytes, 16);

  const out = createWriteStream(zipPath);
  out.write(localHeader);
  out.write(nameBuf);
  const payload = await open(payloadPath, "r");
  try {
    for await (const chunk of payload.createReadStream()) {
      if (!out.write(chunk)) await once(out, "drain");
    }
  } finally {
    // createReadStream closes the handle on end.
  }
  out.write(cdh);
  out.write(nameBuf);
  out.write(eocd);
  out.end();
  await once(out, "finish");
}

/**
 * Discarding Prisma stand-in: counts writes, retains nothing, so any
 * heap growth the sampler sees belongs to the pipeline under test.
 */
function makeDiscardingPrisma(sample: () => void) {
  let nextId = 1;
  let measurementInserts = 0;
  let workoutInserts = 0;
  let cumulativeCreates = 0;

  const fake = {
    counters: {
      get measurementInserts() {
        return measurementInserts;
      },
      get workoutInserts() {
        return workoutInserts;
      },
      get cumulativeCreates() {
        return cumulativeCreates;
      },
    },
    $queryRaw: async () => [],
    $executeRawUnsafe: async () => 0,
    $transaction: async (
      callback: (tx: unknown) => Promise<unknown>,
    ): Promise<unknown> => callback(fake),
    measurement: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        cumulativeCreates += 1;
        sample();
        return {
          id: `m${nextId++}`,
          type: data.type,
          value: data.value,
          unit: data.unit,
          measuredAt: data.measuredAt,
          externalId: data.externalId,
          deletedAt: null,
          syncVersion: 1,
          aggregationProvenance: data.aggregationProvenance ?? null,
        };
      },
      createManyAndReturn: async ({
        data,
      }: {
        data: Array<Record<string, unknown>>;
      }) => {
        measurementInserts += data.length;
        sample();
        return data.map((row) => ({
          id: `m${nextId++}`,
          type: row.type,
          measuredAt: row.measuredAt,
          externalId: row.externalId,
        }));
      },
      findMany: async () => [],
      findFirst: async () => null,
      update: async () => {
        throw new Error("unexpected measurement.update in insert-only run");
      },
    },
    workout: {
      createManyAndReturn: async ({
        data,
      }: {
        data: Array<Record<string, unknown>>;
      }) => {
        workoutInserts += data.length;
        sample();
        return data.map((row) => ({
          id: `w${nextId++}`,
          startedAt: row.startedAt,
          externalId: row.externalId,
        }));
      },
      update: async () => {
        throw new Error("unexpected workout.update in insert-only run");
      },
    },
  };
  return fake;
}

describe("large-export bounded-memory regression (issue #775)", () => {
  it(
    "parses a multi-hundred-MB archive with bounded heap growth",
    { timeout: 180_000 },
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "healthlog-large-import-"));
      const xmlSourcePath = join(tmp, "export.xml");
      const zipPath = join(tmp, "export.zip");
      let extractedXmlPath: string | null = null;

      try {
        await writeSyntheticExportXml(xmlSourcePath);
        await wrapFileInStoredZip(
          xmlSourcePath,
          zipPath,
          "apple_health_export/export.xml",
        );
        // The generator's own garbage must not count against the parse.
        unlinkSync(xmlSourcePath);

        // Two measurement channels:
        //   - `measureLive()` collects first, so the reading reflects
        //     retained state only. It runs on every progress tick —
        //     ticks fire throughout the parse whether or not batches
        //     flush, which is exactly where an accumulation regression
        //     shows up as live memory.
        //   - the flush-path `sample()` stays GC-free (a collection per
        //     flush would dominate runtime) and feeds the informational
        //     raw peak in the log line.
        let peakLiveHeap = 0;
        let peakRawHeap = 0;
        let liveMeasurements = 0;
        const measureLive = (): void => {
          forceGc();
          liveMeasurements += 1;
          const used = process.memoryUsage().heapUsed;
          if (used > peakLiveHeap) peakLiveHeap = used;
        };
        const sample = (): void => {
          const used = process.memoryUsage().heapUsed;
          if (used > peakRawHeap) peakRawHeap = used;
        };
        const prisma = makeDiscardingPrisma(sample);

        forceGc();
        const baselineHeapUsed = process.memoryUsage().heapUsed;
        peakLiveHeap = baselineHeapUsed;
        peakRawHeap = baselineHeapUsed;

        const unzip = await extractExportXml(zipPath);
        extractedXmlPath = unzip.xmlPath;
        measureLive();
        expect(unzip.xmlBytes).toBeGreaterThan(MIN_XML_BYTES);

        const result = await streamParseExportXml({
          xmlPath: unzip.xmlPath,
          userId: "user-large-import",
          userTimezone: "Europe/Berlin",
          prisma: prisma as unknown as PrismaClient,
          onProgress: () => {
            measureLive();
          },
        });
        measureLive();

        const liveGrowth = peakLiveHeap - baselineHeapUsed;
        // Surface the measurement in the run log so regressions in the
        // margin are visible before they become failures.
        console.info(
          `[large-import] xmlBytes=${unzip.xmlBytes} ` +
            `baselineHeap=${baselineHeapUsed} peakLiveHeap=${peakLiveHeap} ` +
            `liveGrowth=${liveGrowth} rawPeak=${peakRawHeap} ` +
            `liveMeasurements=${liveMeasurements}`,
        );
        // The progress hook must actually have sampled mid-parse, or
        // the bound would be vacuously green.
        expect(liveMeasurements).toBeGreaterThan(10);
        expect(liveGrowth).toBeLessThan(MAX_HEAP_GROWTH_BYTES);

        // Semantics stay intact while memory stays bounded: every
        // record was read, every spot row flushed, and the cumulative
        // fold produced one estimate row per (type, day) — not one per
        // record or per runtime device address.
        expect(result.totals.recordsRead).toBe(TOTAL_RECORDS);
        expect(prisma.counters.measurementInserts).toBe(SPOT_RECORDS);
        expect(prisma.counters.cumulativeCreates).toBe(STEP_DAYS);
        expect(result.cumulativeEstimates.days).toBe(STEP_DAYS);
        expect(result.cumulativeEstimates.rows).toBe(STEP_DAYS);
      } finally {
        if (extractedXmlPath) {
          try {
            unlinkSync(extractedXmlPath);
          } catch {
            // already gone
          }
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
