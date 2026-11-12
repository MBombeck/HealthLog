/**
 * Every Settings address a person ever had keeps working.
 *
 * Settings has been regrouped many times (v1.4 split, v1.17 layout hub,
 * v1.25 Darstellung, v1.44 nine groups), and every bookmark, cross-link in
 * an older notification and docs page still points at one of those shapes.
 * This walks the full list of historical `/settings/*` addresses through the
 * redirects in `next.config.ts` and asserts each one lands on a route that
 * renders: a section slug, an Arrangement sub-page or a module page. It does
 * the same for the anchors a page forwards client-side when a card moved
 * while its page stayed (`settings-anchor-forward.tsx`).
 *
 * A route removed without a redirect, a redirect pointing at a page that no
 * longer exists, or a forward whose target 404s fails here by name.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";
import { SETTINGS_SECTION_SLUGS } from "@/lib/settings/section-slugs";
import { LAYOUT_GROUP_IDS } from "@/components/settings/layout-groups";
import { MODULE_SETTINGS_PAGE_IDS } from "@/components/settings/module-settings-page-ids";
import {
  SETTINGS_ANCHOR_FORWARDS,
  forwardedAnchorTarget,
} from "@/components/settings/settings-anchor-forward";

/** Every Settings path that was ever reachable, newest shapes included. */
const HISTORICAL_SETTINGS_PATHS: readonly string[] = [
  "/settings",
  // Section slugs of every release since the v1.4 split.
  "/settings/account",
  "/settings/security",
  "/settings/access",
  "/settings/modules",
  "/settings/integrations",
  "/settings/sources",
  "/settings/channels",
  "/settings/notifications",
  "/settings/reminders",
  "/settings/layout",
  "/settings/environment",
  "/settings/anamnesis",
  "/settings/score",
  "/settings/thresholds",
  "/settings/ai",
  "/settings/coach",
  "/settings/api",
  "/settings/mcp",
  "/settings/gesundheitsakte",
  "/settings/health-record",
  "/settings/sharing",
  "/settings/export",
  "/settings/advanced",
  "/settings/privacy",
  "/settings/about",
  // The per-module personalisation slugs before the layout hub.
  "/settings/dashboard",
  "/settings/insights",
  "/settings/medications",
  "/settings/mood",
  "/settings/labs",
  "/settings/illness",
  "/settings/vorsorge",
  // Layout hub sub-pages since v1.25.11.
  "/settings/layout/dashboard",
  "/settings/layout/insights",
  "/settings/layout/medications",
  "/settings/layout/mood",
  "/settings/layout/labs",
  "/settings/layout/illness",
  "/settings/layout/documents",
  "/settings/layout/vorsorge",
  "/settings/layout/checkups",
];

interface Redirect {
  source: string;
  destination: string;
}

async function settingsRedirects(): Promise<Redirect[]> {
  const all = (await nextConfig.redirects?.()) ?? [];
  return all
    .filter((r) => r.source.startsWith("/settings"))
    .map((r) => ({ source: r.source, destination: r.destination }));
}

/** Follow exact-match redirects until none applies; the hash is dropped. */
function resolve(path: string, redirects: readonly Redirect[]): string {
  let current = path;
  for (let hop = 0; hop < 5; hop += 1) {
    const next = redirects.find((r) => r.source === current);
    if (!next) return current;
    current = next.destination.split("#")[0]!;
  }
  throw new Error(`redirect loop from ${path}`);
}

/** Does a path (no hash) render a Settings page? */
function renders(path: string): boolean {
  if (path === "/settings") return true; // the page redirects to account
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "settings") return false;
  if (parts.length === 2) {
    return (SETTINGS_SECTION_SLUGS as readonly string[]).includes(parts[1]!);
  }
  if (parts.length === 3 && parts[1] === "layout") {
    return LAYOUT_GROUP_IDS.includes(parts[2]!);
  }
  if (parts.length === 3 && parts[1] === "modules") {
    return (MODULE_SETTINGS_PAGE_IDS as readonly string[]).includes(parts[2]!);
  }
  return false;
}

