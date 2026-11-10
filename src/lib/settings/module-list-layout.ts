/**
 * List presentation for the labs, illness and checkups lists, persisted in
 * `User.moduleListLayoutJson`.
 *
 * Three independent choices per list, all display-only:
 *
 * - `view`: the card grid or the compact list.
 * - `order`: an id allow-list. Ids absent from the live data are ignored;
 *   ids present in the data but absent from `order` sort after the ordered
 *   block in the server's own order.
 * - `sortDir`: only the labs list reads it (recency, alphabetical, or the
 *   manual `order`).
 * - `groupBy` / `groupsOpen`: only the labs list reads them. `groupBy` shows
 *   the list under its server-resolved categories (`"category"`) or flat
 *   (`"none"`, the default); `groupsOpen` says which categories start open:
 *   all of them, only those with a value outside its range, or none.
 * - `categoryOrder`: only the labs list reads it, and only on the server: a
 *   category-key allow-list `GET /api/labs/overview` applies before it
 *   answers `categories` (`applyCategoryOrder` in
 *   `src/lib/labs/marker-category.ts`), so every client receives the
 *   categories already in the person's order. Same tolerance as `order`.
 *
 * Null / missing column = the defaults below. The GET never lazy-writes, and
 * the PUT stores only the fields a person has actually chosen, so a default
 * that changes later still reaches every list nobody arranged. Mirrors
 * `documents-layout.ts`: tolerant resolver on read, preserve-when-absent PUT.
 *
 * `saved` tells the client whether the server holds a choice for a list. The
 * same choices lived in the browser before this column existed; the client
 * copies a browser value up once, only while `saved` is false, so an order a
 * person built is carried over instead of reset.
 */

export const MODULE_LIST_KEYS = ["labs", "illness", "vorsorge"] as const;
export type ModuleListKey = (typeof MODULE_LIST_KEYS)[number];

export const MODULE_LIST_VIEWS = ["cards", "list"] as const;
export type ModuleListView = (typeof MODULE_LIST_VIEWS)[number];

export const MODULE_SORT_DIRS = [
  "recentDesc",
  "recentAsc",
  "alphaAsc",
  "alphaDesc",
  "manual",
] as const;
export type ModuleSortDir = (typeof MODULE_SORT_DIRS)[number];

export const MODULE_GROUP_BYS = ["none", "category"] as const;
export type ModuleGroupBy = (typeof MODULE_GROUP_BYS)[number];

export const MODULE_GROUPS_OPEN = ["expanded", "flagged", "collapsed"] as const;
export type ModuleGroupsOpen = (typeof MODULE_GROUPS_OPEN)[number];

/** Longest order a list keeps; a longer one is cut, never refused. */
export const MODULE_LIST_ORDER_MAX = 500;
/** Longest id an order entry may carry (cuid and uuid fit comfortably). */
export const MODULE_LIST_ID_MAX = 64;
/**
 * Longest category order a list keeps. Ten catalog panels plus "other" plus
 * the person's own panels; a longer one is cut, never refused.
 */
export const MODULE_LIST_CATEGORY_ORDER_MAX = 200;

export interface ModuleListPrefs {
  view: ModuleListView;
  order: string[];
  sortDir: ModuleSortDir;
  groupBy: ModuleGroupBy;
  groupsOpen: ModuleGroupsOpen;
  categoryOrder: string[];
}

export interface ModuleListPrefsEntry extends ModuleListPrefs {
  /** True when the server holds at least one choice for this list. */
  saved: boolean;
}

export interface ModuleListLayout {
  version: 1;
  lists: Record<ModuleListKey, ModuleListPrefsEntry>;
}

const BASE_DEFAULTS: ModuleListPrefs = {
  view: "cards",
  order: [],
  sortDir: "recentDesc",
  groupBy: "none",
  groupsOpen: "expanded",
  categoryOrder: [],
};

