/**
 * No client list or picker with a fixed row cap and nothing to reach past it.
 *
 * A client read that asks for "the newest N" and renders the answer as the
 * whole list loses everything beyond N without a word: the Labs list asked
 * for 500 raw rows and grouped them in the browser, so on a long history
 * every marker measured only long ago had no row at all. The visit-form lab
 * picker was the same class before it, and the GLP-1 curve, the side-effect
 * log and the symptom timeline each had a quieter copy.
 *
 * The rule: every literal `limit=<number>` a client fetch sends either sits
 * beside a pager (an `offset` / `cursor` / `pageParam` within a few lines, or
 * a `useInfiniteQuery` in the file), or is listed below with the reason the
 * cap cannot cut anything off.
 *
 * Only code counts as a pager. A comment that says "offset" sends nothing,
 * and an offset pinned to a literal `0` is the opposite of paging: it asks
 * for the first page and nothing else. The day-grouped measurement list
 * passed this guard in exactly that shape (#1245), `limit` 5000 between a
 * comment about pagination and `offset` "0", while it drew every day of a
 * long history on one page and lost the days past the cap.
 *
 * What it matches: `limit=<digits>` inside a URL string, and the two
 * `URLSearchParams` spellings, `.set("limit", "<digits>")` and
 * `limit: "<digits>"`. What it does not: a limit routed through a named
 * constant (`limit=${PAGE_SIZE}`), which is a deliberate page size in every
 * case today. It walks client code only (`components/`, `hooks/`, and `app/`
 * outside `app/api/`); a server-side `take` is not a fetch.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

interface Allowed {
  file: string;
  limit: number;
  reason: string;
}

const ALLOWLIST: readonly Allowed[] = [
  {
    file: "app/labs/page.tsx",
    limit: 1,
    reason:
      "Deep-link resolution: the newest reading under one analyte name, used only to find its marker page.",
  },
  {
    file: "components/onboarding/first-result-screen.tsx",
    limit: 1,
    reason: "Asks only whether a type has a reading, and which is newest.",
  },
  {
    file: "components/insights/glp1-substance-curve-summary.tsx",
    limit: 1,
    reason:
      "Reads only `medications`, which lists every GLP-1 medication whatever the entry cap; the entries are not used.",
  },
  {
    file: "components/charts/chart-series-request.ts",
    limit: 5000,
    reason:
      "Daily rollup buckets: one row per day, and the widest window (All, 3,650 days, plus a 365-day comparison) is 4,015 days.",
  },
  {
    file: "components/insights/trend-annotation.tsx",
    limit: 5000,
    reason: "Daily rollup buckets over a 30-day window: at most 31 rows.",
  },
  {
    file: "components/insights/coach-panel/attachment-picker.tsx",
    limit: 50,
    reason:
      "Search-backed picker: the query narrows the whole document vault server-side.",
  },
  {
    file: "components/documents/document-picker-sheet.tsx",
    limit: 50,
    reason:
      "Search-backed picker (episode links and share links): the query narrows the whole document vault server-side.",
  },
  {
    file: "hooks/use-mood-day.ts",
    limit: 50,
    reason:
      "One calendar day of mood entries; fifty check-ins in a day is beyond any cadence the app offers.",
  },
];

const LIMIT_PATTERNS: readonly RegExp[] = [
  /[?&]limit=(\d+)/g,
  /\.set\(\s*["']limit["']\s*,\s*["'](\d+)["']\s*\)/g,
  /\blimit:\s*["'](\d+)["']/g,
];

const PAGER_NEARBY = /\boffset\b|\bcursor\b|\bpageParam\b/;
const PAGER_LINES = 3;

/**
 * The line as code a pager could live in: every offset pinned to a literal
 * zero removed, in the URL spelling and both `URLSearchParams` spellings.
 * The lines come comment-free from `stripComments`.
 */
