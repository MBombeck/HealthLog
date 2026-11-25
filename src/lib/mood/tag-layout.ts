import { z } from "zod/v4";
import { ownValue } from "@/lib/own-key";

/**
 * v1.17.0 — per-user mood-tag layout blob (`User.moodTagLayoutJson`).
 *
 * Display-only presentation state, byte-for-byte the
 * `medicationListLayoutJson` posture: the blob never carries authority over
 * data (a placement referencing a hidden / archived / unknown tag or a
 * deleted group is silently dropped at read time), PUT merges
 * preserve-when-absent, and unknown keys are tolerated rather than rejected
 * so a stale client can never wedge the read.
 *
 * Shape:
 *   groupOrder  — category keys in display order; unknown dropped, missing
 *                 appended in seeded `sortOrder`.
 *   placements  — categoryKey → ordered tag keys ("what lives where, in
 *                 what order"). A tag key appearing in some `placements[g]`
 *                 renders in group `g` at that index; un-placed tags render
 *                 in their home category after placed ones, in `sortOrder`.
 *                 This is how a CATALOGUE tag "moves" into a user's group —
 *                 its `categoryId` never changes.
 */

/** Upper bound on a single category/tag key on the wire. */
export const MOOD_TAG_LAYOUT_KEY_MAX_LENGTH = 80;
/** Upper bound on `groupOrder` entries (and `placements` record keys). */
export const MOOD_TAG_LAYOUT_MAX_GROUPS = 50;
/** Upper bound on placement tag keys summed across every group. */
export const MOOD_TAG_LAYOUT_MAX_PLACEMENTS = 400;

const layoutKeySchema = z.string().min(1).max(MOOD_TAG_LAYOUT_KEY_MAX_LENGTH);

/**
 * PUT body / stored-blob schema. Both fields optional so a client can PUT
 * exactly the field it changed (preserve-when-absent merge in the handler).
 */
export const moodTagLayoutSchema = z
  .object({
    groupOrder: z
      .array(layoutKeySchema)
      .max(MOOD_TAG_LAYOUT_MAX_GROUPS)
      .optional(),
    placements: z.record(layoutKeySchema, z.array(layoutKeySchema)).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.placements) return;
    const groupCount = Object.keys(value.placements).length;
    if (groupCount > MOOD_TAG_LAYOUT_MAX_GROUPS) {
      ctx.addIssue({
        code: "custom",
        path: ["placements"],
        message: `At most ${MOOD_TAG_LAYOUT_MAX_GROUPS} placement groups`,
      });
    }
    const total = Object.values(value.placements).reduce(
      (sum, keys) => sum + keys.length,
      0,
    );
    if (total > MOOD_TAG_LAYOUT_MAX_PLACEMENTS) {
      ctx.addIssue({
        code: "custom",
        path: ["placements"],
        message: `At most ${MOOD_TAG_LAYOUT_MAX_PLACEMENTS} placement entries`,
      });
    }
  });

export interface MoodTagLayout {
  groupOrder?: string[];
  placements?: Record<string, string[]>;
}

/**
 * Parse the stored JSON column into a layout. A malformed / legacy blob
 * degrades to the empty layout (seeded defaults) rather than failing the
 * read — the blob is presentation, never data.
 */
export function parseStoredMoodTagLayout(value: unknown): MoodTagLayout {
  const parsed = moodTagLayoutSchema.safeParse(value);
  if (!parsed.success) return {};
  return {
    ...(parsed.data.groupOrder !== undefined
      ? { groupOrder: parsed.data.groupOrder }
      : {}),
    ...(parsed.data.placements !== undefined
      ? { placements: parsed.data.placements }
      : {}),
  };
}

/**
 * Preserve-when-absent merge: a PUT carrying only `groupOrder` must not wipe
 * the stored `placements` and vice versa (the medications-layout contract).
 */
