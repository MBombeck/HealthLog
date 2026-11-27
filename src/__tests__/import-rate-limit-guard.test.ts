/**
 * Structural guard: the hourly import ceiling has one source.
 *
 * The JSON import, the measurements CSV, the labs and medications CSV and the
 * dose-history import share the bucket `import:<account>`. Each of them used
 * to carry its own literal 5 and its own "Maximum 5 imports per hour", so a
 * change to the limit had to find four places and the message could disagree
 * with the bucket. The ceiling now comes from `IMPORT_RATE_LIMIT_PER_HOUR`
 * through `src/lib/import/import-rate-limit-policy.ts`, and the bucket is
 * spent only by `checkImportRateLimit`.
 *
 * What it refuses, anywhere under `src/` outside those two files:
 *   - a `checkRateLimit(` whose key is the shared `import:${...}` bucket;
 *   - a literal "N imports per hour" message.
 * The staged uploads (`import:${spec.import.kind}:...`) are a different
 * bucket per kind and per minute, and are not matched.
 */
import { describe, expect, it } from "vitest";

import { readSource, readSourceFolder } from "./helpers/source-files";

const OWNERS = new Set([
  "lib/import/import-rate-limit.ts",
  "lib/import/import-rate-limit-policy.ts",
]);

/** `checkRateLimit(` then, across whitespace, a template key on the shared bucket. */
const SHARED_BUCKET_SPEND =
  /checkRateLimit\(\s*`import:\$\{\s*(?:user|actor|account)[A-Za-z]*\.id\s*\}`/g;
const LITERAL_MESSAGE = /\d+\s+imports per hour/g;

/** Routes that must spend the shared bucket through the one helper. */
const SHARED_BUCKET_SPENDERS = [
  "app/api/import/route.ts",
  "app/api/import/csv/route.ts",
  "app/api/medications/intake/dose-history-import/route.ts",
  "lib/import/record-import-route.ts",
];

function sources(): Array<[string, string]> {
  return readSourceFolder("src", {
    floor: 3000,
    include: (rel) =>
      !rel.startsWith("generated/") &&
      !rel.includes("__tests__") &&
      !/\.test\.tsx?$/.test(rel) &&
      !OWNERS.has(rel),
  });
}

describe("the hourly import ceiling has one source", () => {
  it("has matchers that can fail", () => {
    const before = [
      "checkRateLimit(`import:${user.id}`, 5, 60 * 60 * 1000)",
      "checkRateLimit(\n    `import:${actor.id}`,\n    RATE_LIMIT_MAX,",
    ];
    for (const shape of before) {
      expect([...shape.matchAll(SHARED_BUCKET_SPEND)]).toHaveLength(1);
    }
    expect(
      "checkRateLimit(`import:${spec.import.kind}:${actor.id}`, 5, 60_000)",
    ).not.toMatch(SHARED_BUCKET_SPEND);
    expect('apiError("Maximum 5 imports per hour", 429)').toMatch(
      LITERAL_MESSAGE,
    );
  });

  it("no file outside the policy spends the shared bucket directly", () => {
    const offenders = sources()
      .filter(([, text]) => [...text.matchAll(SHARED_BUCKET_SPEND)].length > 0)
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("no file outside the policy writes its own hourly number into the message", () => {
    const offenders = sources()
      .filter(([, text]) => [...text.matchAll(LITERAL_MESSAGE)].length > 0)
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("every buffered import spends the bucket through checkImportRateLimit", () => {
    for (const rel of SHARED_BUCKET_SPENDERS) {
      const text = readSource(`src/${rel}`, "checkImportRateLimit");
      expect(text, rel).toMatch(
        /checkImportRateLimit\(\s*(?:user|actor)\.id\s*\)/,
      );
    }
  });
});
