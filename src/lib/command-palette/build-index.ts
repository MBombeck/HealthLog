import {
  Bell,
  CalendarDays,
  ChartLine,
  DatabaseBackup,
  Keyboard,
  MessagesSquare,
  Palette,
  Plus,
  type LucideIcon,
} from "lucide-react";

import { ADMIN_SECTIONS } from "@/components/admin/admin-shell";
import { SUB_PAGE_TABS } from "@/components/insights/insights-tab-strip";
import { visibleNavDestinations } from "@/components/layout/nav-model";
import { MODULE_ICONS } from "@/components/settings/module-icons";
import { SETTINGS_SECTIONS } from "@/components/settings/settings-shell";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";
import { MODULE_REGISTRY, type ModuleKey } from "@/lib/modules/registry";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";
import type { ShareDomain } from "@/lib/sharing/scope";

import { SETTINGS_CARDS, SETTINGS_LAYOUT_PAGES } from "./settings-cards";
import { PALETTE_SYNONYMS } from "./synonyms";

/**
 * The command palette's index: every place and action this session may
 * reach, built on the client from the same lists the navigation renders.
 *
 * Nothing here is a second opinion about access. A page comes from
 * `visibleNavDestinations` (modules, the Coach's AI capability folded into
 * the map by `useNavModules`, what a shared record covers); an Insights page,
 * a Settings section and a card from the surface map; an admin page only for
 * an admin in their own record. Inside somebody else's record the palette
 * offers the doors sharing opens and the Settings pages the record lists,
 * and nothing that configures the account around it: no cards, no module
 * switches, no backup.
 */

export type PaletteGroup =
  "recent" | "pages" | "insights" | "settings" | "modules" | "actions";

export type PaletteActionId =
  "capture" | "coach" | "backup" | "today" | "shortcuts";

export type PaletteRun =
  | { kind: "href"; href: string }
  | { kind: "action"; action: PaletteActionId }
  | { kind: "module"; module: ModuleKey; enabled: boolean };