export function mergeMoodTagLayout(
  stored: MoodTagLayout,
  incoming: MoodTagLayout,
): MoodTagLayout {
  return {
    ...(incoming.groupOrder !== undefined
      ? { groupOrder: incoming.groupOrder }
      : stored.groupOrder !== undefined
        ? { groupOrder: stored.groupOrder }
        : {}),
    ...(incoming.placements !== undefined
      ? { placements: incoming.placements }
      : stored.placements !== undefined
        ? { placements: stored.placements }
        : {}),
  };
}

/**
 * Drop every reference to a (deleted) group from the layout: its
 * `groupOrder` entry and its `placements` bucket. Placements of OTHER
 * groups are untouched — a tag placed elsewhere keeps its slot.
 */
export function stripGroupFromLayout(
  layout: MoodTagLayout,
  groupKey: string,
): MoodTagLayout {
  const next: MoodTagLayout = {};
  if (layout.groupOrder !== undefined) {
    next.groupOrder = layout.groupOrder.filter((k) => k !== groupKey);
  }
  if (layout.placements !== undefined) {
    next.placements = Object.fromEntries(
      Object.entries(layout.placements).filter(([key]) => key !== groupKey),
    );
  }
  return next;
}

/**
 * Resolve the display order of category keys: layout order first (unknown
 * keys dropped, duplicates collapsed), then every known key the layout does
 * not mention, in the seeded order the caller passed.
 */
export function resolveGroupOrder(
  categoryKeysInSeededOrder: string[],
  groupOrder: string[] | undefined,
): string[] {
  const known = new Set(categoryKeysInSeededOrder);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const key of groupOrder ?? []) {
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  for (const key of categoryKeysInSeededOrder) {
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(key);
  }
  return ordered;
}

export interface ResolvedMoodTagPlacement {
  /** Category keys in final display order. */
  orderedCategoryKeys: string[];
  /** Tag keys per category key, placed-first then home-category remainder. */
  tagKeysByCategory: Map<string, string[]>;
}

/**
 * Apply the full layout to the visible tag set.
 *
 * `tags` must arrive in global `sortOrder` (the un-placed fallback order)
 * and contain only the tags the response will render — placements
 * referencing anything else (hidden, archived, unknown, another user's)
 * are dropped here by construction. A tag key claimed by two groups keeps
 * its first claim (group-order wins).
 */
export function resolveMoodTagPlacement(args: {
  categoryKeysInSeededOrder: string[];
  tags: Array<{ key: string; homeCategoryKey: string }>;
  layout: MoodTagLayout;
}): ResolvedMoodTagPlacement {
  const { categoryKeysInSeededOrder, tags, layout } = args;
  const orderedCategoryKeys = resolveGroupOrder(
    categoryKeysInSeededOrder,
    layout.groupOrder,
  );

  const visibleTagKeys = new Set(tags.map((t) => t.key));
  const tagKeysByCategory = new Map<string, string[]>(
    orderedCategoryKeys.map((key) => [key, []]),
  );

  // 1. Explicit placements, walked in group display order so a duplicate
  //    claim resolves deterministically.
  const placed = new Set<string>();
  for (const categoryKey of orderedCategoryKeys) {
    const placement = layout.placements
      ? ownValue(layout.placements, categoryKey)
      : undefined;
    if (!placement) continue;
    const bucket = tagKeysByCategory.get(categoryKey);
    if (!bucket) continue;
    for (const tagKey of placement) {
      if (!visibleTagKeys.has(tagKey) || placed.has(tagKey)) continue;
      placed.add(tagKey);
      bucket.push(tagKey);
    }
  }

  // 2. Un-placed tags fall back to their home category, after the placed
  //    ones, keeping global sortOrder. A tag whose home category is not in
  //    the response (inactive) drops — same posture as the v1.13 read.
  for (const tag of tags) {
    if (placed.has(tag.key)) continue;
    const bucket = tagKeysByCategory.get(tag.homeCategoryKey);
    if (!bucket) continue;
    bucket.push(tag.key);
  }

  return { orderedCategoryKeys, tagKeysByCategory };
}
