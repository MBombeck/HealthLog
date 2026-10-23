/**
 * Every ISO instant under `src/` goes through `isoDateTime()`.
 *
 * Since v1.43 a request instant must carry seconds, and the refusal is counted
 * (`validation.datetime.no_seconds`) so a client on a minute-precision encoder
 * shows up in the logs. Both live in `src/lib/validations/datetime.ts`. A
 * schema that calls `z.iso.datetime(` or `z.string().datetime(` directly gets
 * zod's default message and is invisible to the counter, so a direct call
 * anywhere else is refused here.
 *
 * The matcher tolerates whitespace and line breaks between `z`, `.iso` /
 * `.string()` and `.datetime(`, because prettier splits long chains, and it
 * also refuses a bare `.datetime(` chained off anything, so an alias such as
 * `const s = z.string(); s.datetime()` cannot route around it. Comments are
 * stripped first so prose about the old form does not trip it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments, walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const HELPER = "lib/validations/datetime.ts";

function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
}

const DIRECT_DATETIME = /\.\s*datetime\s*\(/g;
const HELPER_CALL = /\bisoDateTime\s*\(/g;

function directDatetimeCalls(text: string): number {
  return (stripComments(text).match(DIRECT_DATETIME) ?? []).length;
}

describe("datetime helper guard", () => {
  const files = sourceFiles();

  it("finds no direct zod datetime call outside the helper", () => {
    const offenders = files
      .filter((rel) => rel !== HELPER)
      .flatMap((rel) => {
        const n = directDatetimeCalls(readFileSync(join(SRC, rel), "utf8"));
        return n > 0 ? [`${rel} (${n})`] : [];
      });
    expect(
      offenders,
      "use isoDateTime() from @/lib/validations/datetime instead",
    ).toEqual([]);
  });

  it("the helper itself is the one place that calls zod", () => {
    expect(directDatetimeCalls(readFileSync(join(SRC, HELPER), "utf8"))).toBe(
      1,
    );
  });

  it("actually sees the call sites it guards", () => {
    // An empty sweep agrees with an empty offender list. The helper has
    // hundreds of callers; a count far below that means the walk or the
    // matcher went blind, not that the tree is clean.
    const calls = files
      .filter((rel) => rel !== HELPER)
      .reduce(
        (sum, rel) =>
          sum +
          (readFileSync(join(SRC, rel), "utf8").match(HELPER_CALL) ?? [])
            .length,
        0,
      );
    expect(calls).toBeGreaterThan(350);
  });

  it("matches the forms prettier produces", () => {
    expect(directDatetimeCalls("z.iso.datetime({ offset: true })")).toBe(1);
    expect(directDatetimeCalls("z.iso\n  .datetime({ offset: true })")).toBe(1);
    expect(directDatetimeCalls("z\n  .string()\n  .datetime()")).toBe(1);
    expect(directDatetimeCalls("s . datetime ()")).toBe(1);
    expect(directDatetimeCalls("// z.iso.datetime() in prose")).toBe(0);
    expect(directDatetimeCalls("/* z.string().datetime() */")).toBe(0);
    expect(directDatetimeCalls("isoDateTime()")).toBe(0);
  });
});
