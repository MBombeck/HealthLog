/**
 * The restore half of the mood domain: the account's own categories, tags
 * and hidden set, then the entries with their day context and their links.
 * The export half lives in `mood-backup.ts`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { encryptNote } from "@/lib/crypto/note-cipher";
import {
  decodeEncryptedBytes,
  type RestoreContext,
} from "@/lib/export/restore-context";
import { recordUnknownKeys } from "@/lib/export/restore-skips";
import { sealForRestore } from "@/lib/export/sealed-text";
import type { BackupPayload } from "@/lib/validations/backup";

type BackupMoodEntry = BackupPayload["moodEntries"][number];

export async function clearMoodEntries(ctx: RestoreContext): Promise<void> {
  const moods = await ctx.tx.moodEntry.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.moodEntries = moods.count;
}

/**
 * The persisted mood rollup partition, wiped so the next analytics read does
 * not surface pre-restore daily means. The fold after the commit mints fresh
 * rows from the restored mood entries.
 */
export async function clearMoodRollups(ctx: RestoreContext): Promise<void> {
  await ctx.tx.moodEntryRollup.deleteMany({ where: { userId: ctx.ownerId } });
}

/**
 * The account's own categories and tags, written whether or not the file
 * carries a mood entry: an account that set up its mood vocabulary before
 * logging a single entry has them too, and they used to be written only
 * inside the entries branch.
 *
 * The CATEGORIES go in before the tags. A custom tag's `categoryId` is a real
 * foreign key, so writing the tag first threw `mood_tags_category_id_fkey`
 * and rolled the entire restore back — an account that had grouped its own
 * mood factors could not be restored at all, and the failure named a
 * constraint rather than the thing that was missing.
 *
 * Both are upserted by key: `key` is globally unique, so a seeded category or
 * tag that later claims the key must be left alone rather than overwritten by
 * a restore. The links resolve either way.
 */
async function restoreMoodVocabulary(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, skips } = ctx;
  // Labels this host's keys do not open, by file path.
  const unopenedMoodLabels: string[] = [];
  for (const category of payload.customMoodTagCategories) {
    await tx.moodTagCategory.upsert({
      where: { key: category.key },
      create: {
        id: category.id,
        userId: ownerId,
        key: category.key,
        labelKey: category.labelKey,
        icon: category.icon ?? null,
        sortOrder: category.sortOrder ?? 0,
        isActive: category.isActive ?? true,
        labelEncrypted: sealForRestore(
          category.labelEncrypted,
          category.label,
          `customMoodTagCategories.${category.key}.labelEncrypted`,
          unopenedMoodLabels,
        ),
      },
      update: {},
    });
  }

  // The account's own tag definitions. The entry lookup used to ask only for
  // the seeded catalogue (`userId: null`), so a single custom rated tag made
  // the whole restore throw "Unknown mood factor keys" — the file was
  // complete and unusable.
  for (const tag of payload.customMoodTags) {
    await tx.moodTag.upsert({
      where: { key: tag.key },
      create: {
        ...(tag.id ? { id: tag.id } : {}),
        userId: ownerId,
        key: tag.key,
        labelKey: tag.labelKey,
        categoryId: tag.categoryId,
        kind: tag.kind,
        isActive: tag.isActive,
        icon: tag.icon ?? null,
        sortOrder: tag.sortOrder,
        labelEncrypted: sealForRestore(
          tag.labelEncrypted,
          tag.label,
          `customMoodTags.${tag.key}.labelEncrypted`,
          unopenedMoodLabels,
        ),
        scaleMin: tag.scaleMin,
        scaleMax: tag.scaleMax,
        inverse: tag.inverse,
      },
      update: {},
    });
  }
  recordUnknownKeys(
    skips,
    "moodLabelCiphertext",
    unopenedMoodLabels,
    unopenedMoodLabels,
  );
}

