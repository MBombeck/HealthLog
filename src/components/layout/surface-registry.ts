/**
 * Every surface with a route, in one list: where it is entered, what it is
 * called, and the words it is found by.
 *
 * The navigation, Settings and Admin each keep their own ordered list
 * (`NAV_DESTINATIONS`, `SETTINGS_SECTIONS`, `ADMIN_SECTIONS`), and the module
 * map in `@/lib/modules/surface` says which switch hides what. This file reads
 * those lists, adds the Settings cards and sub-pages that carry their own
 * entry (`SETTINGS_CARDS`), and is the one source the search palette builds
 * its index from (`buildPaletteIndex`). A surface reaches the search because
 * it is here, not because somebody remembered the palette.
 *
 * The rule that holds it: `src/__tests__/surface-registry-guard.test.ts`.
 * Every page route outside sign-in, Admin and Settings is a navigation
 * destination or a declared child of one; every Settings card that carries an
 * anchor is an entry here or declared not to be one; every entry has a way in
 * (a navigation, menu, Settings or Admin row), a hit in the palette, and its
 * name and search words in all ten languages.
 */
import { ChartLine, Palette, type LucideIcon } from "lucide-react";

import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";
import {
  NAV_ACCOUNT_MENU_DESTINATIONS,
  NAV_DESTINATIONS,
  NAV_UTILITY_DESTINATIONS,
  isSettingsUtilityDestination,
  navGroupLabelKey,
} from "@/components/layout/nav-model";
import { MODULE_ICONS } from "@/components/settings/module-icons";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-shell";
import {
  SETTINGS_CARDS,
  SETTINGS_LAYOUT_PAGES,
  SETTINGS_MODULE_PAGES,
} from "@/lib/command-palette/settings-cards";
import {
  PALETTE_KEYWORD_KEYS,
  PALETTE_TASK_BOOST,
} from "@/lib/command-palette/synonyms";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";
import type { ModuleKey } from "@/lib/modules/registry";

/** How a surface is entered, which decides when it is offered. */
export type SurfaceEntryPoint =
  /**
   * The sidebar and the phone's bottom bar or More hub, under its rail group
   * heading (`NAV_GROUPS`); null for the unheaded top group.
   */
  | { kind: "nav"; groupKey: string | null }
  /**
   * The avatar menu: an account utility (ui-standards §10), or a record page
   * that opens from there (`NAV_ACCOUNT_MENU_DESTINATIONS`).
   */
  | { kind: "menu" }
  /** The Admin console's rail, for an admin in their own record. */
  | { kind: "admin" }
  /** The Insights tab strip; `surface` is its module-map id, if owned. */
  | { kind: "insights"; surface?: string }
  /** A row of the Settings rail. */
  | { kind: "settings-section"; slug: string }
  /**
   * A card on a Settings page, reached by its anchor. `section` is the page:
   * a section slug, or `modules/<id>` / `layout/<id>` for a module's page.
   */
  | {
      kind: "settings-card";
      section: string;
      anchor: string;
      modules?: ReadonlyArray<ModuleKey>;
    }
  /** A module's own page under Settings > Arrangement or > Modules. */
  | {
      kind: "settings-page";
      parent: "layout" | "modules";
      slug: string;
      module?: ModuleKey;
    };

export interface SurfaceEntry {
  /** Stable id, shared with the palette's recents and synonyms. */
  id: string;
  href: string;
  /** i18n key of the surface's name, as its own heading renders it. */
  labelKey: string;
  /**
   * i18n key of a comma-separated list of words the surface is found by, in
   * each language (`palette.keywords.*`). Optional: a name that says it all
   * needs none.
   */
  keywordsKey?: string;
  icon: LucideIcon;
  entry: SurfaceEntryPoint;
  /** See `PALETTE_TASK_BOOST`. */
  boost?: number;
}

/**
 * Insights pages that are not a metric of the tab strip but still a page of
 * their own, reached from the strip's catalog and the overview.
 */
export const INSIGHTS_EXTRA_PAGES: ReadonlyArray<{
  slug: string;
  labelKey: string;
  surface?: string;
}> = [
  { slug: "catalog", labelKey: "insights.navCatalog" },
  {
    slug: "recovery",
    labelKey: "insights.navRecovery",
    surface: "insights-page:recovery",
  },
  { slug: "ecg", labelKey: "insights.navEcg" },
];

