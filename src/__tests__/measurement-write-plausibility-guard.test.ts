/**
 * Structural guard on the measurement ingest boundary.
 *
 * `VALUE_RANGES` is the band the application declares a metric can occupy.
 * Every path a person can drive enforced it from the start; the provider sync
 * writers never did, and nothing noticed, because each writer is correct on
 * its own terms — it wrote what the remote sent. The gap was only visible from
 * above, by listing every writer at once and asking which of them had ever
 * been told about the band.
 *
 * So the list lives here. Every file that writes a `Measurement` row is
 * enumerated with the reason it is allowed to, and the guard fails when the
 * discovered set stops matching. A provider added tomorrow lands a file that
 * is not in the map and has to answer the question before it can ship.
 *
 * This is a tripwire, not a proof. It cannot show a disposition is the right
 * one — only that nobody added a writer without writing down which gate covers
 * it. A reviewer who waves through a bogus `derived` label defeats it, and no
 * test substitutes for that review.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** The gate module every provider-fed writer has to reach. */
const GATE_MODULE = "@/lib/measurements/plausibility-gate";
/** The predicate every person-driven write path has always used. */
const VALIDATOR = "validateMeasurementRange";

/**
 * How a writer satisfies the plausibility domain.
 *
 * - `gate` — provider-fed; must reach {@link GATE_MODULE} itself.
 * - `validator` — person-driven; must call {@link VALIDATOR} itself.
 * - `upstream` — validated in a named module before the row is built; the
 *   named module is checked, so the label cannot be a shrug.
 * - `derived` — the value is arithmetic over rows already in the table, not a
 *   number from outside. Gating here would drop a consolidation of data that
 *   IS present, which is a different failure from admitting one that is not.
 * - `literal` — the written value is a constant in the file, so no external
 *   number can reach the column.
 * - `restore` — replays the record's own backup verbatim. Fidelity is the
 *   contract; a restore that silently dropped rows would be the worse bug,
 *   and the diagnostic script is how a stored impossible row gets found.
 */
type Disposition =
  | { kind: "gate" }
  | { kind: "validator" }
  | { kind: "upstream"; validatedIn: string }
  | { kind: "derived"; why: string }
  | { kind: "literal"; why: string }
  | { kind: "restore"; why: string };

const WRITERS: Record<string, Disposition> = {
  // ── Provider sync writers, gated ──────────────────────────────────────
  "lib/withings/sync.ts": { kind: "gate" },
  "lib/withings/sync-activity.ts": { kind: "gate" },
  "lib/fitbit/sync-core.ts": { kind: "gate" },
  "lib/google-health/sync-core.ts": { kind: "gate" },
  "lib/nightscout/sync.ts": { kind: "gate" },
  // The shared identity seam. Polar, Oura, WHOOP, the Withings sleep leg,
  // the Apple export importer and the batch endpoint all write through it,
  // so the gate here is what makes a new provider fail closed.
  "lib/measurements/reconcile-external-measurement.ts": { kind: "gate" },

  // ── Person-driven write paths, validated ──────────────────────────────
  "app/api/measurements/route.ts": {
    kind: "upstream",
    validatedIn: "lib/validations/measurement.ts",
  },
  "app/api/import/route.ts": { kind: "validator" },
  "lib/mcp/writes.ts": { kind: "validator" },
  "lib/measurements/create-from-telegram.ts": { kind: "validator" },
  "lib/measurements/import-apple-health-export.ts": { kind: "validator" },
  "app/api/import/csv/route.ts": {
    kind: "upstream",
    validatedIn: "lib/import/csv-measurements.ts",
  },

  // ── Fixed values ──────────────────────────────────────────────────────
  "lib/withings/sync-ecg.ts": {
    kind: "literal",
    why: "an ECG row carries value 1 — the file's own constant, never a provider number",
  },
  "app/api/mental-health/assessments/route.ts": {
    kind: "literal",
    why: "the questionnaire score is summed from Zod-bounded item answers",
  },
  "lib/insights/score-row.ts": {
    kind: "literal",
    why: "the health score is computed in-app on a closed 0-100 scale",
  },

  // ── Derived from rows already stored ──────────────────────────────────
  "lib/measurements/consolidate-daily-mean.ts": {
    kind: "derived",
    why: "writes the mean of the day's own stored rows",
  },
  "lib/measurements/consolidate-legacy-steps.ts": {
    kind: "derived",
    why: "folds stored per-sample step rows into the day's canonical row",
  },
  "lib/measurements/dense-intraday-retention.ts": {
    kind: "derived",
    why: "rebuilds hourly buckets from stored per-sample rows",
  },
  "lib/measurements/drain-per-sample-cumulative.ts": {
    kind: "derived",
    why: "reduces stored cumulative per-sample rows to one daily total",
  },

  // ── Restore ───────────────────────────────────────────────────────────
  "app/api/admin/backups/[id]/restore/route.ts": {
    kind: "restore",
    why: "replays the record's own export; dropping rows would break the restore contract",
  },
};

