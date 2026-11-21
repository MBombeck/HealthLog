"use client";

import { useQuery, type QueryClient } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.17 — shared data layer for the mood-tag management surface
 * (`/settings/mood`). One catalog read + one layout read feed every
 * card; both fire in parallel at section mount so the section never
 * waterfalls.
 *
 * Wire contract (frozen for the v1.17 management suite):
 *   - `GET /api/mood/tags?include=hidden,archived,usage` — the fully
 *     resolved per-user Category → Tag tree, including hidden catalogue
 *     tags (`hidden: true`), the caller's archived custom tags
 *     (`archived: true`), per-tag historical link counts
 *     (`usageCount`), the caller's own custom groups (`custom: true`
 *     on the category) and empty own groups (kept when an `include`
 *     flag is set, dropped on the plain picker read).
 *   - `GET /api/mood/tags/layout` — the per-user presentation blob
 *     (`groupOrder` + `placements`), merged over the seeded defaults
 *     server-side. Display-only; a PUT is preserve-when-absent.
 *
 * Cache discipline: the manage read rides under the
 * `["mood-tag-catalog"]` prefix (see `queryKeys.moodTagManage`), so a
 * single prefix invalidation after any management mutation refreshes
 * both this read and the picker's plain read.
 */

export interface ManageTag {
  key: string;
  labelKey: string;
  /** Decrypted custom label; null/absent for catalogue tags. */
  label?: string | null;
  icon: string | null;
  kind: "BINARY" | "RATED";
  scaleMin: number;
  scaleMax: number;
  inverse: boolean;
  custom?: boolean;
  /** Catalogue tag hidden for this user (`mood_tag_hidden`). */
  hidden?: boolean;
  /** Custom tag soft-deactivated (history intact). */
  archived?: boolean;
  /** Historical entry-link count; present on the `usage` include. */
  usageCount?: number;
}

export interface ManageCategory {
  key: string;
  labelKey: string;
  /** Decrypted custom group label; null/absent for seeded categories. */
  label?: string | null;
  icon: string | null;
  custom?: boolean;
  tags: ManageTag[];
}

export interface ManageCatalog {
  categories: ManageCategory[];
}

/**
 * v1.32.22 — the resolved `GET/PUT /api/mood/tags/layout` response.
 * `updatedAt` is the optimistic-concurrency token the two management cards
 * echo on their next write; no active query reads this key (it is only ever
 * invalidated), so the token is seeded straight from each write response into
 * `queryKeys.moodTagLayout()` and read back at mutate time.
 */
export interface MoodTagLayoutResolved {
  groupOrder: string[];
  placements: Record<string, string[]>;
  updatedAt?: string;
}

export function useMoodTagManage(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.moodTagManage(),
    queryFn: async () =>
      apiGet<ManageCatalog>("/api/mood/tags?include=hidden,archived,usage"),
    enabled,
  });
}

/**
 * Invalidate every mood-tag read after a management mutation: the
 * `["mood-tag-catalog"]` prefix catches both the picker read and the
 * manage read; the layout key rides along because group/order writes
 * change the resolved tree AND the blob.
 */
export function invalidateMoodTagCaches(
  queryClient: QueryClient,
): Promise<unknown> {
  return Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: queryKeys.moodTagCatalog() }),
    queryClient.invalidateQueries({ queryKey: queryKeys.moodTagLayout() }),
  ]);
}

/**
 * Cancel in-flight catalog fetches and snapshot the manage cache so an
 * optimistic update can roll back on error. Returns the restore thunk.
 */
export async function snapshotManageCache(
  queryClient: QueryClient,
): Promise<() => void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.moodTagCatalog() });
  const manage = queryClient.getQueryData<ManageCatalog>(
    queryKeys.moodTagManage(),
  );
  return () => {
    queryClient.setQueryData(queryKeys.moodTagManage(), manage);
  };
}

/** Apply a pure updater to the manage cache (no-op when not yet loaded). */
export function updateManageCache(
  queryClient: QueryClient,
  updater: (catalog: ManageCatalog) => ManageCatalog,
): void {
  queryClient.setQueryData<ManageCatalog>(
    queryKeys.moodTagManage(),
    (current) => (current ? updater(current) : current),
  );
}

