/**
 * The FIT path against generated and mutated files: container, scan, the
 * decoder in its worker, and the mapping onto workouts.
 *
 * Every stage refuses with a `FitImportError` and nothing else, for any bytes.
 * Mutating a real file is not enough on its own, because both checksums catch
 * a flipped byte before anything interesting runs; the mutated files here get
 * their checksums recomputed, so the scan and the decoder see well-framed
 * nonsense.
 */
import { gzipSync } from "node:zlib";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildWatchActivity,
  crc16,
} from "../../../../tests/fixtures/fit/build-fit";
import { unwrapFitUpload } from "../container";
import { FitImportError } from "../errors";
import { validateFitDrafts } from "../import";
import { mapFitActivity } from "../map";
import { decodeFitFile } from "../parse";
import { scanFitFile } from "../scan";

import {
  assertAsyncProperty,
  assertProperty,
  propertyTimeout,
} from "../../../../tests/property/fast-check";

const START = new Date("2026-10-01T08:00:00Z");
const NOW = new Date("2026-10-02T00:00:00Z");
const BASE = buildWatchActivity({
  start: START,
  seconds: 40,
  performance: true,
});

const mutation = fc.array(
  fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })),
  { minLength: 1, maxLength: 12 },
);

/** BASE with bytes overwritten, both checksums made right again. */
function reframed(edits: Array<[number, number]>): Buffer {
  const file = Buffer.from(BASE);
  const headerSize = file[0];
  for (const [at, value] of edits) {
    // Leave the header size and the ".FIT" tag alone: without them it is not
    // a FIT file at all, which the unframed property already covers.
    const i = headerSize + (at % (file.length - headerSize - 2));
    file[i] = value;
  }
  if (headerSize >= 14) file.writeUInt16LE(crc16(file, 0, 12), 12);
  file.writeUInt16LE(crc16(file, 0, file.length - 2), file.length - 2);
  return file;
}

function onlyFitErrors(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof FitImportError)) throw err;
  }
}

const options = {
  externalIdFor: (ms: number, i: number) => `fit:test:${ms}:${i}`,
  keepRoutes: true,
  now: NOW,
};

describe("FIT container and scan", () => {
  it("refuse arbitrary bytes with a FitImportError", () => {
    assertProperty(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        onlyFitErrors(() =>
          scanFitFile(unwrapFitUpload(Buffer.from(bytes)).fit),
        );
      }),
      500,
    );
  });

  it("refuse a damaged file, a damaged gzip and a damaged header the same way", () => {
    const gz = gzipSync(BASE);
    assertProperty(
      fc.property(fc.constantFrom(BASE, gz), mutation, (source, edits) => {
        const bytes = Buffer.from(source);
        for (const [at, value] of edits) bytes[at % bytes.length] = value;
        onlyFitErrors(() => scanFitFile(unwrapFitUpload(bytes).fit));
      }),
      400,
    );
  });

  it("scan a re-framed file or refuse it", () => {
    assertProperty(
      fc.property(mutation, (edits) => {
        onlyFitErrors(() => {
          const scan = scanFitFile(reframed(edits));
          expect(scan.fileLength).toBeLessThanOrEqual(BASE.length);
        });
      }),
      500,
    );
  });
});

describe("FIT decode and mapping", () => {
  it(
    "decode a re-framed file in its worker and map it, or refuse",
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(mutation, async (edits) => {
          const file = reframed(edits);
          let decoded;
          try {
            ({ decoded } = await decodeFitFile(file, { timeoutMs: 10_000 }));
          } catch (err) {
            expect(err).toBeInstanceOf(FitImportError);
            return;
          }
          onlyFitErrors(() => {
            const mapped = mapFitActivity(decoded, options);
            const { entries } = validateFitDrafts(mapped.drafts);
            for (const e of entries) {
              expect(Number.isNaN(new Date(e.startedAt).getTime())).toBe(false);
            }
          });
        }),
        12,
      );
    },
    propertyTimeout(120_000),
  );

  it("map an arbitrary decoded object, or refuse it", () => {
    const value = fc.oneof(
      fc.double(),
      fc.integer(),
      fc.string({ maxLength: 20 }),
      fc.date({ noInvalidDate: false }),
      fc.constant(null),
      fc.constant(undefined),
    );
    const message = fc.dictionary(
      fc.constantFrom(
        "start_time",
        "timestamp",
        "total_elapsed_time",
        "total_timer_time",
        "total_distance",
        "sport",
        "sub_sport",
        "avg_heart_rate",
        "max_heart_rate",
        "heart_rate",
        "speed",
        "enhanced_speed",
        "power",
        "cadence",
        "position_lat",
        "position_long",
        "altitude",
        "enhanced_altitude",
        "total_calories",
        "total_ascent",
        "__proto__",
        "constructor",
      ),
      value,
    );
    const decoded = fc.record(
      {
        file_ids: fc.array(
          fc.record({ type: fc.oneof(value, fc.constantFrom("activity", 4)) }),
          { maxLength: 2 },
        ),
        sessions: fc.array(message, { maxLength: 20 }),
        records: fc.array(message, { maxLength: 60 }),
        laps: fc.array(message, { maxLength: 4 }),
        activity_metrics: fc.array(message, { maxLength: 2 }),
      },
      { requiredKeys: [] },
    );
    assertProperty(
      fc.property(decoded, (d) => {
        onlyFitErrors(() => {
          const mapped = mapFitActivity(d, options);
          validateFitDrafts(mapped.drafts);
        });
      }),
      500,
    );
  });
});
