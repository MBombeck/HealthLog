/**
 * THE RULE: every surface is found where people look for it.
 *
 * A page or a Settings card that exists but has no way in is a feature nobody
 * finds; the emergency card shipped with one sentence link at the bottom of a
 * Settings page, and the search palette knew none of the release's new
 * surfaces, because its index was a hand-kept list. The surface registry
 * (`src/components/layout/surface-registry.ts`) is now the one list, and this
 * guard holds it to four things:
 *
 *   1. Complete. Every page route outside sign-in, Admin, Settings and the
 *      public pages is a registry entry or a declared child of one; every
 *      Settings card that carries a deep-link anchor is an entry or declared
 *      not to need one.
 *   2. Entered. Every entry has a navigation, menu, Settings or Admin row.
 *   3. Searchable. Every entry is in the palette's index, and is found by its
 *      own name in each of the ten languages, and by each of its search words.
 *   4. Named. Every entry's name, and its search words, exist in all ten
 *      locales.
 *
 * Context links (the row under a page's header) point at registry entries and
 * read exactly like them.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readSourceFolder,
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "@/__tests__/helpers/source-files";
import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { buildPaletteIndex } from "@/components/command-palette/build-index";
import { CONTEXT_LINKS } from "@/components/layout/context-links";
import {
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
} from "@/components/layout/nav-model";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-shell";
import {
  SETTINGS_LAYOUT_PAGES,
  SETTINGS_MODULE_PAGES,
} from "@/lib/command-palette/settings-cards";
import { rankEntries } from "@/lib/command-palette/rank";
import { locales } from "@/lib/i18n/config";
import { MODULE_REGISTRY, type ModuleKey } from "@/lib/modules/registry";
import {
  SURFACE_REGISTRY,
  type SurfaceEntry,
} from "@/components/layout/surface-registry";

import de from "../../messages/de.json";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import fr from "../../messages/fr.json";
import it_ from "../../messages/it.json";
import ko from "../../messages/ko.json";
import nl from "../../messages/nl.json";
import pl from "../../messages/pl.json";
import ptBR from "../../messages/pt-BR.json";
import ru from "../../messages/ru.json";

const ROOT = process.cwd();

type Messages = Record<string, unknown>;
const MESSAGES: Record<string, Messages> = {
  de,
  en,
  es,
  fr,
  it: it_,
  ko,
  nl,
  pl,
  "pt-BR": ptBR,
  ru,
};

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function translator(locale: string) {
  return (key: string) => lookup(MESSAGES[locale], key) ?? key;
}

/**
 * Everything on: an admin in their own record with every module on, plus the
 * destinations that exist only inside somebody else's record (the profile
 * summary), as a guardian of a managed profile sees them.
 */
function fullIndex(locale: string) {
  const allOn = Object.fromEntries(
    (Object.keys(MODULE_REGISTRY) as ModuleKey[]).map((key) => [key, true]),
  );
  const base = {
    t: translator(locale),
    modules: allOn,
    navModules: allOn,
    sections: null,
    isAdmin: true,
    settingsListed: () => true,
    canCapture: true,
    moduleToggles: [],
  };
  const own = buildPaletteIndex({ ...base, inSharedRecord: false });
  const ids = new Set(own.map((entry) => entry.id));
  const sharedOnly = buildPaletteIndex({
    ...base,
    inSharedRecord: true,
    record: { recordKind: "managed", level: "manage" },
  }).filter((entry) => !ids.has(entry.id));
  return [...own, ...sharedOnly];
}

// ── 1. Complete ──────────────────────────────────────────────────────────

/**
 * Route families that are not destinations: signing in, the public pages, the
 * setup flow, and the two shells whose own rails are their entries (checked
 * against `SETTINGS_SECTIONS` and `ADMIN_SECTIONS` below).
 */
const NOT_DESTINATIONS = [
  "/auth/",
  "/admin",
  "/settings",
  "/onboarding",
  "/c/",
  "/claim/",
  "/invite/",
  "/about",
  "/privacy",
  "/confirm-access",
  "/enroll-mfa",
];

/**
 * Pages reached from a parent page rather than a menu, each with the page
 * that links it. A record page under a dynamic segment (`/labs/[id]`) is
 * always a child of its list and needs no line here.
 */
const CHILD_PAGES: Readonly<Record<string, string>> = {
  "/care/practitioners": "/care",
  "/coach/conversations": "/coach",
  "/coach/plans": "/coach",
  "/documents/deleted": "/documents",
  "/medications/new": "/medications",
  "/insights/health-score": "/insights",
  "/insights/sources": "/insights",
};

