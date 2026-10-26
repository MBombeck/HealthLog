/**
 * Every write that labels a measurement `EXTERNAL` also links it to the token
 * that carried it (#1272).
 *
 * The label and the link answer one question together: whether the HealthLog
 * app writes the reading into Apple Health is the choice its person made for
 * that token (`apple-health-mirror.ts`). An EXTERNAL row written without the
 * link resolves to false forever, whatever the token says, and nothing in the
 * write path would notice. So the files that resolve `EXTERNAL_SOURCE` are an
 * inventory: a measurement writer must set `ingestTokenId` at least as often
 * as it assigns the label, and a file that starts using the constant fails
 * here until it is classified.
 *
 * A tripwire, not a proof: it counts, it does not trace data flow. The
 * behaviour is pinned by `tests/integration/apple-health-mirror.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Files that write measurement rows labelled with the constant. */
const MEASUREMENT_WRITERS = [
  "lib/measurements/batch-ingest/prepare.ts",
  "lib/measurements/create/create-readings.ts",
  "lib/measurements/create/create-sleep-stage.ts",
];

/** Files that use the constant for something other than a measurement write. */
const NOT_MEASUREMENT_WRITES: Record<string, string> = {
  "app/api/tokens/measurements/route.ts":
    "counts the readings that belong to no token (a read)",
  "lib/validations/measurement.ts": "the source enum and the edit allowlist",
  "lib/workouts/batch-ingest/entries.ts":
    "labels workout rows, which carry no token link",
};

function usesOfConstant(rel: string): {
  assignments: number;
  links: number;
} {
  const code = stripComments(readSourceText(join(SRC, rel)));
  const assignments = (code.match(/\?\s*EXTERNAL_SOURCE\b/g) ?? []).length;
  // A value written under the key, or the shorthand. Not a type member
  // (`ingestTokenId: string | null`) and not a read (`writer.ingestTokenId`),
  // which write nothing.
  const links = (
    code.match(/(?<![.\w])ingestTokenId(?:\s*:(?!\s*string\b)|\s*[,}])/g) ?? []
  ).length;
  return { assignments, links };
}

describe("an EXTERNAL measurement carries its token", () => {
  const files = walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => p !== "lib/measurements/external-source.ts")
    .filter((p) =>
      /\bEXTERNAL_SOURCE\b/.test(stripComments(readSourceText(join(SRC, p)))),
    );

  it("knows every file that uses the constant", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual(
      [...MEASUREMENT_WRITERS, ...Object.keys(NOT_MEASUREMENT_WRITES)].sort(),
    );
  });

  it.each(MEASUREMENT_WRITERS)(
    "%s links the token wherever it assigns the label",
    (rel) => {
      const { assignments, links } = usesOfConstant(rel);
      expect(assignments).toBeGreaterThan(0);
      expect(links).toBeGreaterThanOrEqual(assignments);
    },
  );
});