export interface PaletteEntry {
  id: string;
  group: Exclude<PaletteGroup, "recent">;
  title: string;
  /** Where it sits, shown beside the title (a card's section). */
  hint?: string;
  keywords: ReadonlyArray<string>;
  icon: LucideIcon;
  run: PaletteRun;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface PaletteIndexInput {
  t: Translate;
  /** The record's resolved module map (`GET /api/auth/me` → `modules`). */
  modules: SurfaceModuleMap | undefined;
  /** The same map with `coach` following the AI capability (`useNavModules`). */
  navModules: SurfaceModuleMap | undefined;
  inSharedRecord: boolean;
  /** The shared record's covered sections, when there is one. */
  sections: ReadonlyArray<ShareDomain> | null;
  isAdmin: boolean;
  /**
   * Whether the Settings shell lists a section for the record on screen.
   * One's own record: every section. A shared record: the record's own list.
   */
  settingsListed: (slug: string) => boolean;
  /** Whether the add menu has anything to offer. */
  canCapture: boolean;
  /**
   * The module switches to offer with their state. Empty inside a shared
   * record (a delegate does not configure the account) and for a module the
   * operator switched off or code disabled.
   */
  moduleToggles: ReadonlyArray<{ key: ModuleKey; enabled: boolean }>;
}

const INSIGHTS_EXTRA: ReadonlyArray<{
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

function keywordsFor(id: string, extra: ReadonlyArray<string> = []) {
  return [...extra, ...(PALETTE_SYNONYMS[id] ?? [])];
}

export function buildPaletteIndex(input: PaletteIndexInput): PaletteEntry[] {
  const { t, modules } = input;
  const entries: PaletteEntry[] = [];

  // ── Pages: the navigation's own list. ──
  const nav = visibleNavDestinations(
    input.navModules,
    true,
    input.inSharedRecord,
    input.sections,
  );
  const navHrefs = new Set(nav.map((d) => d.href));
  for (const d of nav) {
    const id = `nav:${d.href}`;
    entries.push({
      id,
      group: "pages",
      title: t(d.tKey),
      keywords: keywordsFor(id),
      icon: d.icon,
      run: { kind: "href", href: d.href },
    });
  }
  if (!input.inSharedRecord) {
    entries.push({
      id: "nav:/notifications",
      group: "pages",
      title: t("nav.notifications"),
      keywords: keywordsFor("nav:/notifications"),
      icon: Bell,
      run: { kind: "href", href: "/notifications" },
    });
  }
  if (input.isAdmin && !input.inSharedRecord) {
    const admin = t("nav.admin");
    for (const section of ADMIN_SECTIONS) {
      const id = `admin:${section.slug}`;
      entries.push({
        id,
        group: "pages",
        title: t(section.titleKey),
        hint: admin,
        keywords: keywordsFor(id, [admin]),
        icon: section.icon,
        run: { kind: "href", href: `/admin/${section.slug}` },
      });
    }
  }

  // ── Insights pages, while the area is offered at all. ──
  if (navHrefs.has("/insights")) {
    const area = t("nav.insights");
    const pages = [
      ...SUB_PAGE_SLUGS.map((slug) => ({
        slug: slug as string,
        labelKey: SUB_PAGE_TABS[slug].labelKey,
        surface: `insights-page:${slug}`,
      })),
      ...INSIGHTS_EXTRA,
    ];
    for (const page of pages) {
      if (page.surface && !isSurfaceVisible(page.surface, modules)) continue;
      const id = `insights:${page.slug}`;
      entries.push({
        id,
        group: "insights",
        title: t(page.labelKey),
        hint: area,
        keywords: keywordsFor(id),
        icon: ChartLine,
        run: { kind: "href", href: `/insights/${page.slug}` },
      });
    }
  }

  // ── Settings: sections, then each card, then the Appearance pages. ──
  const sectionTitle = new Map<string, string>();
  const sectionVisible = new Set<string>();
  for (const section of SETTINGS_SECTIONS) {
    if (!isSurfaceVisible(`settings:${section.slug}`, modules)) continue;
    if (!input.settingsListed(section.slug)) continue;
    const title = t(section.titleKey);
    sectionTitle.set(section.slug, title);
    sectionVisible.add(section.slug);
    const id = `settings:${section.slug}`;
    entries.push({
      id,
      group: "settings",
      title,
      hint: t("nav.settings"),
      keywords: keywordsFor(id),
      icon: section.icon,
      run: { kind: "href", href: `/settings/${section.slug}` },
    });
  }
  if (!input.inSharedRecord) {
    for (const card of SETTINGS_CARDS) {
      if (!sectionVisible.has(card.section)) continue;
      if (
        card.modules &&
        !card.modules.some((key) => modules?.[key] !== false)
      ) {
        continue;
      }
      const section = sectionTitle.get(card.section) ?? "";
      const id = `settings:${card.section}#${card.anchor}`;
      entries.push({
        id,
        group: "settings",
        title: t(card.titleKey),
        hint: section,
        keywords: keywordsFor(id, [section]),
        icon:
          SETTINGS_SECTIONS.find((s) => s.slug === card.section)?.icon ??
          Palette,
        run: {
          kind: "href",
          href: `/settings/${card.section}#${card.anchor}`,
        },
      });
    }
    if (sectionVisible.has("layout")) {
      const layout = sectionTitle.get("layout") ?? "";
      for (const page of SETTINGS_LAYOUT_PAGES) {
        if (page.module && modules?.[page.module] === false) continue;
        const id = `settings:layout/${page.slug}`;
        entries.push({
          id,
          group: "settings",
          title: t(page.titleKey),
          hint: layout,
          keywords: keywordsFor(id, [layout]),
          icon: Palette,
          run: { kind: "href", href: `/settings/layout/${page.slug}` },
        });
      }
    }
  }

  // ── Module switches. ──
  for (const toggle of input.moduleToggles) {
    const def = MODULE_REGISTRY[toggle.key];
    const id = `module:${toggle.key}`;
    entries.push({
      id,
      group: "modules",
      title: t(def.labelKey),
      keywords: keywordsFor(id, [t("settings.sections.modules.title")]),
      icon: MODULE_ICONS[toggle.key],
      run: { kind: "module", module: toggle.key, enabled: toggle.enabled },
    });
  }

  // ── Actions. ──
  const action = (
    id: PaletteActionId,
    titleKey: string,
    icon: LucideIcon,
  ): PaletteEntry => ({
    id: `action:${id}`,
    group: "actions",
    title: t(titleKey),
    keywords: keywordsFor(`action:${id}`),
    icon,
    run: { kind: "action", action: id },
  });
  if (input.canCapture) {
    entries.push(action("capture", "palette.actions.capture", Plus));
  }
  if (navHrefs.has("/coach") && !input.inSharedRecord) {
    entries.push(action("coach", "palette.actions.coach", MessagesSquare));
  }
  if (!input.inSharedRecord && sectionVisible.has("export")) {
    entries.push(action("backup", "palette.actions.backup", DatabaseBackup));
  }
  entries.push(action("today", "palette.actions.today", CalendarDays));
  entries.push(action("shortcuts", "palette.actions.shortcuts", Keyboard));

  return entries;
}

/** The actions the empty palette offers below the recent places. */
export const EMPTY_STATE_ACTIONS: ReadonlyArray<string> = [
  "action:capture",
  "action:today",
  "action:coach",
  "action:shortcuts",
];
