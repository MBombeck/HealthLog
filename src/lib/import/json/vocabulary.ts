/**
 * The account's own mood vocabulary, brought along by a JSON import.
 *
 * A mood entry links to tags by key: the seeded catalogue's, and the ones the
 * person made (custom tags, their own rated factors, the groups they sit in).
 * A full backup carries the account's own as `customMoodTags` and
 * `customMoodTagCategories`. Without them an entry imported into another
 * account landed without every link to a tag the person had made.
 *
 * So before the entries are written, each key an entry or the file names is
 * resolved once, to the tag the importing account links to:
 *
 *   - a catalogue tag, or a tag the account already owns, is used as it is.
 *     An own tag whose label differs from the file's is kept, never
 *     overwritten, and named (`keptMoodTagKeys`): the account's name for it
 *     is the one it uses now;
 *   - a tag the file defines and the account lacks is created, under its own
 *     key, in its group (created the same way when missing);
 *   - a key another account on this instance holds (keys are unique per
 *     instance, so a file moved between two accounts of one server collides)
 *     comes over under a key derived from the account and the file's key, so
 *     importing the same file twice finds the copy rather than making a
 *     second one;
 *   - anything else (a key neither the catalogue nor the file knows, the
 *     wrong kind for its link, a tag past the account's custom-tag cap) is
 *     dropped from the entries and named.
 */
import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { sealForRestore } from "@/lib/export/sealed-text";
import {
  CUSTOM_CATEGORY_KEY_PREFIX,
  CUSTOM_TAG_KEY_PREFIX,
  decryptCustomLabel,
  MAX_CUSTOM_GROUPS_PER_USER,
  MAX_CUSTOM_TAGS_PER_USER,
} from "@/lib/mood/custom-tags";

import type {
  JsonImportMoodEntry,
  JsonImportMoodTag,
  JsonImportMoodTagCategory,
} from "./schema";
import type { JsonImportTally } from "./tally";

/** A tag an imported link may point at. */
export interface ImportLinkTag {
  id: string;
  kind: string;
  scaleMin: number;
  scaleMax: number;
}

/** The file's keys, resolved to the importing account's tags. */
export type MoodLinkResolver = ReadonlyMap<string, ImportLinkTag>;

/** The seeded group a tag lands in when the file does not carry its own. */
const FALLBACK_CATEGORY_KEY = "custom";

const LINK_TAG_SELECT = {
  id: true,
  key: true,
  kind: true,
  scaleMin: true,
  scaleMax: true,
  userId: true,
  labelEncrypted: true,
} as const satisfies Prisma.MoodTagSelect;

/**
 * The key a copy of `fileKey` carries in `userId`'s account when another
 * account holds `fileKey`: a fresh-looking custom key, the same on every
 * import of the same file into the same account.
 */
