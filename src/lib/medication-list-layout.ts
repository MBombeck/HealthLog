/**
 * Medications list presentation — persisted in
 * `User.medicationListLayoutJson`.
 *
 * Single source of truth for the /medications view choice (cards vs the
 * compact table), the user-defined manual medication order shared by
 * BOTH views, category grouping and its open mode, and the category order.
 * Null / missing column = the defaults below; the GET endpoint never
 * lazy-writes a row, so the column only carries data once the user has
 * explicitly changed one of these.
 *
 * Mirrors `insights-layout.ts` / `dashboard-layout.ts` — same separate
 * per-surface column on `User`, same resolver / serializer semantics,
 * same preserve-when-absent PUT contract (see the route).
 */

import {
  MEDICATION_CATEGORY_VALUES,
  isMedicationCategoryKey,
} from "@/lib/medications/category-values";

/** The two list presentations /medications can render. */
export const MEDICATION_LIST_VIEWS = ["cards", "table"] as const;

export type MedicationListView = (typeof MEDICATION_LIST_VIEWS)[number];

export const MEDICATION_GROUP_BYS = ["none", "category"] as const;
export type MedicationGroupBy = (typeof MEDICATION_GROUP_BYS)[number];

export const MEDICATION_GROUPS_OPEN = [
  "expanded",
  "flagged",
  "collapsed",
] as const;
export type MedicationGroupsOpen = (typeof MEDICATION_GROUPS_OPEN)[number];

export interface MedicationListLayout {
  version: 1;
  /** Which presentation the list renders in. Default: cards. */
  view: MedicationListView;
  /**
   * User-defined manual medication order (medication ids, first = top).
   * Applied to BOTH views; medications not in the list append after the
   * ordered block in the alphabetical default order. Ids that no longer
   * resolve to a medication are ignored at apply time (a deleted
   * medication must not 422 the stored layout), so the list is bounded
   * but not ownership-validated — it is display-only.
   */
  order: string[];
  /** Whether the list groups under categories ("category") or stays flat ("none", default). */
  groupBy?: MedicationGroupBy;
  /** Which categories start open: all of them ("expanded", default), due/overdue only ("flagged"), or none ("collapsed"). */
  groupsOpen?: MedicationGroupsOpen;
  /**
   * User-defined manual category ordering (category keys, first = top).
   * Stable category keys, unknown keys ignored at apply time, unlisted categories append in default order.
   */
  categoryOrder?: string[];
}

/**
 * v1.32.21 — the resolved presentation plus the server-stamped
 * `updatedAt` optimistic-concurrency token (mirrors `User.updatedAt`, never
 * persisted inside the blob). GET and every write response carry it; the
 * client echoes it back as `baseUpdatedAt` on the next write. Mirrors
 * `DashboardLayoutWithToken` / `InsightsLayoutWithToken`.
 */
export type MedicationListLayoutWithToken = MedicationListLayout & {
  updatedAt?: string;
};

/**
 * Upper bound on the persisted order list. Generous — the medications
 * list itself has no hard cap, but the blob must stay small; beyond
 * this many entries the tail falls back to the alphabetical default.
 */
export const MEDICATION_ORDER_MAX_ENTRIES = 200;

/** Per-entry id length bound (cuids are 25 chars; leave headroom). */
export const MEDICATION_ORDER_ID_MAX_LENGTH = 64;

/**
 * Upper bound on the stored category order. An account has the built-in
 * categories plus at most 20 of its own, and the write drops keys the
 * account does not have, so this is headroom, not a limit anyone reaches.
 */
export const MEDICATION_CATEGORY_ORDER_MAX = 64;

export const DEFAULT_MEDICATION_LIST_LAYOUT: MedicationListLayout = {
  version: 1,
  view: "cards",
  order: [],
  groupBy: "none",
  groupsOpen: "expanded",
  categoryOrder: [],
};

function isMedicationListView(value: unknown): value is MedicationListView {
  return (
    typeof value === "string" &&
    (MEDICATION_LIST_VIEWS as readonly string[]).includes(value)
  );
}

function isMedicationGroupBy(value: unknown): value is MedicationGroupBy {
  return (
    typeof value === "string" &&
    (MEDICATION_GROUP_BYS as readonly string[]).includes(value)
  );
}

function isMedicationGroupsOpen(value: unknown): value is MedicationGroupsOpen {
  return (
    typeof value === "string" &&
    (MEDICATION_GROUPS_OPEN as readonly string[]).includes(value)
  );
}

/**
 * Default rank for medication categories:
 * - Built-ins (excluding OTHER): index in MEDICATION_CATEGORY_VALUES (0 .. N-1)
 * - Custom / other non-OTHER categories: rank N (sorted alphabetically by label)
 * - OTHER: rank N + 1 (always last)
 */