function pagerCode(text: string): string {
  return text
    .replace(/[?&]offset=0(?!\d)/g, "")
    .replace(/\.set\(\s*["']offset["']\s*,\s*["']0["']\s*\)/g, "")
    .replace(/\boffset:\s*["']?0["']?(?![\d.])/g, "");
}

function clientFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter(
      (p) =>
        p.startsWith("components/") ||
        p.startsWith("hooks/") ||
        (p.startsWith("app/") && !p.startsWith("app/api/")),
    )
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .sort();
}

interface Hit {
  file: string;
  line: number;
  limit: number;
  paged: boolean;
}

/** Every literal limit in the given source, with whether a pager is beside it. */
function findLimitHits(file: string, source: string): Hit[] {
  // Comments describe old shapes; they send nothing.
  const lines = stripComments(source, file).split("\n");
  const infinite = /\buseInfiniteQuery\b/.test(source);
  const hits: Hit[] = [];
  lines.forEach((text, index) => {
    for (const pattern of LIMIT_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const near = lines
          .slice(Math.max(0, index - PAGER_LINES), index + PAGER_LINES + 1)
          .map(pagerCode)
          .join("\n");
        hits.push({
          file,
          line: index + 1,
          limit: Number(match[1]),
          paged: infinite || PAGER_NEARBY.test(near),
        });
      }
    }
  });
  return hits;
}

function allHits(): Hit[] {
  return clientFiles().flatMap((file) =>
    findLimitHits(file, readSourceText(join(SRC, file))),
  );
}

function isAllowed(hit: Hit): boolean {
  return ALLOWLIST.some((a) => a.file === hit.file && a.limit === hit.limit);
}

describe("client fetch limits", () => {
  it("finds the literal limits it is meant to police", () => {
    // An empty sweep would agree with any allowlist. Every allowlisted cap is
    // a live hit, so the hit set can never be smaller than the list.
    expect(allHits().length).toBeGreaterThanOrEqual(ALLOWLIST.length);
  });

  it("puts every fixed limit beside a pager or on the allowlist", () => {
    const offenders = allHits()
      .filter((hit) => !hit.paged && !isAllowed(hit))
      .map((hit) => `${hit.file}:${hit.line} limit=${hit.limit}`);
    expect(
      offenders,
      "A client fetch with a fixed limit loses everything past it. Page it (offset / cursor / useInfiniteQuery), move the grouping server-side, or add an allowlist entry that says why the cap cannot cut anything off.",
    ).toEqual([]);
  });

  it("keeps no allowlist entry that no longer matches anything", () => {
    const hits = allHits();
    const stale = ALLOWLIST.filter(
      (a) => !hits.some((h) => h.file === a.file && h.limit === a.limit),
    ).map((a) => `${a.file} limit=${a.limit}`);
    expect(stale).toEqual([]);
  });

  it("gives every allowlist entry a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length, entry.file).toBeGreaterThan(20);
    }
  });

  it("flags the shape that dropped markers from the Labs list", () => {
    const hits = findLimitHits(
      "components/labs/lab-list.tsx",
      'apiGet("/api/labs?limit=500&sortDir=desc")',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].paged).toBe(false);
    expect(isAllowed(hits[0])).toBe(false);
  });

  // #1245 — the day-grouped measurement list as it stood: a wide limit, a
  // comment that talks about the offset, and the offset pinned to zero.
  // Neither of the two is a pager.
  it("flags the shape the day-grouped measurement list had", () => {
    const hits = findLimitHits(
      "components/measurements/measurement-list.tsx",
      [
        "      if (isCumulativeFilter) {",
        '        params.set("groupBy", "day");',
        "        // pagination/offset don't apply on the server side.",
        '        params.set("limit", "5000");',
        "        // Reset the offset so a sort flip stays on the first page.",
        '        params.set("offset", "0");',
        "      }",
      ].join("\n"),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].limit).toBe(5000);
    expect(hits[0].paged).toBe(false);
  });

  it("counts neither a comment nor a zero offset as a pager, in any spelling", () => {
    const shapes = [
      'apiGet("/api/x?limit=500&offset=0")',
      'apiGet("/api/x?limit=500") // the offset is fixed',
      '/* offset */ apiGet("/api/x?limit=500")',
      'new URLSearchParams({ limit: "500", offset: "0" })',
      'new URLSearchParams({ limit: "500", offset: 0 })',
    ];
    for (const shape of shapes) {
      const hits = findLimitHits("components/example.tsx", shape);
      expect(hits, shape).toHaveLength(1);
      expect(hits[0].paged, shape).toBe(false);
    }
  });

  it("still accepts an offset that is a page, beside a zero elsewhere", () => {
    const shapes = [
      "fetch(`/api/x?limit=100&offset=${(page - 1) * 100}`)",
      'params.set("limit", "100");\nparams.set("offset", String(offset));',
      'apiGet("/api/x?limit=100&offset=10")',
    ];
    for (const shape of shapes) {
      const hits = findLimitHits("components/example.tsx", shape);
      expect(hits, shape).toHaveLength(1);
      expect(hits[0].paged, shape).toBe(true);
    }
  });

  it("accepts a limit that travels with an offset", () => {
    const hits = findLimitHits(
      "components/example.tsx",
      "fetch(`/api/x?status=taken&limit=100&offset=${offset}`)",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].paged).toBe(true);
  });
});
