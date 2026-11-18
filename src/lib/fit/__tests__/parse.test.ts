/**
 * The decoder runs in a worker thread with its own heap ceiling and a time
 * limit. A file whose decoded form outgrows the ceiling, or that keeps the
 * decoder busy past the limit, costs that thread and is refused as
 * `too_complex`; the process that serves everyone else never sees it.
 */
import { describe, expect, it } from "vitest";

import { buildWatchActivity } from "../../../../tests/fixtures/fit/build-fit";
import { FitImportError } from "../errors";
import { decodeFitFile } from "../parse";

const START = new Date("2026-10-01T08:00:00Z");

describe("decodeFitFile", () => {
  it("decodes an activity in its worker", async () => {
    const { decoded, scan } = await decodeFitFile(
      buildWatchActivity({ start: START, seconds: 60 }),
    );
    expect(scan.dataMessages).toBeGreaterThan(60);
    expect(Array.isArray(decoded.records)).toBe(true);
  });

  it("refuses a decode that outruns its time limit", async () => {
    const file = buildWatchActivity({ start: START, seconds: 600 });
    await expect(decodeFitFile(file, { timeoutMs: 1 })).rejects.toMatchObject({
      code: "too_complex",
    });
  });

  it("refuses a decode that outgrows its heap, and lives on", async () => {
    const file = buildWatchActivity({ start: START, seconds: 100_000 });
    const failure = await decodeFitFile(file, {
      maxOldGenerationSizeMb: 4,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(FitImportError);
    expect((failure as FitImportError).code).toBe("too_complex");
    // The next file decodes as before.
    await expect(
      decodeFitFile(buildWatchActivity({ start: START, seconds: 30 })),
    ).resolves.toBeDefined();
  });
});
