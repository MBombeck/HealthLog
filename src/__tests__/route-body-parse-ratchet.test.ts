/**
 * Route handlers read their JSON body through `parseJsonBody`.
 *
 * `parseJsonBody` (`src/lib/api/body.ts`) is `safeJson`, the Zod
 * `safeParse`, the validation-failed wide-event action and the multi-issue
 * 422 envelope in one call. Before it, every body-accepting route spelled
 * those steps out by hand, and the copies drifted: some annotated the
 * refusal and some did not, some answered a flat 400 where the rest answered
 * the multi-issue 422.
 *
 * The routes that still call `safeJson` themselves are counted per file in
 * `baselines/route-safe-json.json`. Most of them do something between
 * reading and validating (an optimistic-concurrency token split off the body,
 * a count cap answered before the schema runs, a refund of a spent quota on a
 * malformed body), which is a reason to keep the read separate, not a reason
 * to copy it into a new route. A new route file that calls `safeJson`, or a
 * listed one that gains a call, fails. A file that sheds one fails until the
 * lower count is written back with
 * `RATCHET_WRITE=1 pnpm vitest run src/__tests__/route-body-parse-ratchet.test.ts`.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runRatchet, writeBackHint } from "./helpers/ratchet";
import {
  readSourceText,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const GUARD = "src/__tests__/route-body-parse-ratchet.test.ts";
const APP = join(process.cwd(), "src/app");

const SAFE_JSON_CALL = /\bsafeJson\s*(?:<[^>()]*>)?\s*\(/g;
const PARSE_JSON_BODY_CALL = /\bparseJsonBody\s*\(/g;

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe("route body parsing", () => {
  const routes = walkSourceFiles(APP, { floor: 400 }).filter((rel) =>
    rel.endsWith("/route.ts"),
  );
  const safeJson: Record<string, number> = {};
  const helper: string[] = [];
  for (const rel of routes) {
    const code = stripComments(readSourceText(join(APP, rel)));
    const n = count(code, SAFE_JSON_CALL);
    if (n > 0) safeJson[`app/${rel}`] = n;
    if (count(code, PARSE_JSON_BODY_CALL) > 0) helper.push(rel);
  }

  it("finds the routes on both sides", () => {
    requireFloor("route files", routes, 400);
    requireFloor(
      "routes reading their body through parseJsonBody",
      helper,
      100,
    );
    requireFloor("routes still calling safeJson", Object.keys(safeJson), 1);
  });

  it("adds no route that calls safeJson itself", () => {
    const r = runRatchet("route-safe-json.json", safeJson, {
      comment: `safeJson calls per route file under src/app; new body-reading routes use parseJsonBody. Maintained by ${GUARD}.`,
    });
    expect(
      r.grew,
      "A route that reads its body with safeJson. Use parseJsonBody " +
        "(src/lib/api/body.ts); its options cover the size cap, the " +
        "validation-failed action, the error code and the message.",
    ).toEqual([]);
    expect(r.stale, writeBackHint(GUARD)).toEqual([]);
  });

  it("counts a call however it is spelled", () => {
    expect(count("await safeJson(request)", SAFE_JSON_CALL)).toBe(1);
    expect(
      count("await safeJson<Body>(req, { maxBytes: 1 })", SAFE_JSON_CALL),
    ).toBe(1);
    expect(count("await safeJson (\n  request,\n)", SAFE_JSON_CALL)).toBe(1);
    expect(count("import { safeJson } from", SAFE_JSON_CALL)).toBe(0);
  });
});
