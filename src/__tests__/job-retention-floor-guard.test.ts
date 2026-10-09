/**
 * No queue may forget its failed jobs before the failure readers look.
 *
 * `job-failures.ts` reads pg-boss's own `state = 'failed'` rows over a 72-hour
 * window: the admin status card, the per-account "last run failed" hint and
 * the repeated-failure count behind the `job.run.failed` alert all rest on
 * those rows still existing. pg-boss deletes a terminal row
 * `deleteAfterSeconds` after it finished. v1.42 shortens that option on the
 * pure-volume queues, and a value under the reader window would make a
 * failing queue read as healthy, with nothing anywhere saying so.
 *
 * The rule: a `deleteAfterSeconds` in the source is either produced by
 * `failureReaderRetention(hours)` (which throws under the floor) or written as
 * a plain literal at or above `FAILED_ROW_AVAILABILITY_FLOOR_HOURS`. Anything
 * else, a named constant included, fails here, because a constant's value is
 * not checkable from the call site and the helper exists to make it so.
 *
 * Mutation check, run when this guard was written: a planted
 * `deleteAfterSeconds: 48 * 60 * 60` in a job file fails the second case, and
 * `deleteAfterSeconds: VOLUME_SECONDS` fails it too; the matcher self-test
 * below proves the scan sees both shapes, so an empty sweep is not mistaken
 * for a clean one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { walkSourceFiles } from "./helpers/source-files";
import { FAILED_ROW_AVAILABILITY_FLOOR_HOURS } from "@/lib/jobs/job-failures";

const SRC = join(process.cwd(), "src");
const FLOOR_SECONDS = FAILED_ROW_AVAILABILITY_FLOOR_HOURS * 3600;

/** The one file allowed to spell the option out: the helper itself. */
const HELPER_FILE = "lib/jobs/job-failures.ts";

const OPTION = /\bdeleteAfterSeconds\s*:\s*([^,}\n]+)/g;

/** Evaluate a sum of products of integer literals; null for anything else. */
function literalSeconds(expression: string): number | null {
  const cleaned = expression.trim().replace(/_/g, "");
  if (!/^\d+(\s*[*+]\s*\d+)*$/.test(cleaned)) return null;
  return cleaned
    .split("+")
    .map((term) =>
      term
        .split("*")
        .map((factor) => Number(factor.trim()))
        .reduce((a, b) => a * b, 1),
    )
    .reduce((a, b) => a + b, 0);
}

interface Finding {
  file: string;
  expression: string;
}

function scan(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const match of text.matchAll(OPTION)) {
    out.push({ file, expression: match[1].trim() });
  }
  return out;
}

function violations(findings: readonly Finding[]): string[] {
  return findings
    .filter((f) => {
      const seconds = literalSeconds(f.expression);
      return seconds === null || seconds < FLOOR_SECONDS;
    })
    .map((f) => `${f.file}: deleteAfterSeconds: ${f.expression}`);
}

function sourceFindings(): Finding[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .filter((p) => p !== HELPER_FILE)
    .flatMap((p) => scan(p, readFileSync(join(SRC, p), "utf8")));
}

describe("job retention floor", () => {
  it("the matcher sees both a short literal and a named constant", () => {
    const planted = scan(
      "planted.ts",
      [
        "await boss.createQueue(Q, { deleteAfterSeconds: 48 * 60 * 60 });",
        "await boss.createQueue(R, { deleteAfterSeconds: VOLUME_SECONDS });",
        "await boss.createQueue(S, { deleteAfterSeconds: 7 * 24 * 3600 });",
      ].join("\n"),
    );
    expect(planted).toHaveLength(3);
    expect(violations(planted)).toEqual([
      "planted.ts: deleteAfterSeconds: 48 * 60 * 60",
      "planted.ts: deleteAfterSeconds: VOLUME_SECONDS",
    ]);
  });

  it("every queue retention in the tree keeps failed rows past the reader window", () => {
    expect(violations(sourceFindings())).toEqual([]);
  });
});