/**
 * Which tags the account hid. Delete-then-recreate like every other section,
 * and resolved by KEY: what people hide is almost always a seeded tag, whose
 * id differs on every instance.
 *
 * A key this instance no longer knows costs one hidden row and is REPORTED.
 * Dropping it silently would un-hide a factor the person had deliberately
 * taken out of their mood editor, and they would have no way to know why it
 * came back.
 */
async function restoreHiddenMoodTags(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, skips } = ctx;
  await tx.moodTagHidden.deleteMany({ where: { userId: ownerId } });
  if (payload.hiddenMoodTags.length === 0) return;
  const hiddenKeys = payload.hiddenMoodTags.map((h) => h.key);
  const hiddenRows = await tx.moodTag.findMany({
    where: {
      key: { in: [...new Set(hiddenKeys)] },
      OR: [{ userId: null }, { userId: ownerId }],
    },
    select: { id: true, key: true },
  });
  const hiddenByKey = new Map(hiddenRows.map((row) => [row.key, row.id]));
  const unresolvedHidden: string[] = [];
  const writableHidden = payload.hiddenMoodTags.filter((entry) => {
    if (hiddenByKey.has(entry.key)) return true;
    unresolvedHidden.push(entry.key);
    return false;
  });
  if (writableHidden.length > 0) {
    await tx.moodTagHidden.createMany({
      data: writableHidden.map((entry) => ({
        userId: ownerId,
        moodTagId: hiddenByKey.get(entry.key)!,
        ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
      })),
      skipDuplicates: true,
    });
  }
  recordUnknownKeys(
    skips,
    "moodTag",
    [...new Set(unresolvedHidden)],
    unresolvedHidden,
  );
}

/** One entry's own columns, as the upsert writes them. */
function moodEntryData(entry: BackupMoodEntry) {
  const moodLoggedAt = new Date(entry.loggedAt);
  return {
    date: entry.date,
    mood: entry.mood,
    score: entry.score,
    // The five level-A values, carried the same way `syncVersion` is: absent
    // in the file means the file predates the columns, and an upsert whose
    // update arm stated them would wipe live answers off every matched row
    // when an older backup is restored over a going concern. A file that has
    // them writes them, including an explicit null; a file that does not
    // says nothing. Never derived — filling one in here would put a number
    // the person never gave into a restored row.
    ...(entry.a1 === undefined ? {} : { moodA1: entry.a1 }),
    ...(entry.a2 === undefined ? {} : { stressA2: entry.a2 }),
    ...(entry.a3 === undefined ? {} : { energyA3: entry.a3 }),
    ...(entry.a4 === undefined ? {} : { connectionA4: entry.a4 }),
    ...(entry.a5 === undefined ? {} : { stabilityA5: entry.a5 }),
    tags: entry.tags ?? null,
    // The note comes back the way every other dual-column note does:
    // ciphertext verbatim when the file carries it, and a portable file's
    // plaintext re-encrypted on the way in, with the legacy column left null
    // either way.
    note: null,
    noteEncrypted:
      entry.noteEncrypted == null
        ? encryptNote(entry.note ?? null)
        : decodeEncryptedBytes(entry.noteEncrypted),
    source: entry.source ?? "MOODLOG",
    externalId: entry.externalId ?? null,
    moodLoggedAt,
    // The zone the `date` string is anchored to. A file written before this
    // rode the payload carries nothing, and NULL is what such a row meant
    // anyway: the legacy Europe/Berlin reading. So an old file keeps its old
    // day boundaries and a new one keeps the zone the person actually logged
    // in.
    tz: entry.tz ?? null,
    // Mood reconciles last-writer-wins by `syncVersion`. Restoring at the
    // schema default would hand the next sync round to any paired device
    // still holding a higher number, and the device would overwrite the
    // recovered row with what it had — a restore that loses to the client is
    // worse than one that fails. An old file carries nothing here and keeps
    // the default, which is the value those rows were written with.
    ...(entry.syncVersion === undefined
      ? {}
      : { syncVersion: entry.syncVersion }),
    deletedAt: entry.deletedAt ? new Date(entry.deletedAt) : null,
    appleHealthDeletedAt: entry.appleHealthDeletedAt
      ? new Date(entry.appleHealthDeletedAt)
      : null,
    ...(entry.syncedAt ? { syncedAt: new Date(entry.syncedAt) } : {}),
    ...(entry.createdAt ? { createdAt: new Date(entry.createdAt) } : {}),
    ...(entry.updatedAt ? { updatedAt: new Date(entry.updatedAt) } : {}),
  };
}