/* ------------------------------------------------------------------ */
/* Pure catalog-tree surgery — exported for unit tests.                */
/* ------------------------------------------------------------------ */

/** Display name for a category: custom label first, i18n key second. */
export function categoryDisplayName(
  category: Pick<ManageCategory, "label" | "labelKey">,
  t: (key: string) => string,
): string {
  return category.label ?? t(category.labelKey);
}

/** Display name for a tag: custom label first, i18n key second. */
export function tagDisplayName(
  tag: Pick<ManageTag, "label" | "labelKey">,
  t: (key: string) => string,
): string {
  return tag.label ?? t(tag.labelKey);
}

/** Flip a tag's `hidden` flag in place (catalogue eye-toggle). */
export function setTagHidden(
  catalog: ManageCatalog,
  tagKey: string,
  hidden: boolean,
): ManageCatalog {
  return mapTag(catalog, tagKey, (tag) => ({ ...tag, hidden }));
}

/** Flip a custom tag's `archived` flag in place (archive / restore). */
export function setTagArchived(
  catalog: ManageCatalog,
  tagKey: string,
  archived: boolean,
): ManageCatalog {
  return mapTag(catalog, tagKey, (tag) => ({ ...tag, archived }));
}

/** Remove a tag from the tree entirely (purge). */
export function removeTag(
  catalog: ManageCatalog,
  tagKey: string,
): ManageCatalog {
  return {
    categories: catalog.categories.map((category) => ({
      ...category,
      tags: category.tags.filter((tag) => tag.key !== tagKey),
    })),
  };
}

/** Move a tag to another group, appended after that group's tags. */
export function moveTagToGroup(
  catalog: ManageCatalog,
  tagKey: string,
  groupKey: string,
): ManageCatalog {
  let moved: ManageTag | undefined;
  const stripped = catalog.categories.map((category) => {
    const hit = category.tags.find((tag) => tag.key === tagKey);
    if (hit) moved = hit;
    return {
      ...category,
      tags: category.tags.filter((tag) => tag.key !== tagKey),
    };
  });
  if (!moved) return catalog;
  return {
    categories: stripped.map((category) =>
      category.key === groupKey
        ? { ...category, tags: [...category.tags, moved!] }
        : category,
    ),
  };
}

/** Re-order the tags of one group to `orderedKeys` (unknown keys kept last). */
export function reorderGroupTags(
  catalog: ManageCatalog,
  groupKey: string,
  orderedKeys: readonly string[],
): ManageCatalog {
  return {
    categories: catalog.categories.map((category) => {
      if (category.key !== groupKey) return category;
      const byKey = new Map(category.tags.map((tag) => [tag.key, tag]));
      const placed = orderedKeys
        .map((key) => byKey.get(key))
        .filter((tag): tag is ManageTag => tag !== undefined);
      const placedKeys = new Set(orderedKeys);
      const rest = category.tags.filter((tag) => !placedKeys.has(tag.key));
      return { ...category, tags: [...placed, ...rest] };
    }),
  };
}

/** Re-order the groups to `orderedKeys` (unknown keys kept last). */
export function reorderGroups(
  catalog: ManageCatalog,
  orderedKeys: readonly string[],
): ManageCatalog {
  const byKey = new Map(
    catalog.categories.map((category) => [category.key, category]),
  );
  const placed = orderedKeys
    .map((key) => byKey.get(key))
    .filter((category): category is ManageCategory => category !== undefined);
  const placedKeys = new Set(orderedKeys);
  const rest = catalog.categories.filter(
    (category) => !placedKeys.has(category.key),
  );
  return { categories: [...placed, ...rest] };
}

/** Current group-key order, for the layout PUT's `groupOrder`. */
export function buildGroupOrder(catalog: ManageCatalog): string[] {
  return catalog.categories.map((category) => category.key);
}

function mapTag(
  catalog: ManageCatalog,
  tagKey: string,
  fn: (tag: ManageTag) => ManageTag,
): ManageCatalog {
  return {
    categories: catalog.categories.map((category) => ({
      ...category,
      tags: category.tags.map((tag) => (tag.key === tagKey ? fn(tag) : tag)),
    })),
  };
}