export function derivedVocabularyKey(
  prefix: string,
  userId: string,
  fileKey: string,
): string {
  const hex = createHash("sha256")
    .update(`${userId}\u0000${fileKey}`)
    .digest("hex");
  return `${prefix}${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The file's readable label, or the one its ciphertext opens to here. */
function fileLabel(item: {
  label?: string;
  labelEncrypted?: string;
}): string | null {
  if (item.label !== undefined) return item.label;
  return item.labelEncrypted ? decryptCustomLabel(item.labelEncrypted) : null;
}

/** The label column for a row written from `item`, sealed under this host's key. */
function sealedLabel(
  item: { label?: string; labelEncrypted?: string },
  path: string,
): string | null {
  return sealForRestore(item.labelEncrypted, item.label, path, []);
}

class Vocabulary {
  private readonly categoryIds = new Map<string, string | null>();
  private ownTags = 0;
  private ownGroups = 0;

  constructor(
    private readonly userId: string,
    private readonly categories: readonly JsonImportMoodTagCategory[],
    private readonly tally: JsonImportTally,
  ) {}

  async countOwn(): Promise<void> {
    [this.ownTags, this.ownGroups] = await Promise.all([
      prisma.moodTag.count({ where: { userId: this.userId, isActive: true } }),
      prisma.moodTagCategory.count({ where: { userId: this.userId } }),
    ]);
  }

  /** The importing account's group for a tag of the file, or null. */
  async category(fileCategoryId: string): Promise<string | null> {
    const cached = this.categoryIds.get(fileCategoryId);
    if (cached !== undefined) return cached;
    const resolved = await this.resolveCategory(fileCategoryId);
    this.categoryIds.set(fileCategoryId, resolved);
    return resolved;
  }

  private async resolveCategory(
    fileCategoryId: string,
  ): Promise<string | null> {
    const own = this.categories.find((c) => c.id === fileCategoryId);
    if (!own) {
      // A seeded group of the instance the file came from. Its id is this
      // instance's only when the file came from here; otherwise the tag goes
      // to the seeded group made for custom tags.
      const seeded =
        (await prisma.moodTagCategory.findFirst({
          where: { userId: null, id: fileCategoryId },
          select: { id: true },
        })) ??
        (await prisma.moodTagCategory.findFirst({
          where: { userId: null, key: FALLBACK_CATEGORY_KEY },
          select: { id: true },
        }));
      return seeded?.id ?? null;
    }
    const existing = await prisma.moodTagCategory.findUnique({
      where: { key: own.key },
      select: { id: true, userId: true, labelEncrypted: true },
    });
    if (
      existing &&
      (existing.userId === null || existing.userId === this.userId)
    ) {
      const label = fileLabel(own);
      if (
        existing.userId === this.userId &&
        label !== null &&
        decryptCustomLabel(existing.labelEncrypted) !== label
      ) {
        this.tally.keptMoodCategoryKeys.add(own.key);
      }
      return existing.id;
    }
    const key = existing
      ? derivedVocabularyKey(CUSTOM_CATEGORY_KEY_PREFIX, this.userId, own.key)
      : own.key;
    const copy = await prisma.moodTagCategory.findUnique({
      where: { key },
      select: { id: true, userId: true },
    });
    if (copy) return copy.userId === this.userId ? copy.id : null;
    if (this.ownGroups >= MAX_CUSTOM_GROUPS_PER_USER) return null;
    const created = await prisma.moodTagCategory.create({
      data: {
        userId: this.userId,
        key,
        labelKey: own.labelKey,
        icon: own.icon ?? null,
        sortOrder: own.sortOrder ?? 0,
        isActive: own.isActive ?? true,
        labelEncrypted: sealedLabel(own, `customMoodTagCategories.${own.key}`),
      },
      select: { id: true },
    });
    this.ownGroups += 1;
    return created.id;
  }

  /** Create `tag` in the importing account under `key`; null when it cannot be. */
  async create(
    tag: JsonImportMoodTag,
    key: string,
  ): Promise<ImportLinkTag | null> {
    const active = tag.isActive ?? true;
    if (active && this.ownTags >= MAX_CUSTOM_TAGS_PER_USER) return null;
    const categoryId = await this.category(tag.categoryId);
    if (categoryId === null) return null;
    const created = await prisma.moodTag.create({
      data: {
        userId: this.userId,
        key,
        labelKey: tag.labelKey,
        categoryId,
        kind: tag.kind,
        isActive: active,
        icon: tag.icon ?? null,
        sortOrder: tag.sortOrder ?? 0,
        labelEncrypted: sealedLabel(tag, `customMoodTags.${tag.key}`),
        scaleMin: tag.scaleMin ?? 1,
        scaleMax: tag.scaleMax ?? 5,
        inverse: tag.inverse ?? false,
      },
      select: LINK_TAG_SELECT,
    });
    if (active) this.ownTags += 1;
    return created;
  }
}

/**
 * Resolve every key the file's entries link to, creating the account's own
 * tags and groups the file brings and the account lacks. Keys that resolve
 * to nothing are named on the tally by the link writer, which knows which
 * kind of link asked for them.
 */
export async function resolveMoodVocabulary(input: {
  userId: string;
  entries: readonly JsonImportMoodEntry[];
  categories: readonly JsonImportMoodTagCategory[];
  tags: readonly JsonImportMoodTag[];
  tally: JsonImportTally;
}): Promise<MoodLinkResolver> {
  const { userId, entries, tally } = input;
  const definitions = new Map(input.tags.map((tag) => [tag.key, tag]));
  const keys = new Set<string>(definitions.keys());
  for (const entry of entries) {
    for (const factor of entry.factors ?? []) keys.add(factor.key);
    for (const key of entry.structuredTags ?? []) keys.add(key);
  }
  const resolved = new Map<string, ImportLinkTag>();
  if (keys.size === 0) return resolved;

  const derived = new Map(
    [...definitions.keys()].map((key) => [
      key,
      derivedVocabularyKey(CUSTOM_TAG_KEY_PREFIX, userId, key),
    ]),
  );
  const rows = await prisma.moodTag.findMany({
    where: { key: { in: [...keys, ...derived.values()] } },
    select: LINK_TAG_SELECT,
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const vocabulary = new Vocabulary(userId, input.categories, tally);
  await vocabulary.countOwn();

  for (const key of keys) {
    const definition = definitions.get(key);
    const row = byKey.get(key);
    if (row && (row.userId === null || row.userId === userId)) {
      const label = definition ? fileLabel(definition) : null;
      if (
        row.userId === userId &&
        label !== null &&
        decryptCustomLabel(row.labelEncrypted) !== label
      ) {
        tally.keptMoodTagKeys.add(key);
      }
      resolved.set(key, row);
      continue;
    }
    if (!definition) continue;
    const target = row ? derived.get(key)! : key;
    const copy = row ? byKey.get(target) : undefined;
    if (copy) {
      if (copy.userId === userId) resolved.set(key, copy);
      continue;
    }
    const created = await vocabulary.create(definition, target);
    if (created) resolved.set(key, created);
  }
  return resolved;
}