describe("historical Settings addresses", () => {
  it("reads the redirects from next.config.ts (an empty read is a broken matcher)", async () => {
    const redirects = await settingsRedirects();
    expect(redirects.length).toBeGreaterThanOrEqual(10);
  });

  it.each(HISTORICAL_SETTINGS_PATHS)(
    "%s still lands on a page",
    async (path) => {
      const redirects = await settingsRedirects();
      const landed = resolve(path, redirects);
      expect(renders(landed), `${path} → ${landed}`).toBe(true);
    },
  );

  it("every redirect into Settings points at a page that renders", async () => {
    for (const r of await settingsRedirects()) {
      const target = r.destination.split("#")[0]!;
      expect(renders(target), `${r.source} → ${r.destination}`).toBe(true);
    }
  });

  it("every routable section, sub-page and module page is on the list", () => {
    const routable = [
      ...SETTINGS_SECTION_SLUGS.map((s) => `/settings/${s}`),
      ...LAYOUT_GROUP_IDS.map((id) => `/settings/layout/${id}`),
      ...MODULE_SETTINGS_PAGE_IDS.map((id) => `/settings/modules/${id}`),
    ];
    // New routes join the list when they ship, so a later move cannot drop
    // one silently. Module pages are new in v1.44 and are allowed here.
    const listed = new Set(HISTORICAL_SETTINGS_PATHS);
    const unlisted = routable.filter(
      (path) => !listed.has(path) && !path.startsWith("/settings/modules/"),
    );
    expect(unlisted).toEqual([]);
  });

  it("sends the old German addresses to their English ones", async () => {
    const redirects = await settingsRedirects();
    expect(resolve("/settings/gesundheitsakte", redirects)).toBe(
      "/settings/health-record",
    );
    expect(resolve("/settings/sharing", redirects)).toBe(
      "/settings/health-record",
    );
    expect(resolve("/settings/layout/vorsorge", redirects)).toBe(
      "/settings/layout/checkups",
    );
    expect(resolve("/settings/vorsorge", redirects)).toBe(
      "/settings/layout/checkups",
    );
  });

  it("keeps the v1.44 moves addressable", async () => {
    const redirects = await settingsRedirects();
    expect(resolve("/settings/layout/mood", redirects)).toBe(
      "/settings/modules/mood",
    );
    expect(resolve("/settings/mood", redirects)).toBe("/settings/modules/mood");
  });
});

const SRC = join(process.cwd(), "src");

/** The component file a Settings page renders from. */
function entryFilesFor(page: string): string[] {
  const parts = page.split("/").filter(Boolean);
  if (parts.length === 2) {
    const loader = readFileSync(
      join(SRC, "components/settings/settings-section-loader.tsx"),
      "utf8",
    );
    const match = new RegExp(
      `(?:^|\\s)"?${parts[1]}"?:\\s*\\(\\)\\s*=>\\s*import\\("@/([^"]+)"\\)`,
      "m",
    ).exec(loader);
    return match ? [resolveModule(match[1]!)].filter(isString) : [];
  }
  if (parts[1] === "modules") {
    return [join(SRC, "components/settings/module-settings-pages.tsx")];
  }
  if (parts[1] === "layout") {
    return [join(SRC, "components/settings/layout-section.tsx")];
  }
  return [];
}

function isString(value: string | null): value is string {
  return value !== null;
}

function resolveModule(spec: string, from?: string): string | null {
  const base = spec.startsWith(".")
    ? join(dirname(from!), spec)
    : join(SRC, spec.replace(/^@\//, ""));
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * Does any component reachable from `entries` render `anchor`, as a card
 * header's `anchor` prop or an element id? Walks the component imports only
 * (`@/components/...` and relative), which is where a card's anchor lives.
 */
function anchorIsRendered(entries: string[], anchor: string): boolean {
  const pattern = new RegExp(`(?:anchor|id)=["{]+"?${anchor}"`);
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0 && seen.size < 600) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    if (pattern.test(text)) return true;
    for (const m of text.matchAll(/from\s+"((?:@\/components\/|\.)[^"]+)"/g)) {
      const next = resolveModule(m[1]!, file);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return false;
}

describe("anchors forwarded after a card moved", () => {
  const forwards = Object.entries(SETTINGS_ANCHOR_FORWARDS).flatMap(
    ([page, anchors]) =>
      Object.entries(anchors).map(([anchor, target]) => ({
        page,
        anchor,
        target,
      })),
  );

  it("has forwards to check", () => {
    expect(forwards.length).toBeGreaterThanOrEqual(8);
  });

  it.each(forwards)(
    "$page#$anchor forwards to a page that renders",
    ({ page, anchor, target }) => {
      expect(renders(page), page).toBe(true);
      expect(forwardedAnchorTarget(page, `#${anchor}`)).toBe(target);
      expect(renders(target.split("#")[0]!), target).toBe(true);
    },
  );

  it.each(forwards)(
    "$target carries the anchor it is forwarded to",
    ({ target }) => {
      const [page, anchor] = target.split("#");
      if (!anchor) return;
      const entries = entryFilesFor(page!);
      expect(entries.length, page).toBeGreaterThan(0);
      expect(
        anchorIsRendered(entries, anchor),
        `${anchor} not found on ${page}`,
      ).toBe(true);
    },
  );

  it("the anchor search finds a known anchor and misses a made-up one", () => {
    const entries = entryFilesFor("/settings/security");
    expect(anchorIsRendered(entries, "sessions")).toBe(true);
    expect(anchorIsRendered(entries, "no-such-anchor-anywhere")).toBe(false);
  });

  it("leaves an anchor that did not move alone", () => {
    expect(forwardedAnchorTarget("/settings/privacy", "#retention")).toBeNull();
    expect(forwardedAnchorTarget("/settings/security", "#sessions")).toBeNull();
    expect(forwardedAnchorTarget("/settings/privacy", "")).toBeNull();
  });
});
