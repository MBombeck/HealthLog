/**
 * "Last night" has one definition: `@/lib/sleep/last-night`
 * (`lastNightOnRecord`, `isLastNight`, `resolveLastNight`). The morning, the
 * digest, the snapshot adapter, the sleep score's `fresh` and every surface
 * reading them go through it.
 *
 * Two readings existed beside it. The fallback took the snapshot's newest
 * sleep row and filed it by the profile zone's calendar
 * (`userDayKey(lastSeenAt)`), so a nap counted as last night and a night
 * slept abroad landed a day off; and the digest got the night only when it
 * peeked into the morning's cache cell (`getAllowStale`), so a worker push
 * read the fallback while the page read the rule.
 *
 * Frozen here, comments stripped, whitespace-tolerant:
 *   1. no comparison of a night key with a today key (a `today…` name or a
 *      `userDayKey(…)` call) outside the rule module;
 *   2. under `src/lib/daily`, no `userDayKey(…lastSeenAt…)` and no peek into
 *      another reader's cell (`getAllowStale(`).
 * The rule module must still hold its own comparison, so a matcher that
 * drifted and finds nothing fails.
 *
 * Mutation check: put `fresh: latest.night === userDayKey(now, tz)` back in
 * `sleep-score.ts`, or `userDayKey(new Date(sleepSlot.lastSeenAt), tz)` in
 * `daily/last-night.ts`, and this goes red.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { scanSourceMatches } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");
const RULE = "lib/sleep/last-night.ts";
const notTest = (rel: string) => !/(^|\/)(__tests__|generated)\//.test(rel);

describe("last night has one definition", () => {
  it("compares a night with today only in the rule module", () => {
    const hits = scanSourceMatches(
      SRC,
      /\bnight\s*===\s*(?:[\w.]*[tT]oday\w*|userDayKey\s*\()|(?:\b[\w.]*[tT]oday\w*|\buserDayKey\s*\([^;]*?\))\s*===\s*[\w.]*\bnight\b/g,
      { fileFloor: 500, matchFloor: 1, stripComments: true, include: notTest },
    );
    expect(
      hits.filter((h) => h.file !== RULE).map((h) => `${h.file}:${h.line}`),
    ).toEqual([]);
    expect(hits.some((h) => h.file === RULE)).toBe(true);
  });

  it("reads no calendar day off the snapshot's newest row and peeks into no cell under src/lib/daily", () => {
    const hits = scanSourceMatches(
      SRC,
      /\buserDayKey\s*\([^;]*?lastSeenAt|\bgetAllowStale\s*\(/g,
      { fileFloor: 500, matchFloor: 1, stripComments: true, include: notTest },
    );
    expect(
      hits
        .filter((h) => h.file.startsWith("lib/daily/"))
        .map((h) => `${h.file}:${h.line}`),
    ).toEqual([]);
    // Non-zero proof: the cache's own stale read is still found.
    expect(hits.some((h) => h.file === "lib/cache/server-cache.ts")).toBe(true);
  });
});