/**
 * Any Prisma client handle followed by a measurement write. Whitespace- and
 * handle-tolerant on purpose: the earlier generation of this repo's guards
 * demanded a literal `prisma.x.findUnique(` and went green because it matched
 * nothing, not because nothing was there. The transaction handles in use are
 * `tx` and `pc`; a future one is caught by the `[A-Za-z_$][\w$]*` head.
 */
const MEASUREMENT_WRITE =
  /[A-Za-z_$][\w$]*\s*\.\s*measurement\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/;

/**
 * A call into the column-array bulk insert, which writes around the Prisma
 * delegate and so never matches {@link MEASUREMENT_WRITE}. The Apple export
 * importer writes its spot rows only this way, and was invisible to this
 * guard for as long as nothing looked for it. The definitions themselves are
 * excluded by the lookbehind; the module that holds them is pinned below as
 * the one place raw SQL may insert a measurement.
 */
const BULK_INSERT_CALL = /(?<!function\s)\binsert(?:New)?MeasurementRows\s*\(/;

/** Raw SQL that inserts into the measurements table. */
const RAW_MEASUREMENT_INSERT = /INSERT\s+INTO\s+"?measurements"?[\s(]/i;

/** The only module allowed to hold {@link RAW_MEASUREMENT_INSERT}. */
const BULK_INSERT_MODULE = "lib/export/measurement-bulk-insert.ts";

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function discoveredWriters(): string[] {
  return sourceFiles().filter((rel) => {
    const text = read(rel);
    return MEASUREMENT_WRITE.test(text) || BULK_INSERT_CALL.test(text);
  });
}

describe("every measurement writer declares how it meets the plausibility domain", () => {
  it("finds the writers at all — an empty sweep is a broken guard, not a clean repo", () => {
    // The map is the claim; this asserts the matcher can still see the
    // population it describes. A regex that silently stops matching would
    // otherwise turn every check below into a tautology.
    expect(discoveredWriters().length).toBeGreaterThanOrEqual(15);
  });

  it("the discovered writer set matches the declared map exactly", () => {
    expect(discoveredWriters()).toEqual(Object.keys(WRITERS).sort());
  });

  it("sees a writer that only calls the bulk insert", () => {
    // The importer has no Prisma measurement write left; if the bulk-insert
    // matcher stopped matching, it would drop out of the sweep silently.
    const importer = "lib/measurements/import-apple-health-export.ts";
    expect(MEASUREMENT_WRITE.test(read(importer))).toBe(false);
    expect(discoveredWriters()).toContain(importer);
  });

  it("raw SQL inserts measurements in the bulk-insert module and nowhere else", () => {
    const raw = sourceFiles().filter((rel) =>
      RAW_MEASUREMENT_INSERT.test(read(rel)),
    );
    expect(raw).toEqual([BULK_INSERT_MODULE]);
  });

  it("every provider-fed writer reaches the gate module", () => {
    const gated = Object.entries(WRITERS)
      .filter(([, d]) => d.kind === "gate")
      .map(([rel]) => rel);
    expect(gated.length).toBeGreaterThanOrEqual(6);
    for (const rel of gated) {
      expect(read(rel), `${rel} must import ${GATE_MODULE}`).toContain(
        GATE_MODULE,
      );
    }
  });

  it("every person-driven writer calls the range validator", () => {
    for (const [rel, disposition] of Object.entries(WRITERS)) {
      if (disposition.kind === "validator") {
        expect(read(rel), `${rel} must call ${VALIDATOR}`).toContain(VALIDATOR);
      }
      if (disposition.kind === "upstream") {
        expect(
          read(disposition.validatedIn),
          `${disposition.validatedIn} must call ${VALIDATOR} on behalf of ${rel}`,
        ).toContain(VALIDATOR);
      }
    }
  });

  it("the exempt writers carry a written reason", () => {
    for (const [rel, disposition] of Object.entries(WRITERS)) {
      if (
        disposition.kind === "derived" ||
        disposition.kind === "literal" ||
        disposition.kind === "restore"
      ) {
        expect(disposition.why.length, `${rel} needs a reason`).toBeGreaterThan(
          20,
        );
      }
    }
  });
});
