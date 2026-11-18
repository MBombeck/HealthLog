/**
 * Provider and import writers settle their measurements in batches.
 *
 * `reconcileExternalMeasurement` costs about eight statements a reading and
 * plans its candidate read from statistics: for an account the statistics do
 * not know yet it walks every row the account holds, so a writer that loops it
 * over a history is quadratic in that history. That was the Garmin, Polar,
 * Oura, WHOOP, Withings sleep, Health Connect and Apple Health daily-total
 * writers until they moved to `reconcileExternalMeasurements`, which settles a
 * batch in sets with the same verdicts.
 *
 * A call to the single-reading form is allowed only in the files below, each
 * for the reason it gives. A new writer that reaches for it fails here; one
 * that writes a reading at a time on purpose (a hand entry) is added with its
 * reason.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** A call of the single-reading form; the batch form ends in `s`. */
const SINGLE_RECONCILE = /\breconcileExternalMeasurement\s*\(/g;

const ALLOWED: Record<string, string> = {
  "lib/measurements/reconcile-external-measurement.ts":
    "the definition, and the batch form's fallback for the entries it cannot settle in sets",
  "lib/measurements/create/create-sleep-stage.ts":
    "one hand-entered sleep segment per request",
  "lib/measurements/batch-ingest/write-measurements.ts":
    "only the entries its own set insert skipped",
  "lib/google-health/sync-core.ts":
    "only the natural-key conflicts its set update was refused",
};

function callers(): Map<string, number> {
  const out = new Map<string, number>();
  for (const rel of walkSourceFiles(SRC, { floor: 3000 })) {
    if (rel.startsWith("generated/") || rel.includes("__tests__")) continue;
    if (!/\.tsx?$/.test(rel) || /\.test\.tsx?$/.test(rel)) continue;
    const text = readSourceText(join(SRC, rel)).replace(
      /export async function reconcileExternalMeasurement\s*\(/,
      "",
    );
    const n = text.match(SINGLE_RECONCILE)?.length ?? 0;
    if (n > 0) out.set(rel, n);
  }
  return out;
}

describe("per-reading reconcile", () => {
  it("is called only where a reading at a time is the point", () => {
    const found = callers();
    // The matcher has to see the calls that are there, or the guard is green
    // for nothing.
    expect(found.size).toBeGreaterThan(0);
    expect([...found.keys()].filter((rel) => !(rel in ALLOWED))).toEqual([]);
  });

  it("names no file that no longer calls it", () => {
    const found = callers();
    expect(Object.keys(ALLOWED).filter((rel) => !found.has(rel))).toEqual([]);
  });
});
