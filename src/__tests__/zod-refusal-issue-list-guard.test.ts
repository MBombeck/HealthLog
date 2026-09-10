/**
 * Every 422 raised by a Zod `safeParse` names the fields it refused.
 *
 * `returnAllZodIssues` / `apiValidationError` emit `details.issues` — one entry
 * per rejected field — so a client with three bad fields fixes all three in one
 * round-trip instead of three. Most routes use them. Fifty-nine refusal sites
 * did not: they returned the correct 422 with a single opaque sentence, and a
 * client could not map the failure onto a field. Twelve of those put a dotted
 * machine token in `error` instead of a sentence, so `error` was sometimes text
 * to show a person and sometimes a token that must not be shown, with nothing
 * in the payload to tell them apart.
 *
 * The matcher is per-site, not per-file, because per-file is what let this
 * grow: a route that used the helper once and a bare `apiError(..., 422)`
 * somewhere else in the same file looked compliant to a `grep -l` sweep. So
 * every `if (!<result>.success)` block whose identifier came from a `safeParse`
 * in that file is read on its own, and only the blocks that answer 422 are
 * judged — a 400, a 401 or a 403 raised off a parse result is a different
 * refusal and is left alone.
 *
 * The second half of the same audit item is the dotted token in `error`, and
 * it is checked by its own sweep at the bottom of this file rather than by the
 * per-site matcher above: `report-selection.leaves.unknown` was decided by
 * `if (!minted.ok)` rather than by a parse result, so the block matcher could
 * not see it while the string it answered with was the defect itself. The
 * token sweep reads the refused string, not the condition that chose it, so a
 * site cannot hide behind the shape of its own `if`.
 *
 * Its limits, stated so nobody reads more into a green run than is there:
 * a refusal built somewhere other than the `if (!x.success)` block that decided
 * it — a helper called with the error, a status assembled from a variable — is
 * invisible to the issue-list half, and so is a route that hands the `ZodError`
 * to shared code outside `src/app/api`. It catches the shape this defect
 * actually took, and the count assertions below are what keep it from passing
 * on a matcher that silently stopped matching anything.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src", "app", "api");

/**
 * Routes that answer a shape refusal without the issue list, each with the
 * reason it must differ. Empty today: every 422 raised off a `safeParse` under
 * `src/app/api` carries `details.issues`. An entry here is a decision, not a
 * backlog item — write why the list cannot ship, not when it will.
 */
const ALLOWLIST: Record<string, string> = {};

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

/**
 * The `{ … }` (or single statement) that follows an `if (…)`, brace-balanced.
 *
 * A refusal is often one statement with no braces — `if (!parsed.success)
 * return apiError("Invalid data", 422);` — so both forms are read.
 */
function refusalBlock(src: string, afterCondition: number): string {
  let i = afterCondition;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] === "{") {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    return src.slice(i);
  }
  const end = src.indexOf(";", i);
  return src.slice(i, end === -1 ? src.length : end + 1);
}

interface RefusalSite {
  route: string;
  line: number;
  carriesIssues: boolean;
}

/** Every 422 refusal decided by a `safeParse` result, across the route tree. */
function scanRefusalSites(): RefusalSite[] {
  const sites: RefusalSite[] = [];
  for (const file of routeFiles(API_ROOT)) {
    const src = readFileSync(file, "utf8");
    // Identifiers bound to a parse result. Both call styles are in the tree:
    // `schema.safeParse(body)` and the standalone `z.safeParse(schema, body)`.
    const parsed = new Set<string>();
    for (const m of src.matchAll(
      /(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?[^;]*?safeParse\s*\(/g,
    )) {
      parsed.add(m[1]);
    }
    if (parsed.size === 0) continue;

    for (const m of src.matchAll(
      /if\s*\(\s*!\s*([A-Za-z0-9_$]+)\.success\s*\)/g,
    )) {
      if (!parsed.has(m[1])) continue;
      const block = refusalBlock(src, (m.index ?? 0) + m[0].length);
      // `returnAllZodIssues` and `apiValidationError` answer 422 unless told
      // otherwise, so a block that calls one is a 422 site whether or not the
      // number is spelled: a future `refuse422(parsed.error)` helper would
      // otherwise be invisible for the same reason.
      const carriesIssues = /returnAllZodIssues|apiValidationError/.test(block);
      if (!/\b422\b/.test(block) && !carriesIssues) continue;
      if (
        /\b(?:400|401|403|409|413|415|429|500|502)\b/.test(block) &&
        !/\b422\b/.test(block)
      )
        continue;
      sites.push({
        route: relative(process.cwd(), file).split(sep).join("/"),
        line: src.slice(0, m.index).split("\n").length,
        carriesIssues,
      });
    }
  }
  return sites;
}

describe("Zod shape refusals carry the issue list", () => {
  const sites = scanRefusalSites();

  it("finds the refusal sites it is meant to judge", () => {
    // A matcher that stops matching would otherwise report a clean zero it did
    // not earn. Two hundred and forty-eight sites when this was written, so
    // the old floor of 40 would have survived losing five matches in six.
    expect(sites.length).toBeGreaterThan(200);
  });

  it("answers every 422 with details.issues", () => {
    const missing = sites
      .filter((site) => !site.carriesIssues && !(site.route in ALLOWLIST))
      .map((site) => `${site.route}:${site.line}`);
    expect(missing).toEqual([]);
  });

  it("keeps no stale allowlist entries", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (route) => !sites.some((site) => site.route === route),
    );
    expect(stale).toEqual([]);
  });
});