function withKeywords(entry: Omit<SurfaceEntry, "keywordsKey">): SurfaceEntry {
  const keywordsKey = PALETTE_KEYWORD_KEYS[entry.id];
  const boost = PALETTE_TASK_BOOST[entry.id];
  return {
    ...entry,
    ...(keywordsKey ? { keywordsKey } : {}),
    ...(boost !== undefined ? { boost } : {}),
  };
}

function sectionIcon(section: string): LucideIcon {
  const slug = section.split("/")[0];
  return SETTINGS_SECTIONS.find((s) => s.slug === slug)?.icon ?? Palette;
}

function build(): SurfaceEntry[] {
  const out: SurfaceEntry[] = [];

  for (const d of NAV_DESTINATIONS) {
    out.push(
      withKeywords({
        id: `nav:${d.href}`,
        href: d.href,
        labelKey: d.tKey,
        icon: d.icon,
        entry: { kind: "nav", groupKey: navGroupLabelKey(d.group) },
      }),
    );
  }
  for (const d of NAV_UTILITY_DESTINATIONS) {
    // The Settings door is the Settings rail itself, listed below.
    if (isSettingsUtilityDestination(d)) continue;
    out.push(
      withKeywords({
        id: `nav:${d.href}`,
        href: d.href,
        labelKey: d.tKey,
        icon: d.icon,
        entry: { kind: "menu" },
      }),
    );
  }
  // The record pages the account menu opens (the emergency card). Their id
  // keeps the `nav:` prefix the utilities use, so a recent search and a
  // context link survive the move from the rail.
  for (const d of NAV_ACCOUNT_MENU_DESTINATIONS) {
    out.push(
      withKeywords({
        id: `nav:${d.href}`,
        href: d.href,
        labelKey: d.tKey,
        icon: d.icon,
        entry: { kind: "menu" },
      }),
    );
  }
  for (const section of ADMIN_SECTIONS) {
    out.push(
      withKeywords({
        id: `admin:${section.slug}`,
        href: `/admin/${section.slug}`,
        labelKey: section.titleKey,
        icon: section.icon,
        entry: { kind: "admin" },
      }),
    );
  }
  for (const page of [
    ...SUB_PAGE_SLUGS.map((slug) => ({
      slug: slug as string,
      labelKey: SUB_PAGE_TABS[slug].labelKey,
      surface: `insights-page:${slug}` as string | undefined,
    })),
    ...INSIGHTS_EXTRA_PAGES,
  ]) {
    out.push(
      withKeywords({
        id: `insights:${page.slug}`,
        href: `/insights/${page.slug}`,
        labelKey: page.labelKey,
        icon: ChartLine,
        entry: { kind: "insights", surface: page.surface },
      }),
    );
  }
  for (const section of SETTINGS_SECTIONS) {
    out.push(
      withKeywords({
        id: `settings:${section.slug}`,
        href: `/settings/${section.slug}`,
        labelKey: section.titleKey,
        icon: section.icon,
        entry: { kind: "settings-section", slug: section.slug },
      }),
    );
  }
  for (const card of SETTINGS_CARDS) {
    out.push(
      withKeywords({
        id: `settings:${card.section}#${card.anchor}`,
        href: `/settings/${card.section}#${card.anchor}`,
        labelKey: card.titleKey,
        icon: sectionIcon(card.section),
        entry: {
          kind: "settings-card",
          section: card.section,
          anchor: card.anchor,
          ...(card.modules ? { modules: card.modules } : {}),
        },
      }),
    );
  }
  for (const page of SETTINGS_LAYOUT_PAGES) {
    out.push(
      withKeywords({
        id: `settings:layout/${page.slug}`,
        href: `/settings/layout/${page.slug}`,
        labelKey: page.titleKey,
        icon: Palette,
        entry: {
          kind: "settings-page",
          parent: "layout",
          slug: page.slug,
          ...(page.module ? { module: page.module } : {}),
        },
      }),
    );
  }
  for (const page of SETTINGS_MODULE_PAGES) {
    out.push(
      withKeywords({
        id: `settings:modules/${page.slug}`,
        href: `/settings/modules/${page.slug}`,
        labelKey: page.titleKey,
        icon: MODULE_ICONS[page.module],
        entry: {
          kind: "settings-page",
          parent: "modules",
          slug: page.slug,
          module: page.module,
        },
      }),
    );
  }
  return out;
}

/** The registry, in the order the palette lists equal matches. */
export const SURFACE_REGISTRY: ReadonlyArray<SurfaceEntry> = build();