const PAGE_ROUTES: readonly string[] = requireFloor(
  "app page routes",
  walkSourceFiles(join(ROOT, "src/app"), { floor: 100 })
    .filter((rel) => rel.endsWith("/page.tsx") || rel === "page.tsx")
    .map((rel) =>
      rel === "page.tsx" ? "/" : `/${rel.replace(/\/page\.tsx$/, "")}`,
    )
    .filter((route) => !route.startsWith("/api/")),
  100,
);

const registryHrefs = new Set(
  SURFACE_REGISTRY.map((entry) => entry.href.split("#")[0]),
);

describe("1. every page route is an entry or a declared child of one", () => {
  const destinations = PAGE_ROUTES.filter(
    (route) =>
      !route.includes("[") &&
      !NOT_DESTINATIONS.some(
        (prefix) => route === prefix || route.startsWith(prefix),
      ),
  );

  it("finds the routes at all", () => {
    expect(destinations.length).toBeGreaterThanOrEqual(40);
  });

  it.each(destinations)("%s", (route) => {
    const parent = CHILD_PAGES[route];
    if (parent !== undefined) {
      expect(registryHrefs.has(parent), `${route}'s parent ${parent}`).toBe(
        true,
      );
      return;
    }
    expect(
      registryHrefs.has(route),
      `${route} has no way in: add it to NAV_DESTINATIONS (or the Insights strip), or declare it in CHILD_PAGES with the page that links it`,
    ).toBe(true);
  });

  it("declares no child that is not a page", () => {
    for (const route of Object.keys(CHILD_PAGES)) {
      expect(PAGE_ROUTES).toContain(route);
    }
  });
});

/**
 * Settings anchors that are deliberately not their own search hit, each with
 * the reason.
 */
const UNINDEXED_ANCHORS: Readonly<Record<string, string>> = {
  "other-reminders":
    "A list of pointers to where reminders are set; the targets are entries.",
  "sessions-link": "A link to Security > Active sessions, which is the entry.",
  "emergency-card":
    "Settings > Health record's way to the emergency card, which is a navigation entry (`nav:/emergency-card`).",
};

const ANCHOR_SOURCES = [
  "src/components/settings",
  "src/components/records",
  "src/components/measurement-reminders",
  "src/components/labs",
];

const ANCHORS: readonly string[] = requireFloor(
  "settings anchors",
  [
    ...new Set(
      ANCHOR_SOURCES.flatMap((dir) =>
        readSourceFolder(dir, {
          floor: 5,
          include: (rel) => !rel.includes("__tests__"),
        }).flatMap(([rel, text]) =>
          [
            ...stripComments(text, rel).matchAll(
              /\banchor(?:=|: )"([a-z0-9-]+)"/g,
            ),
          ].map((m) => m[1]),
        ),
      ),
    ),
  ],
  70,
);

describe("1. every Settings card anchor is an entry or declared not to be", () => {
  const indexed = new Set(
    SURFACE_REGISTRY.flatMap((entry) =>
      entry.entry.kind === "settings-card" ? [entry.entry.anchor] : [],
    ),
  );

  it.each(ANCHORS)("#%s", (anchor) => {
    expect(
      indexed.has(anchor) || anchor in UNINDEXED_ANCHORS,
      `#${anchor} is a deep-link target nobody can search for: add it to SETTINGS_CARDS, or to UNINDEXED_ANCHORS with the reason`,
    ).toBe(true);
  });

  it("declares no exemption that is not an anchor", () => {
    for (const anchor of Object.keys(UNINDEXED_ANCHORS)) {
      expect(ANCHORS).toContain(anchor);
    }
  });
});

// ── 2. Entered ───────────────────────────────────────────────────────────

function entryPointExists(entry: SurfaceEntry): boolean {
  const point = entry.entry;
  switch (point.kind) {
    case "nav":
      return NAV_DESTINATIONS.some((d) => d.href === entry.href);
    case "menu":
      return NAV_UTILITY_DESTINATIONS.some((d) => d.href === entry.href);
    case "admin":
      return ADMIN_SECTIONS.some((s) => `/admin/${s.slug}` === entry.href);
    case "insights":
      return PAGE_ROUTES.includes(entry.href);
    case "settings-section":
      return SETTINGS_SECTIONS.some((s) => s.slug === point.slug);
    case "settings-card": {
      const [slug, page] = point.section.split("/");
      if (!SETTINGS_SECTIONS.some((s) => s.slug === slug)) return false;
      if (page === undefined) return true;
      const pages =
        slug === "modules" ? SETTINGS_MODULE_PAGES : SETTINGS_LAYOUT_PAGES;
      return pages.some((p) => p.slug === page);
    }
    case "settings-page": {
      const pages =
        point.parent === "modules"
          ? SETTINGS_MODULE_PAGES
          : SETTINGS_LAYOUT_PAGES;
      return pages.some((p) => p.slug === point.slug);
    }
  }
}