/**
 * The day context, rebuilt after the entry so it can bind to whatever id that
 * entry actually got. Delete-then-write rather than an upsert with a
 * preserve-when-absent arm: the file states the whole context or states that
 * there was none, and a restored entry carrying half a file's context and
 * half a live row's would be a state neither of them describes.
 */
async function restoreMoodContext(
  tx: Prisma.TransactionClient,
  ownerId: string,
  moodEntryId: string,
  entry: BackupMoodEntry,
): Promise<void> {
  await tx.moodContext.deleteMany({ where: { moodEntryId } });
  if (!entry.context) return;
  const context = entry.context;
  await tx.moodContext.create({
    data: {
      moodEntryId,
      userId: ownerId,
      workStatus: context.workStatus ?? null,
      workMinutes: context.workMinutes ?? null,
      overtimeMinutes: context.overtimeMinutes ?? null,
      workLoad: context.workLoad ?? null,
      workSatisfaction: context.workSatisfaction ?? null,
      contactCircles: context.contactCircles ?? null,
      contactForm: context.contactForm ?? null,
      contactExtent: context.contactExtent ?? null,
      contactQuality: context.contactQuality ?? null,
      contactSupport: context.contactSupport ?? null,
      leisureCategories: context.leisureCategories ?? null,
      leisureMinutes: context.leisureMinutes ?? null,
      leisureJoy: context.leisureJoy ?? null,
      leisureRecovery: context.leisureRecovery ?? null,
      eventType: context.eventType ?? null,
      eventValence: context.eventValence ?? null,
      eventAt: context.eventAt ? new Date(context.eventAt) : null,
      // The note comes back the way every other dual-column note does:
      // ciphertext verbatim when the file carries it, a portable file's
      // plain text re-encrypted on the way in.
      notesEncrypted:
        context.notesEncrypted == null
          ? encryptNote(context.note ?? null)
          : decodeEncryptedBytes(context.notesEncrypted),
      // The row's own stamps when the file carries them (disaster recovery).
      ...(context.createdAt ? { createdAt: new Date(context.createdAt) } : {}),
      ...(context.updatedAt ? { updatedAt: new Date(context.updatedAt) } : {}),
    },
  });
}