/** Labs opens on the compact list, the dense reading table (#40). */
const LIST_DEFAULTS: Record<ModuleListKey, ModuleListPrefs> = {
  labs: { ...BASE_DEFAULTS, view: "list" },
  illness: { ...BASE_DEFAULTS },
  vorsorge: { ...BASE_DEFAULTS },
};

export function moduleListDefaults(list: ModuleListKey): ModuleListPrefs {
  const defaults = LIST_DEFAULTS[list];
  return {
    ...defaults,
    order: [...defaults.order],
    categoryOrder: [...defaults.categoryOrder],
  };
}

export function isModuleListView(value: unknown): value is ModuleListView {
  return (
    typeof value === "string" &&
    (MODULE_LIST_VIEWS as readonly string[]).includes(value)
  );
}

export function isModuleSortDir(value: unknown): value is ModuleSortDir {
  return (
    typeof value === "string" &&
    (MODULE_SORT_DIRS as readonly string[]).includes(value)
  );
}

export function isModuleGroupBy(value: unknown): value is ModuleGroupBy {
  return (
    typeof value === "string" &&
    (MODULE_GROUP_BYS as readonly string[]).includes(value)
  );
}

export function isModuleGroupsOpen(value: unknown): value is ModuleGroupsOpen {
  return (
    typeof value === "string" &&
    (MODULE_GROUPS_OPEN as readonly string[]).includes(value)
  );
}

/** Keep string ids of a sane length, first occurrence wins, capped. */
export function normaliseModuleListOrder(
  raw: unknown,
  max: number = MODULE_LIST_ORDER_MAX,
): string[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (value.length === 0 || value.length > MODULE_LIST_ID_MAX) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The fields a stored blob explicitly carries for one list, each validated.
 * Unknown or malformed values drop out, so the default fills them on read.
 */
export function storedModuleListChoices(
  raw: unknown,
): Partial<ModuleListPrefs> {
  if (raw === null || raw === undefined || typeof raw !== "object") return {};
  const blob = raw as {
    view?: unknown;
    order?: unknown;
    sortDir?: unknown;
    groupBy?: unknown;
    groupsOpen?: unknown;
    categoryOrder?: unknown;
  };
  const order = normaliseModuleListOrder(blob.order);
  const categoryOrder = normaliseModuleListOrder(
    blob.categoryOrder,
    MODULE_LIST_CATEGORY_ORDER_MAX,
  );
  return {
    ...(isModuleListView(blob.view) ? { view: blob.view } : {}),
    ...(order !== null ? { order } : {}),
    ...(isModuleSortDir(blob.sortDir) ? { sortDir: blob.sortDir } : {}),
    ...(isModuleGroupBy(blob.groupBy) ? { groupBy: blob.groupBy } : {}),
    ...(isModuleGroupsOpen(blob.groupsOpen)
      ? { groupsOpen: blob.groupsOpen }
      : {}),
    ...(categoryOrder !== null ? { categoryOrder } : {}),
  };
}

/** Every list's stored choices, keyed by list. */
export function storedModuleListLayout(
  raw: unknown,
): Partial<Record<ModuleListKey, Partial<ModuleListPrefs>>> {
  if (raw === null || raw === undefined || typeof raw !== "object") return {};
  const blob = raw as Record<string, unknown>;
  const out: Partial<Record<ModuleListKey, Partial<ModuleListPrefs>>> = {};
  for (const list of MODULE_LIST_KEYS) {
    const choices = storedModuleListChoices(blob[list]);
    if (Object.keys(choices).length > 0) out[list] = choices;
  }
  return out;
}

/**
 * Any malformed, partial or legacy blob collapses onto the defaults field by
 * field, so a GET never fails on a stored row.
 */
export function resolveModuleListLayout(raw: unknown): ModuleListLayout {
  const stored = storedModuleListLayout(raw);
  const lists = {} as Record<ModuleListKey, ModuleListPrefsEntry>;
  for (const list of MODULE_LIST_KEYS) {
    const choices = stored[list];
    lists[list] = {
      ...moduleListDefaults(list),
      ...choices,
      saved: choices !== undefined,
    };
  }
  return { version: 1, lists };
}
