/**
 * Structural guard: work a request starts and does not wait for is started
 * through `runDetached`, so it cannot rename the request's wide event.
 *
 * Detached work runs inside the request's context. Before `runDetached`, an
 * `annotate({ action })` from it landed on the request's event whenever it
 * ran before the event was emitted: the measurement tail's status re-warm
 * logged a hand-entered reading as `insights.status.invalidate.skipped` on
 * some requests and as `measurement.create` on others.
 *
 * Two shapes start detached work. `fireAndForget` takes a function and
 * starts it detached itself (its signature makes a running promise a type
 * error). `trackBackgroundTask` registers a handle, so every call outside
 * the logging module has to build that handle with `runDetached`, unless the
 * file is listed below with the reason no request can be its caller.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder, stripComments } from "./helpers/source-files";

/** Files whose detached work never starts inside a request, and why. */
const NO_REQUEST_CALLER: Record<string, string> = {
  "lib/db-session.ts":
    "the pool's connect hook pins the session time zone; it annotates nothing",
  "lib/pwa/query-persister.ts":
    "runs in the browser, where there is no wide event (and no async_hooks)",
  "lib/jobs/reminder/climb-backfill-at-boot.ts":
    "started once at worker boot, outside any request",
};

/** The argument text of every `trackBackgroundTask(...)` call in `code`. */
export function trackedHandles(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\btrackBackgroundTask\s*\(/g)) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (depth > 0 && i < code.length) {
      if (code[i] === "(") depth += 1;
      else if (code[i] === ")") depth -= 1;
      i += 1;
    }
    out.push(code.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

const startsDetached = (handle: string) => /^\s*runDetached\s*\(/.test(handle);

describe("detached work cannot rename the request's event", () => {
  const files = readSourceFolder("src", {
    floor: 3000,
    include: (rel) =>
      !rel.startsWith("generated/") &&
      !rel.startsWith("lib/logging/") &&
      !rel.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(rel),
  });
  const calls = files.flatMap(([rel, text]) =>
    trackedHandles(stripComments(text)).map((handle) => ({ rel, handle })),
  );

  it("finds the detached starts it polices", () => {
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.map((c) => c.rel)).toContain(
      "lib/rollups/after-measurement-mutation.ts",
    );
  });

  it("starts every request-path handle with runDetached", () => {
    const offenders = calls
      .filter((c) => !(c.rel in NO_REQUEST_CALLER))
      .filter((c) => !startsDetached(c.handle))
      .map((c) => `${c.rel}: ${c.handle.replace(/\s+/g, " ").slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  it("lists no file that stopped starting detached work", () => {
    const callers = new Set(calls.map((c) => c.rel));
    expect(
      Object.keys(NO_REQUEST_CALLER).filter((rel) => !callers.has(rel)),
    ).toEqual([]);
  });

  it("the matcher reads a nested handle and tells the two shapes apart", () => {
    const [plain, detached] = trackedHandles(
      "trackBackgroundTask(work(a, b(c)).catch(() => {}));\n" +
        "trackBackgroundTask(runDetached(() => work()).catch(() => {}));",
    );
    expect(plain).toBe("work(a, b(c)).catch(() => {})");
    expect(startsDetached(plain)).toBe(false);
    expect(startsDetached(detached)).toBe(true);
  });
});

/**
 * Read-path work a request starts and never awaits. Each of these runs real
 * statements against Postgres after the response is already on its way, so a
 * bare `void` hides it from `settleBackgroundTasks()`: the statement counter
 * then closes its window while a stale account's rollup recompute is still
 * writing, and the next test inherits the tail. The dashboard summary budget
 * read 30 against 28 that way, depending on which side of the window a full
 * mood recompute landed.
 */
const READ_PATH_BACKGROUND_STARTERS = [
  "ensureUserRollupsFresh",
  "ensureUserMoodRollupsFresh",
  "requestTodayBriefingWarm",
  "touchGrantUsage",
  "recordDelegatedAccess",
] as const;

describe("read-path background work is registered", () => {
  const files = readSourceFolder("src", {
    floor: 3000,
    include: (rel) =>
      !rel.startsWith("generated/") &&
      !rel.includes("__tests__/") &&
      !/\.test\.tsx?$/.test(rel),
  });
  const bare = new RegExp(
    String.raw`\bvoid\s+(${READ_PATH_BACKGROUND_STARTERS.join("|")})\s*\(`,
  );

  it("starts none of them with a bare void", () => {
    const offenders = files.flatMap(([rel, text]) =>
      stripComments(text)
        .split("\n")
        .flatMap((line, i) => (bare.test(line) ? [`src/${rel}:${i + 1}`] : [])),
    );
    expect(
      offenders,
      "wrap the call in trackBackgroundTask(runDetached(() => ...)) or " +
        "fireAndForget(...) so the suite can await it",
    ).toEqual([]);
  });

  it("still finds each starter at a detached call site", () => {
    const joined = files.map(([, text]) => stripComments(text)).join("\n");
    for (const name of READ_PATH_BACKGROUND_STARTERS) {
      expect(
        new RegExp(String.raw`=>\s*${name}\s*\(`).test(joined),
        `${name} is no longer started detached anywhere; drop it from the list`,
      ).toBe(true);
    }
  });
});