function defaultMedicationCategoryRank(key: string): number {
  if (key === "OTHER") return MEDICATION_CATEGORY_VALUES.length + 1;
  const idx = (MEDICATION_CATEGORY_VALUES as readonly string[]).indexOf(key);
  if (idx >= 0) return idx;
  return MEDICATION_CATEGORY_VALUES.length;
}

/**
 * Sort categories by default ordering:
 * Built-in categories keep their fixed order, custom categories follow alphabetically by label, and OTHER comes last.
 */
export function sortMedicationCategoriesByDefault<
  T extends { key: string; label?: string | null },
>(categories: readonly T[], locale?: string): T[] {
  return [...categories].sort((a, b) => {
    const rankDiff =
      defaultMedicationCategoryRank(a.key) -
      defaultMedicationCategoryRank(b.key);
    if (rankDiff !== 0) return rankDiff;
    const labelA = a.label ?? "";
    const labelB = b.label ?? "";
    return labelA.localeCompare(labelB, locale) || (a.key < b.key ? -1 : 1);
  });
}

/**
 * Tolerant read-side resolver: any malformed / legacy / partial blob
 * collapses onto the defaults field-by-field, so a GET can never fail on
 * a stored row and a new field added later defaults cleanly for blobs
 * persisted before it existed.
 */
export function resolveMedicationListLayout(
  raw: unknown,
): MedicationListLayout {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ...DEFAULT_MEDICATION_LIST_LAYOUT, order: [], categoryOrder: [] };
  }
  const blob = raw as {
    view?: unknown;
    order?: unknown;
    groupBy?: unknown;
    groupsOpen?: unknown;
    categoryOrder?: unknown;
  };
  const view = isMedicationListView(blob.view)
    ? blob.view
    : DEFAULT_MEDICATION_LIST_LAYOUT.view;
  const order = Array.isArray(blob.order)
    ? dedupeOrder(
        blob.order.filter(
          (id): id is string =>
            typeof id === "string" &&
            id.length > 0 &&
            id.length <= MEDICATION_ORDER_ID_MAX_LENGTH,
        ),
      )
    : [];
  const groupBy = isMedicationGroupBy(blob.groupBy)
    ? blob.groupBy
    : DEFAULT_MEDICATION_LIST_LAYOUT.groupBy;
  const groupsOpen = isMedicationGroupsOpen(blob.groupsOpen)
    ? blob.groupsOpen
    : DEFAULT_MEDICATION_LIST_LAYOUT.groupsOpen;
  const categoryOrder = Array.isArray(blob.categoryOrder)
    ? dedupeOrder(blob.categoryOrder.filter(isMedicationCategoryKey)).slice(
        0,
        MEDICATION_CATEGORY_ORDER_MAX,
      )
    : [];

  return { version: 1, view, order, groupBy, groupsOpen, categoryOrder };
}

/**
 * Write-side normaliser: dedupes the order list and category order list
 * and caps them. The route merges absent fields from the stored blob
 * BEFORE calling this, so the result is always a complete layout.
 */
export function serializeMedicationListLayout(input: {
  view: MedicationListView;
  order: string[];
  groupBy?: MedicationGroupBy;
  groupsOpen?: MedicationGroupsOpen;
  categoryOrder?: string[];
}): MedicationListLayout {
  return {
    version: 1,
    view: input.view,
    order: dedupeOrder(input.order).slice(0, MEDICATION_ORDER_MAX_ENTRIES),
    groupBy: input.groupBy ?? DEFAULT_MEDICATION_LIST_LAYOUT.groupBy,
    groupsOpen: input.groupsOpen ?? DEFAULT_MEDICATION_LIST_LAYOUT.groupsOpen,
    categoryOrder: dedupeOrder(input.categoryOrder ?? []).slice(
      0,
      MEDICATION_CATEGORY_ORDER_MAX,
    ),
  };
}

function dedupeOrder(order: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The stored layout blob with its category order rewritten through `remap`
 * (file key to the key a restore gave the category). Anything else in the
 * blob, and a blob without a category order, passes through untouched.
 */
export function remapMedicationListCategoryOrder(
  raw: unknown,
  remap: ReadonlyMap<string, string>,
): unknown {
  if (remap.size === 0 || raw === null || typeof raw !== "object") return raw;
  const blob = raw as { categoryOrder?: unknown };
  if (!Array.isArray(blob.categoryOrder)) return raw;
  return {
    ...blob,
    categoryOrder: blob.categoryOrder.map((key: unknown) =>
      typeof key === "string" ? (remap.get(key) ?? key) : key,
    ),
  };
}