/**
 * The dotted token in `error`, wherever it is refused from.
 *
 * `error` is the field a client shows a person. A 422 that puts
 * `report-selection.leaves.unknown` there hands the UI a string it must not
 * render and gives it nothing else to branch on. That site was decided by
 * `if (!minted.ok)`, not by a parse result, so the per-site matcher above ran
 * past it — which is the argument for reading the refused string directly:
 * whatever chose the refusal, the string is the defect.
 *
 * The inventory below is frozen and may only shrink. Each entry says why the
 * token is still the whole `error` string; a new one fails until somebody
 * either writes a sentence or writes the reason.
 */
const TOKEN_IN_ERROR_422: Record<string, string> = {
  "src/app/api/auth/me/coach-prefs/route.ts coach-prefs.body.invalid_shape":
    "The status does not move for a shape refusal, so moving the string too would be an unforced second wire change; `meta.errorCode` now carries the same token.",
  "src/app/api/auth/me/report-selection/route.ts report-selection.body.invalid_shape":
    "Same shape refusal, same reason.",
  "src/app/api/auth/me/source-priority/route.ts source-priority.body.invalid_shape":
    "Same shape refusal, same reason.",
  "src/app/api/insights/chat/messages/[id]/feedback/route.ts feedback.body.invalid":
    "Same shape refusal, same reason.",
  "src/app/api/insights/chat/route.ts coach.request.invalid":
    "Same shape refusal, same reason.",
  "src/app/api/auth/me/health-score-config/route.ts health-score-config.body.invalid_json":
    "The published 422 description spells this exact body out as what a non-JSON request earns. It is the one operation whose contract promises the token, so the token is what it answers with.",
  "src/app/api/coach/reminder-suggestions/route.ts coach.suggestion.unknownCadence":
    "Predates this sweep and carries no `meta.errorCode` yet; the Coach reminder surfaces move as one piece or not at all.",
  "src/app/api/coach/reminders/route.ts coach.reminder.invalidWhen":
    "Predates this sweep, same surface.",
  "src/app/api/coach/reminders/[id]/route.ts coach.reminder.invalidWhen":
    "Predates this sweep, same surface.",
  "src/app/api/coach/suggested-actions/route.ts coach.action.unknownInterval":
    "Predates this sweep, same surface.",
  "src/app/api/coach/suggested-actions/route.ts coach.reminder.invalidWhen":
    "Predates this sweep, same surface.",
};

/** A dotted machine token: no spaces, at least one dot, no sentence in sight. */
const DOTTED_TOKEN = /^[a-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;

/** Every `.ts` under `src/app/api`, tests excluded — not only `route.ts`. */
function apiFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      found.push(...apiFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Every 422 whose `error` string is a dotted token, keyed `<file> <token>`. */
function tokenRefusals(): string[] {
  const found: string[] = [];
  for (const file of apiFiles(API_ROOT)) {
    const src = readFileSync(file, "utf8");
    const route = relative(process.cwd(), file).split(sep).join("/");
    const shapes = [
      /apiError\(\s*"([^"]+)"\s*,\s*422/g,
      /apiValidationError\(\s*"([^"]+)"/g,
      /new HttpError\(\s*422\s*,\s*"([^"]+)"/g,
    ];
    for (const shape of shapes) {
      for (const m of src.matchAll(shape)) {
        if (!DOTTED_TOKEN.test(m[1])) continue;
        const key = `${route} ${m[1]}`;
        if (!found.includes(key)) found.push(key);
      }
    }
  }
  return found;
}

describe("a 422 does not answer with a machine token where the sentence goes", () => {
  const refusals = tokenRefusals();

  it("finds the sites it is meant to judge", () => {
    // Eleven when this was written, twelve before the report-selection leaf
    // refusal was rewritten. A matcher that stopped matching would agree with
    // an empty inventory.
    expect(refusals.length).toBeGreaterThan(8);
  });

  it("keeps the token in `error` only where a reason is written down", () => {
    const unexplained = refusals
      .filter((key) => !(key in TOKEN_IN_ERROR_422))
      .sort();
    expect(unexplained).toEqual([]);
  });

  it("keeps no stale inventory entry", () => {
    const stale = Object.keys(TOKEN_IN_ERROR_422)
      .filter((key) => !refusals.includes(key))
      .sort();
    expect(stale).toEqual([]);
  });
});