/** One entry, its day context and its links. */
async function restoreMoodEntry(
  tx: Prisma.TransactionClient,
  ownerId: string,
  entry: BackupMoodEntry,
  factorByKey: ReadonlyMap<string, string>,
  tagByKey: ReadonlyMap<string, string>,
): Promise<void> {
  const restoredData = moodEntryData(entry);
  const createData = { userId: ownerId, ...restoredData };
  const restored = entry.id
    ? await tx.moodEntry.upsert({
        where: { id: entry.id, userId: ownerId },
        create: { id: entry.id, ...createData },
        update: restoredData,
      })
    : entry.externalId
      ? await tx.moodEntry.upsert({
          where: {
            userId_source_externalId: {
              userId: ownerId,
              source: restoredData.source,
              externalId: entry.externalId,
            },
          },
          create: createData,
          update: restoredData,
        })
      : await tx.moodEntry.upsert({
          where: {
            userId_date_moodLoggedAt: {
              userId: ownerId,
              date: entry.date,
              moodLoggedAt: restoredData.moodLoggedAt,
            },
          },
          create: createData,
          update: restoredData,
        });

  await restoreMoodContext(tx, ownerId, restored.id, entry);

  await tx.moodEntryTagLink.deleteMany({
    where: { moodEntryId: restored.id },
  });
  const factorLinks = entry.factors.flatMap((factor) => {
    const moodTagId = factorByKey.get(factor.key);
    return moodTagId
      ? [{ moodEntryId: restored.id, moodTagId, rating: factor.rating }]
      : [];
  });
  // The other arm. A BINARY link carries no score — the presence of the row
  // is the signal — so `rating` is NULL by definition, which is exactly what
  // the backup's old tag-link filter took to mean "nothing here".
  const tagLinks = entry.structuredTags.flatMap((key) => {
    const moodTagId = tagByKey.get(key);
    return moodTagId
      ? [{ moodEntryId: restored.id, moodTagId, rating: null }]
      : [];
  });
  // Each link's own write time, when the file carries it.
  const linkCreatedAt = new Map(
    (entry.linkCreatedAt ?? []).map((link) => [link.key, link.createdAt]),
  );
  const keyOfTag = new Map<string, string>();
  for (const [key, id] of [...factorByKey, ...tagByKey]) keyOfTag.set(id, key);
  const links = [...factorLinks, ...tagLinks].map((link) => {
    const createdAt = linkCreatedAt.get(keyOfTag.get(link.moodTagId) ?? "");
    return createdAt ? { ...link, createdAt: new Date(createdAt) } : link;
  });
  if (links.length > 0) {
    await tx.moodEntryTagLink.createMany({ data: links });
  }
}

async function restoreMoodEntries(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, skips } = ctx;
  if (payload.moodEntries.length === 0) return;
  const referencedFactorKeys = payload.moodEntries.flatMap((entry) =>
    entry.factors.map((factor) => factor.key),
  );
  const factorKeys = [...new Set(referencedFactorKeys)];
  const referencedTagKeys = payload.moodEntries.flatMap(
    (entry) => entry.structuredTags,
  );
  const tagKeys = [...new Set(referencedTagKeys)];
  const factorRows =
    factorKeys.length === 0
      ? []
      : await tx.moodTag.findMany({
          where: {
            key: { in: factorKeys },
            kind: "RATED",
            // The seeded catalogue OR this account's own tags.
            OR: [{ userId: null }, { userId: ownerId }],
          },
          select: { id: true, key: true },
        });
  const factorByKey = new Map(
    factorRows.map((factor) => [factor.key, factor.id]),
  );
  // A rated tag this instance does not know costs the entry's link to it, not
  // the entry. The mood, the score, the date, the free tags — everything the
  // person logged — comes back; the one rating that has nowhere to attach is
  // dropped and named. Refusing the file instead meant a renamed seeded tag
  // made the whole account unrecoverable.
  recordUnknownKeys(
    skips,
    "moodFactor",
    factorKeys.filter((key) => !factorByKey.has(key)),
    referencedFactorKeys,
  );

  // The BINARY half of the same taxonomy, looked up the same way and reported
  // the same way. It gets its own family because an operator reading the
  // report needs to know whether a rated factor's score or a ticked tag went
  // missing; they are different losses on the same entry.
  const tagRows =
    tagKeys.length === 0
      ? []
      : await tx.moodTag.findMany({
          where: {
            key: { in: tagKeys },
            kind: "BINARY",
            OR: [{ userId: null }, { userId: ownerId }],
          },
          select: { id: true, key: true },
        });
  const tagByKey = new Map(tagRows.map((tag) => [tag.key, tag.id]));
  recordUnknownKeys(
    skips,
    "moodTag",
    tagKeys.filter((key) => !tagByKey.has(key)),
    referencedTagKeys,
  );

  for (const entry of payload.moodEntries) {
    await restoreMoodEntry(tx, ownerId, entry, factorByKey, tagByKey);
  }
}

export async function restoreMood(ctx: RestoreContext): Promise<void> {
  ctx.reportSection("mood");
  await restoreMoodVocabulary(ctx);
  await restoreHiddenMoodTags(ctx);
  await restoreMoodEntries(ctx);
}
