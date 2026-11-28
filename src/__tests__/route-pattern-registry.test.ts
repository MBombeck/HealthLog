/**
 * Every route is in the pattern registry, and the registry agrees with the
 * budget files (design system 2, G1).
 *
 * Nothing used to connect a `page.tsx` to a pattern, an owner or a budget,
 * so a new or forgotten route fell out of the coverage map unnoticed. The
 * map is `fixtures/route-patterns.ts`; this guard holds it to the tree.
 *
 * - The route list is every `src/app/**\/page.tsx` on disk, route groups
 *   `(x)` stripped, dynamic segments kept as written, with
 *   `/settings/[section]` and `/admin/[section]` replaced by one route per
 *   section slug.
 * - A route without an entry fails, an entry without a route fails, and so
 *   do an unknown pattern or owner.
 * - A numeric budget must equal the budget file's number; a route missing
 *   from a budget file must carry a reason string instead, and a route the
 *   file measures must carry the number, not a reason.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import heightBudgets from "../../e2e/mobile-height-budgets.json";
import textBudgets from "../../e2e/text-budgets.json";

import { ADMIN_SECTION_SLUGS } from "@/components/admin/section-slugs";
import { SETTINGS_SECTION_SLUGS } from "@/lib/settings/section-slugs";

import {
  OWNERS,
  PATTERNS,
  ROUTE_PATTERNS,
  type RouteEntry,
} from "./fixtures/route-patterns";
import { walkSourceFiles } from "./helpers/source-files";

const APP = join(process.cwd(), "src/app");

function routeOf(pageFile: string): string {
  const segments = pageFile
    .split("/")
    .slice(0, -1)
    .filter((s) => !/^\(.*\)$/.test(s));
  return `/${segments.join("/")}`;
}

function diskRoutes(): string[] {
  const pages = walkSourceFiles(APP, { floor: 100, extensions: [".tsx"] })
    .filter((rel) => rel === "page.tsx" || rel.endsWith("/page.tsx"))
    .map(routeOf);
  const routes = new Set(pages);
  const expand = (dynamic: string, slugs: readonly string[]) => {
    if (!routes.delete(dynamic))
      throw new Error(`${dynamic} is no longer on disk; update the guard`);
    for (const slug of slugs) routes.add(dynamic.replace("[section]", slug));
  };
  expand("/settings/[section]", SETTINGS_SECTION_SLUGS);
  expand("/admin/[section]", ADMIN_SECTION_SLUGS);
  return [...routes].sort();
}

const TEXT = textBudgets.pages as Record<string, number>;
const HEIGHT = heightBudgets.pages as Record<string, { budget: number }>;

/** `/settings/layout/dashboard` is an instance of `/settings/layout/[module]`. */
function instanceOf(route: string, dynamicRoutes: string[]): boolean {
  const parts = route.split("/");
  return dynamicRoutes.some((d) => {
    const pattern = d.split("/");
    return (
      pattern.length === parts.length &&
      pattern.every(
        (seg, i) =>
          (seg.startsWith("[") && seg.endsWith("]")) || seg === parts[i],
      )
    );
  });
}

describe("route pattern registry", () => {
  const routes = diskRoutes();
  const entries = Object.entries(ROUTE_PATTERNS) as [string, RouteEntry][];
  const dynamicRoutes = routes.filter((r) => r.includes("["));
  const measured = new Set([...Object.keys(TEXT), ...Object.keys(HEIGHT)]);

  it("walks the app tree", () => {
    expect(routes.length).toBeGreaterThan(140);
  });

  it("has an entry for every route on disk", () => {
    expect(routes.filter((r) => !(r in ROUTE_PATTERNS))).toEqual([]);
  });

  it("has a route on disk for every entry", () => {
    const onDisk = new Set(routes);
    expect(
      entries
        .map(([r]) => r)
        .filter(
          (r) =>
            !onDisk.has(r) &&
            !(measured.has(r) && instanceOf(r, dynamicRoutes)),
        ),
    ).toEqual([]);
  });

  it("uses only known patterns and owners", () => {
    const patterns = new Set<string>(PATTERNS);
    const owners = new Set<string>(OWNERS);
    expect(
      entries
        .filter(([, e]) => !patterns.has(e.pattern) || !owners.has(e.owner))
        .map(([r, e]) => `${r}: ${e.pattern} / ${e.owner}`),
    ).toEqual([]);
  });

  it("carries the text budget of e2e/text-budgets.json, or a reason", () => {
    const wrong = entries.flatMap(([r, { textBudget }]) => {
      if (r in TEXT)
        return textBudget === TEXT[r]
          ? []
          : [`${r}: ${textBudget} ≠ ${TEXT[r]}`];
      return typeof textBudget === "string" && textBudget.length > 0
        ? []
        : [`${r}: ${textBudget} but not in text-budgets.json`];
    });
    expect(wrong).toEqual([]);
  });

  it("carries the height budget of e2e/mobile-height-budgets.json, or a reason", () => {
    const wrong = entries.flatMap(([r, { heightBudget }]) => {
      if (r in HEIGHT)
        return heightBudget === HEIGHT[r].budget
          ? []
          : [`${r}: ${heightBudget} ≠ ${HEIGHT[r].budget}`];
      return typeof heightBudget === "string" && heightBudget.length > 0
        ? []
        : [`${r}: ${heightBudget} but not in mobile-height-budgets.json`];
    });
    expect(wrong).toEqual([]);
  });

  it("knows every route a budget file measures", () => {
    expect([...measured].filter((r) => !(r in ROUTE_PATTERNS))).toEqual([]);
  });
});
