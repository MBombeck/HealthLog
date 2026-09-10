/**
 * A body that will not parse is always a 400.
 *
 * `safeJson` has answered 400 since it was written and roughly two hundred and
 * twenty routes go through it; `apiHandler`'s own `SyntaxError` branch answers
 * 400 as well. Seven `/api/auth/me/*` writes hand-rolled `await req.json()` in
 * a try/catch and threw 422 for the same condition, so a client's "my
 * serializer produced garbage" branch had to accept two statuses on a subset of
 * routes it could not predict — and the subset was invisible from the outside.
 *
 * The guard reads every hand-rolled parse out of the route tree rather than
 * listing them, so a route that grows one later is judged too. The `catch` is
 * read on its own: a `try` that parses a body and then refuses with anything
 * other than 400 fails here.
 *
 * Its limit: a route that parses a body somewhere other than inside a `try`
 * whose `catch` builds the refusal — a shared helper, a promise chain — is
 * invisible to it. `safeJson` remains the documented entry, and the assertion
 * on the helper below is what pins the status the rest of the tree inherits.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { safeJson } from "@/lib/api-response";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Hand-rolled parses that must keep a different status, with the reason.
 *
 * `/api/auth/me/health-score-config` is here because the published contract
 * names its answer: the operation's own 422 description spells out that a body
 * which is not JSON at all comes back with the bare message
 * `health-score-config.body.invalid_json`. Moving it to 400 would change a
 * promise a shipped client was generated against, so the status stays and the
 * change is a contract decision of its own rather than a cleanup.
 */
const ALLOWLIST: Record<string, { status: number; reason: string }> = {
  "src/app/api/auth/me/health-score-config/route.ts": {
    status: 422,
    reason:
      "The 422 and its exact message are written into the operation's published description.",
  },
};

/** Every `route.ts` under `src/app/api`, tests excluded. */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...routeFiles(full));
      continue;
    }
    if (entry.name === "route.ts") found.push(full);
  }
  return found;
}

/** The brace-balanced block starting at the `{` at or after `from`. */
function block(src: string, from: number): { text: string; end: number } {
  let i = from;
  while (i < src.length && src[i] !== "{") i++;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return { text: src.slice(i, j + 1), end: j + 1 };
    }
  }
  return { text: src.slice(i), end: src.length };
}

interface ParseRefusal {
  route: string;
  line: number;
  status: number | null;
}

/** Every `try { … .json() … } catch { … }` under the route tree. */
function scanHandRolledParses(): ParseRefusal[] {
  const found: ParseRefusal[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\btry\s*\{/g)) {
      const start = m.index ?? 0;
      const tryBlock = block(src, start);
      if (!/(?:req|request)\w*\.json\(\)/.test(tryBlock.text)) continue;
      const after = src.slice(tryBlock.end);
      const catchAt = after.match(/^\s*catch\s*(?:\([^)]*\)\s*)?\{/);
      if (!catchAt) continue;
      const catchBlock = block(after, catchAt.index ?? 0);
      const status = catchBlock.text.match(/\b(4\d\d|5\d\d)\b/);
      found.push({
        route: relative(process.cwd(), file).split(sep).join("/"),
        line: src.slice(0, start).split("\n").length,
        status: status ? Number(status[1]) : null,
      });
    }
  }
  return found;
}

describe("malformed JSON answers one status", () => {
  const parses = scanHandRolledParses();

  it("finds the hand-rolled parses it is meant to judge", () => {
    // Eight when the guard was written. A matcher that stops matching would
    // otherwise report a clean pass it did not earn.
    expect(parses.length).toBeGreaterThanOrEqual(8);
  });

  it("refuses an unparseable body with 400", () => {
    const wrong = parses
      .filter((parse) => {
        const allowed = ALLOWLIST[parse.route];
        if (allowed) return parse.status !== allowed.status;
        return parse.status !== 400;
      })
      .map((parse) => `${parse.route}:${parse.line} -> ${parse.status}`);
    expect(wrong).toEqual([]);
  });

  it("keeps no stale allowlist entries", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (route) => !parses.some((parse) => parse.route === route),
    );
    expect(stale).toEqual([]);
  });

  it("is the status the shared helper already answers with", async () => {
    const request = new Request("https://example.test/api/anything", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const result = await safeJson(request);
    expect(result.error?.status).toBe(400);
    expect(await result.error?.clone().json()).toMatchObject({
      data: null,
      error: "Invalid JSON body",
    });
  });

  it("keeps the wrong-content-type refusal separate at 415", async () => {
    const request = new Request("https://example.test/api/anything", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const result = await safeJson(request);
    expect(result.error?.status).toBe(415);
  });
});
