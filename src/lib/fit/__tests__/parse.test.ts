/**
 * The decoder runs in a child process with its own heap ceiling and a time
 * limit. A file whose decoded form outgrows the ceiling, or that keeps the
 * decoder busy past the limit, costs that process and is refused as
 * `too_complex`; the process that serves everyone else never sees it.
 */
import { setFlagsFromString } from "node:v8";

import { describe, expect, it } from "vitest";

import { buildWatchActivity } from "../../../../tests/fixtures/fit/build-fit";
import { FitImportError } from "../errors";
import { decodeFitFile } from "../parse";

const START = new Date("2026-10-01T08:00:00Z");

describe("decodeFitFile", () => {
  it("decodes an activity in its own process", async () => {
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
  it("holds the heap ceiling when the server runs with a raised heap limit", async () => {
    // An operator who sets NODE_OPTIONS=--max-old-space-size (as the scaling
    // guide suggests) sets a process-wide V8 flag. A worker thread's own
    // resourceLimits lose to it, so the decoder ran on the server's limit
    // instead of its ceiling. Setting the flag here does what that variable
    // does to this process.
    setFlagsFromString("--max-old-space-size=4096");
    try {
      const failure = await decodeFitFile(
        buildWatchActivity({ start: START, seconds: 100_000 }),
        { maxOldGenerationSizeMb: 4 },
      ).catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(FitImportError);
      expect((failure as FitImportError).code).toBe("too_complex");
    } finally {
      setFlagsFromString("--max-old-space-size=0");
    }
  });
});
