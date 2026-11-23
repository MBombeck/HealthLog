import {
  CalendarDays,
  DatabaseBackup,
  Keyboard,
  MessagesSquare,
  Plus,
  type LucideIcon,
} from "lucide-react";

import {
  NAV_ACCOUNT_MENU_DESTINATIONS,
  visibleAccountMenuDestinations,
  visibleNavDestinations,
  type NavRecordContext,
} from "@/components/layout/nav-model";
import { MODULE_ICONS } from "@/components/settings/module-icons";
import { MODULE_REGISTRY, type ModuleKey } from "@/lib/modules/registry";
import { isSurfaceVisible, type SurfaceModuleMap } from "@/lib/modules/surface";
import type { ShareDomain } from "@/lib/sharing/scope";

import { SETTINGS_MODULE_PAGES } from "@/lib/command-palette/settings-cards";
import { PALETTE_SYNONYMS } from "@/lib/command-palette/synonyms";
import {
  SURFACE_REGISTRY,
  type SurfaceEntry,
} from "@/components/layout/surface-registry";

/** The module that owns each page under Settings > Modules. */
const SETTINGS_MODULE_PAGE_OWNER: Readonly<Record<string, ModuleKey>> =
  Object.fromEntries(SETTINGS_MODULE_PAGES.map((p) => [p.slug, p.module]));

/**
 * The command palette's index: every place and action this session may
 * reach, built on the client from the one surface registry
 * (`@/components/layout/surface-registry`), which reads the lists the
 * navigation, Settings and Admin render.
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
  /** See `PALETTE_TASK_BOOST`. */
  boost?: number;
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
  /** The shared record's kind and the grant's level, when there is one. */
  record?: NavRecordContext | null;
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

/**
 * The ranked hits with every module switch after every other hit. A switch
 * shares its name with the task it gates ("Doctor report"), and Enter on it
 * flips the module; a word typed to do the task must never land there first.
 */
export function tasksBeforeSwitches<T extends { run: PaletteRun }>(
  ranked: ReadonlyArray<T>,
): T[] {
  return [
    ...ranked.filter((entry) => entry.run.kind !== "module"),
    ...ranked.filter((entry) => entry.run.kind === "module"),
  ];
}

function keywordsFor(id: string, extra: ReadonlyArray<string> = []) {
  return [...extra, ...(PALETTE_SYNONYMS[id] ?? [])];
}

const HINT_IS_KEYWORD: ReadonlySet<SurfaceEntry["entry"]["kind"]> = new Set([
  "admin",
  "settings-card",
  "settings-page",
]);

/** The localized search words of an entry: `palette.keywords.*`, split. */
function localizedKeywords(t: Translate, key: string | undefined): string[] {
  if (!key) return [];
  return t(key)
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);
}

export function buildPaletteIndex(input: PaletteIndexInput): PaletteEntry[] {
  const { t, modules } = input;
  const entries: PaletteEntry[] = [];

  // What the navigation offers this session: its own visibility rules
  // (modules, the Coach's capability, what a shared record covers).
  const nav = visibleNavDestinations(
    input.navModules,
    true,
    input.inSharedRecord,
    input.sections,
    input.record ?? null,
  );
  const navHrefs = new Set(nav.map((d) => d.href));
  // The record pages the account menu opens, under that menu's own rule.
  const accountMenuHrefs = new Set(
    visibleAccountMenuDestinations({
      sharedRecord: input.inSharedRecord,
      sections: input.sections,
      record: input.record ?? null,
    }).map((d) => d.href),
  );
  const isAccountMenuPage = (href: string) =>
    NAV_ACCOUNT_MENU_DESTINATIONS.some((d) => d.href === href);

  // Settings sections the shell lists for the record on screen.
  const sectionTitle = new Map<string, string>();
  const sectionVisible = new Set<string>();
  for (const entry of SURFACE_REGISTRY) {
    if (entry.entry.kind !== "settings-section") continue;
    const slug = entry.entry.slug;
    if (!isSurfaceVisible(`settings:${slug}`, modules)) continue;
    if (!input.settingsListed(slug)) continue;
    sectionTitle.set(slug, t(entry.labelKey));
    sectionVisible.add(slug);
  }

  const offered = (entry: SurfaceEntry): { hint?: string } | null => {
    const point = entry.entry;
    switch (point.kind) {
      case "nav":
        // The rail group it sits under, as the sidebar and More show it.
        if (!navHrefs.has(entry.href)) return null;
        return point.groupKey ? { hint: t(point.groupKey) } : {};
      case "menu":
        if (isAccountMenuPage(entry.href)) {
          return accountMenuHrefs.has(entry.href) ? {} : null;
        }
        return input.inSharedRecord ? null : {};
      case "admin":
        return input.isAdmin && !input.inSharedRecord
          ? { hint: t("nav.admin") }
          : null;
      case "insights":
        if (!navHrefs.has("/insights")) return null;
        if (point.surface && !isSurfaceVisible(point.surface, modules)) {
          return null;
        }
        return { hint: t("nav.insights") };
      case "settings-section":
        return sectionVisible.has(point.slug)
          ? { hint: t("nav.settings") }
          : null;
      case "settings-card": {
        // Inside somebody else's record the palette lists the Settings pages
        // the record lists, and no card of the account around it.
        if (input.inSharedRecord) return null;
        const [slug, page] = point.section.split("/");
        if (!sectionVisible.has(slug)) return null;
        if (page !== undefined) {
          const owner = SETTINGS_MODULE_PAGE_OWNER[page];
          if (slug === "modules" && owner && modules?.[owner] === false) {
            return null;
          }
        }
        if (
          point.modules &&
          !point.modules.some((key) => modules?.[key] !== false)
        ) {
          return null;
        }
        return { hint: sectionTitle.get(slug) ?? "" };
      }
      case "settings-page": {
        if (input.inSharedRecord) return null;
        if (!sectionVisible.has(point.parent)) return null;
        if (point.module && modules?.[point.module] === false) return null;
        return { hint: sectionTitle.get(point.parent) ?? "" };
      }
    }
  };

  for (const entry of SURFACE_REGISTRY) {
    const offer = offered(entry);
    if (offer === null) continue;
    const group: PaletteEntry["group"] =
      entry.entry.kind === "insights"
        ? "insights"
        : entry.entry.kind === "nav" ||
            entry.entry.kind === "menu" ||
            entry.entry.kind === "admin"
          ? "pages"
          : "settings";
    entries.push({
      id: entry.id,
      group,
      title: t(entry.labelKey),
      ...(offer.hint !== undefined ? { hint: offer.hint } : {}),
      // A card, a module page and an admin page are also found by the name
      // of the page they sit on.
      keywords: keywordsFor(entry.id, [
        ...(offer.hint && HINT_IS_KEYWORD.has(entry.entry.kind)
          ? [offer.hint]
          : []),
        ...localizedKeywords(t, entry.keywordsKey),
      ]),
      ...(entry.boost !== undefined ? { boost: entry.boost } : {}),
      icon: entry.icon,
      run: { kind: "href", href: entry.href },
    });
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