describe("2. every entry has a navigation, menu, Settings or Admin row", () => {
  it.each(SURFACE_REGISTRY.map((entry) => [entry.id, entry] as const))(
    "%s",
    (_id, entry) => {
      expect(entryPointExists(entry)).toBe(true);
    },
  );

  it("the emergency card is a destination, two taps from More on a phone", () => {
    expect(NAV_DESTINATIONS.map((d) => d.href)).toContain("/emergency-card");
  });
});

// ── 3. Searchable ────────────────────────────────────────────────────────

describe("3. every entry is in the palette and found by its name and words", () => {
  const indexByLocale = Object.fromEntries(
    locales.map((locale) => [locale, fullIndex(locale)]),
  );

  it("the palette lists every entry", () => {
    const ids = new Set(indexByLocale.en.map((entry) => entry.id));
    const missing = SURFACE_REGISTRY.map((entry) => entry.id).filter(
      (id) => !ids.has(id),
    );
    expect(missing).toEqual([]);
  });

  it.each(locales)("%s: each entry is found by its own name", (locale) => {
    const index = indexByLocale[locale];
    const t = translator(locale);
    const lost = SURFACE_REGISTRY.filter((entry) => {
      const hits = rankEntries(t(entry.labelKey), index);
      return !hits.some((hit) => hit.id === entry.id);
    }).map((entry) => entry.id);
    expect(lost).toEqual([]);
  });

  it.each(locales)("%s: each entry is found by each of its words", (locale) => {
    const index = indexByLocale[locale];
    const t = translator(locale);
    const lost: string[] = [];
    for (const entry of SURFACE_REGISTRY) {
      if (!entry.keywordsKey) continue;
      for (const word of t(entry.keywordsKey).split(",")) {
        const query = word.trim();
        if (!query) continue;
        const hits = rankEntries(query, index);
        if (!hits.some((hit) => hit.id === entry.id)) {
          lost.push(`${entry.id} by "${query}"`);
        }
      }
    }
    expect(lost).toEqual([]);
  });

  // The surfaces 1.49.0 added, by the word somebody types for them. Each was
  // missing from the hand-kept list the palette read before the registry.
  it.each([
    ["emergency card", "nav:/emergency-card"],
    ["leaflet", "settings:modules/medications#medicine-registry"],
    ["snooze", "settings:notifications#dose-snooze"],
    ["dark mode", "settings:account#theme"],
    ["gadgetbridge", "settings:export#import-gadgetbridge"],
    ["lasting change", "settings:notifications#lasting-change"],
    ["security alerts", "settings:notifications#security-alerts"],
    ["care calendar", "settings:health-record#calendar"],
    ["nextcloud", "settings:integrations#import-health-connect-remote"],
    ["who can reach", "settings:privacy#who-has-access"],
    ["migrations", "admin:system-status"],
  ])("en: %s finds %s first", (query, id) => {
    expect(rankEntries(query, indexByLocale.en)[0]?.id).toBe(id);
  });
});

// ── 4. Named ─────────────────────────────────────────────────────────────

describe("4. every entry's name and search words exist in all ten locales", () => {
  it.each(locales)("%s", (locale) => {
    const missing = SURFACE_REGISTRY.flatMap((entry) =>
      [entry.labelKey, entry.keywordsKey]
        .filter((key): key is string => key !== undefined)
        .filter((key) => !lookup(MESSAGES[locale], key)?.trim()),
    );
    expect(missing).toEqual([]);
  });
});

// ── Context links ────────────────────────────────────────────────────────

describe("context links point at registry entries and read like them", () => {
  const byId = new Map(SURFACE_REGISTRY.map((entry) => [entry.id, entry]));
  const links = Object.entries(CONTEXT_LINKS).flatMap(([page, list]) =>
    list.map((link) => [page, link.surface, link] as const),
  );

  it.each(links)("%s → %s", (_page, surface, link) => {
    const entry = byId.get(surface);
    expect(entry, `${surface} is not in the registry`).toBeDefined();
    expect(link.href).toBe(entry?.href);
    expect(link.labelKey).toBe(entry?.labelKey);
  });

  it.each(Object.keys(CONTEXT_LINKS))("%s mounts its row", (page) => {
    const sources = readSourceFolder("src/components", {
      floor: 500,
      include: (rel) => !rel.includes("__tests__"),
    })
      .map(([, text]) => text)
      .join("\n");
    expect(sources).toContain(`<ContextLinks page="${page}"`);
  });
});
