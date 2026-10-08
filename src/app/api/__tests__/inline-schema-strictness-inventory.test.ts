import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * Inline request-schema strictness inventory.
 *
 * A `z.object()` without `.strict()` STRIPS an unknown key and parses
 * clean. A client that sends `measuredAtt` for `measuredAt` gets a 200
 * and loses the value; nobody is told. `.strict()` turns that into a 422
 * that names the key.
 *
 * It is not a change to make everywhere. `.strict()` flips accept-and-
 * strip into reject, and this server is talked to by a native client on
 * TestFlight and by self-hosted installs that lag the client by an
 * arbitrary number of releases. On the surfaces where the client adds an
 * optional field and older servers are expected to ignore it, the strip
 * IS the compatibility mechanism, and taking it away turns a graceful
 * degrade into a hard failure — a whole 500-entry sync batch refused
 * rather than one field dropped.
 *
 * So each inline schema is a decision, and this test is where the
 * decision is written down. Every `z.object(...)` under a route file is
 * either `.strict()` or accounted for in {@link DELIBERATELY_OPEN} with
 * the reason it stays open. A new route cannot land without making the
 * call, and an existing open schema cannot quietly gain a sibling.
 *
 * Deliberately an inventory, not a policy: it does not claim strict is
 * the right default. It claims the choice was made on purpose.
 */

const API_ROOT = resolve(__dirname, "..");

/**
 * Route files whose inline schemas stay open, with the count of open
 * schemas in each and why. `count` is part of the assertion: adding an
 * open schema to a listed file fails until the entry is updated, so the
 * reason below always covers everything it claims to cover.
 */
const DELIBERATELY_OPEN: Record<string, { count: number; reason: string }> = {
  // ---------------------------------------------------------------
  // 1. Query schemas fed a hand-built object. The handler names each
  //    param it reads (`{ limit: searchParams.get("limit"), … }`), so an
  //    unknown query param never reaches the schema at all. `.strict()`
  //    here asserts nothing — it would be decoration on a parse that
  //    cannot see the key it is supposed to reject.
  // ---------------------------------------------------------------
  "admin/app-logs/route.ts": { count: 1, reason: "hand-built query object" },
  "admin/audit-log/route.ts": { count: 1, reason: "hand-built query object" },
  "admin/host-metrics/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "analytics/range/route.ts": { count: 1, reason: "hand-built query object" },
  "insights/biomarker-assessment/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "insights/coach-read/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "insights/derived/batch/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "insights/derived/route.ts": { count: 1, reason: "hand-built query object" },
  "insights/metric-status/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "insights/narrative/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "insights/pulse/intraday/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "medications/[id]/cadence/route.ts": {
    count: 1,
    reason: "hand-built query object",
  },
  "sync/changes/route.ts": { count: 1, reason: "hand-built query object" },
  // Same shape, not a query: the range check the edit handler runs
  // against the row's own type. Its input is `{ value: data.value }`,
  // built one line above from data the handler already parsed — there is
  // no caller-supplied key for a strict parse to reject.
  "measurements/[id]/route.ts": {
    count: 1,
    reason: "hand-built parse input",
  },

  // ---------------------------------------------------------------
  // 2. Read filters fed the whole `searchParams`. Here an unknown key
  //    DOES reach the schema, and strict would reject it — which is the
  //    wrong trade on a read. A stray param discards nothing: the filter
  //    the caller asked for is still applied and the response is still
  //    correct. Meanwhile these are hot paths (`measurements/series` is
  //    the iOS chart loader), a 422 paints an error banner over a chart
  //    that would otherwise have rendered, and cache-busters and
  //    campaign params ride on URLs for reasons no handler controls.
  // ---------------------------------------------------------------
  "measurements/series/route.ts": {
    count: 1,
    reason: "read filter over whole searchParams",
  },
  "mood/linked-context/route.ts": {
    count: 1,
    reason: "read filter over whole searchParams",
  },
  "sleep/night/route.ts": {
    count: 1,
    reason: "read filter over whole searchParams",
  },
  "medications/[id]/dose-history/route.ts": {
    count: 1,
    reason: "read filter over whole searchParams",
  },
  "medications/compliance/route.ts": {
    count: 1,
    reason: "read filter over whole searchParams",
  },
  "mood/insights/route.ts": {
    count: 1,
    reason: "read filter over whole searchParams",
  },

  // ---------------------------------------------------------------
  // 3. Native-client ingest and device registration. This is where the
  //    strip is load-bearing. Every field on these bodies arrived as an
  //    additive optional one — `source`, `deviceType`, `valueMin` /
  //    `valueMax`, `syncTrigger`, `tagKeys`, `liveActivityPushToken` —
  //    and each shipped on the promise that a server which does not know
  //    it stays byte-for-byte unchanged. A client build reaches a server
  //    older than itself as a matter of routine here: the app updates
  //    through TestFlight and the server updates when its operator gets
  //    round to it. Strict would turn that skew into a refused batch,
  //    and the batch endpoints' own contract is the opposite — a bad row
  //    is `skipped` and the rest lands, so a phone draining a year of
  //    history does not lose the year to one row. `devices` is the worst
  //    case of the set: refuse the registration and the account silently
  //    stops receiving push entirely.
  // ---------------------------------------------------------------
  "measurements/batch/route.ts": { count: 2, reason: "native ingest skew" },
  "mood-entries/bulk/route.ts": { count: 4, reason: "native ingest skew" },
  "medications/intake/bulk/route.ts": {
    count: 2,
    reason: "native ingest skew",
  },
  "integrations/healthkit/route.ts": { count: 2, reason: "native ingest skew" },
  "devices/route.ts": { count: 1, reason: "native ingest skew" },

  // ---------------------------------------------------------------
  // 4. Layout PUTs. Same skew, same mechanism: `comparisonBaseline`,
  //    `chartOverlayPrefs`, `tileVisible`, `sections` all landed as
  //    optional fields at an unchanged `version`, which makes
  //    "add an optional field, older servers ignore it" the documented
  //    compatibility contract for these blobs rather than an accident.
  //    `insights/layout` still accepts `version: 1` specifically because
  //    the live native client sends it. Strict would refuse a Save from
  //    any client ahead of the server and surface as a failed-to-save
  //    toast with no way for the user to act on it.
  // ---------------------------------------------------------------
  "dashboard/widgets/route.ts": { count: 3, reason: "layout additive-field" },
  "insights/layout/route.ts": { count: 3, reason: "layout additive-field" },
  "medications/layout/route.ts": { count: 1, reason: "layout additive-field" },

  // ---------------------------------------------------------------
  // 5. OAuth. RFC 6749 §3.1 requires the authorization endpoint to
  //    ignore unrecognised request parameters, and RFC 7591 §2 requires
  //    the registration endpoint to ignore unrecognised metadata — the
  //    register schema already carries an accepted-and-ignored block for
  //    exactly this. Strict would be a spec violation, not a hardening.
  // ---------------------------------------------------------------
  "mcp/oauth/authorize/route.ts": { count: 1, reason: "RFC requires ignore" },
  "mcp/oauth/register/route.ts": { count: 1, reason: "RFC requires ignore" },

  // ---------------------------------------------------------------
  // 6. Archive and file import. The payload is a document produced
  //    somewhere else — an export from another version of this app, or a
  //    CSV from a third-party tracker whose columns nobody here controls.
  //    Refusing an archive because it carries a column this version does
  //    not read would make a backup unrestorable on the version that has
  //    to restore it, which is the one job a backup has.
  // ---------------------------------------------------------------
  "import/route.ts": { count: 3, reason: "foreign archive" },
  "medications/[id]/intake/import/route.ts": {
    count: 1,
    reason: "foreign archive",
  },
};

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      routeFiles(full, acc);
    } else if (entry === "route.ts") {
      acc.push(full);
    }
  }
  return acc;
}

/** `z.object(...)` and `z.strictObject(...)` calls. */
function zodObjectKind(node: ts.Node): "object" | "strictObject" | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const name = callee.name.text;
  if (name !== "object" && name !== "strictObject") return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "z") {
    return null;
  }
  return name;
}

/**
 * Whether a `.strict()` sits on the chain wrapping this call. Walking the
 * chain rather than matching text is what makes the sweep trustworthy:
 * a schema written as `z\n  .object({…})\n  .strict()` is invisible to a
 * `z.object(` grep, and fourteen of the schemas in this tree are written
 * exactly that way.
 */
function hasStrictOnChain(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current
    ) {
      if (parent.name.text === "strict") return true;
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function openSchemaCount(file: string): number {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let open = 0;
  const walk = (node: ts.Node): void => {
    const kind = zodObjectKind(node);
    if (kind === "object" && !hasStrictOnChain(node)) open += 1;
    ts.forEachChild(node, walk);
  };
  walk(source);
  return open;
}

const inventory = new Map<string, number>();
for (const file of routeFiles(API_ROOT)) {
  const open = openSchemaCount(file);
  if (open > 0) inventory.set(relative(API_ROOT, file), open);
}

describe("inline request-schema strictness inventory", () => {
  it("finds the schemas at all", () => {
    // A sweep that matches nothing passes every other assertion in this
    // file. Pin a floor so an accidentally-broken matcher fails loudly
    // instead of reporting a clean tree.
    expect(inventory.size).toBeGreaterThan(20);
  });

  it("accounts for every open schema with a written reason", () => {
    const unaccounted: string[] = [];
    for (const [file, open] of inventory) {
      const entry = DELIBERATELY_OPEN[file];
      if (!entry) {
        unaccounted.push(
          `${file}: ${open} schema(s) without .strict() and no entry in DELIBERATELY_OPEN`,
        );
        continue;
      }
      if (entry.count !== open) {
        unaccounted.push(
          `${file}: ${open} open schema(s) but DELIBERATELY_OPEN records ${entry.count}`,
        );
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it("carries no stale register entries", () => {
    const stale = Object.keys(DELIBERATELY_OPEN).filter(
      (file) => !inventory.has(file),
    );
    expect(stale).toEqual([]);
  });

  it("gives every register entry a reason", () => {
    const empty = Object.entries(DELIBERATELY_OPEN)
      .filter(([, entry]) => entry.reason.trim().length < 10)
      .map(([file]) => file);
    expect(empty).toEqual([]);
  });
});
