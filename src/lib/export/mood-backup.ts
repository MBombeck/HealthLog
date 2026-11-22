/**
 * The mood domain's export half: the entries with their day context and
 * their links, and the account's own categories, tags and hidden set. The
 * restore half lives in `mood-restore.ts`.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { readNote } from "@/lib/crypto/note-cipher";
import {
  BULK_PAGE_SIZE,
  collect,
  deferredRows,
} from "@/lib/export/deferred-rows";
import type {
  BackupExportContext,
  BackupExportPart,
} from "@/lib/export/export-context";
import { openSealedForExport } from "@/lib/export/sealed-text";

/**
 * Every restorable `MoodEntry` scalar. `userId` is absent for the same reason
 * it is absent above: the backup is user-scoped and the owner is re-derived
 * from the restoring account.
 *
 * Named rather than inlined so `mood-backup-completeness.test.ts` can compare
 * it field-by-field against the model in `prisma/schema.prisma`, exactly as the
 * measurement guard does for the select above.
 */
const MOOD_ENTRY_BACKUP_SELECT = {
  id: true,
  date: true,
  mood: true,
  score: true,
  moodA1: true,
  stressA2: true,
  energyA3: true,
  connectionA4: true,
  stabilityA5: true,
  tags: true,
  note: true,
  noteEncrypted: true,
  source: true,
  externalId: true,
  moodLoggedAt: true,
  tz: true,
  syncedAt: true,
  syncVersion: true,
  deletedAt: true,
  appleHealthDeletedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MoodEntrySelect;

/**
 * A structured-tag link, as it rides the wire. The link is carried by the
 * tag's KEY, not by its id: a restore resolves the key against the target
 * instance's catalogue, where the source instance's row id may not exist at
 * all. `kind` comes along so the mapper can split RATED factors from BINARY
 * tags without a second query.
 */
const MOOD_ENTRY_TAG_LINK_SELECT = {
  rating: true,
  createdAt: true,
  moodTag: { select: { key: true, kind: true } },
} as const satisfies Prisma.MoodEntryTagLinkSelect;

/**
 * Every restorable `MoodContext` scalar.
 *
 * `moodEntryId` and `userId` are absent for the reasons the exclusion list in
 * `mood-backup-completeness.test.ts` states: the context rides inside its
 * entry and is re-bound to whatever id that entry got, and the owner is
 * re-derived from the restoring account. The two row stamps travel in the
 * disaster-recovery file only, which gives the account back as it was.
 *
 * Named rather than inlined so the guard can compare it field-by-field against
 * the model, exactly as it does for the two selects above. This is the whole
 * point of the pair: a column added to `MoodContext` without a line here
 * fails, and it fails in the release that added it.
 */
const MOOD_CONTEXT_BACKUP_SELECT = {
  workStatus: true,
  workMinutes: true,
  overtimeMinutes: true,
  workLoad: true,
  workSatisfaction: true,
  contactCircles: true,
  contactForm: true,
  contactExtent: true,
  contactQuality: true,
  contactSupport: true,
  leisureCategories: true,
  leisureMinutes: true,
  leisureJoy: true,
  leisureRecovery: true,
  eventType: true,
  eventValence: true,
  eventAt: true,
  notesEncrypted: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MoodContextSelect;

type BackupMoodContext = Prisma.MoodContextGetPayload<{
  select: typeof MOOD_CONTEXT_BACKUP_SELECT;
}>;

/**
 * The mood read, select and joins together. Named because two readers issue
 * it — the materialising one and the paged one — and a select that lived in
 * only one of them is exactly the drift the completeness guard cannot see.
 */
const MOOD_ENTRY_QUERY_SELECT = {
  ...MOOD_ENTRY_BACKUP_SELECT,
  // Every link, not only the rated ones. This read used to filter
  // `rating: { not: null }`, and a BINARY link carries a NULL rating by
  // definition — so the present/absent tags, the kind most people pick,
  // were absent from the file and could not come back from it.
  tagLinks: {
    select: MOOD_ENTRY_TAG_LINK_SELECT,
    orderBy: { moodTagId: "asc" },
  },
  // The day context, when the entry has one. Sparse by design — most
  // entries carry none, and the join answers null on those.
  context: { select: MOOD_CONTEXT_BACKUP_SELECT },
} as const satisfies Prisma.MoodEntrySelect;

type BackupMoodEntry = Prisma.MoodEntryGetPayload<{
  select: typeof MOOD_ENTRY_QUERY_SELECT;
}>;

/**
 * One context row, in whichever of the two wire shapes the caller asked for.
 *
 * The split is the same one `Measurement` makes: a disaster-recovery file
 * carries the ciphertext verbatim, because the instance that reads it back
 * holds the key; a portable export carries the plain text, because the point
 * of a portable file is that somebody can read it. Every other column rides in
 * both, since none of them is a storage detail — they are all answers somebody
 * gave.
 *
 * The parameter is spelled `moodContext` rather than `c`, deliberately: the
 * completeness guard proves a selected column reaches a payload by matching
 * `moodContext.<column>`, and a one-letter parameter shared with another
 * mapper in this file would make that matcher unable to fail.
 */
function serialiseMoodContext(
  moodContext: BackupMoodContext,
  disasterRecovery: boolean,
) {
  return {
    ...(disasterRecovery
      ? {
          notesEncrypted: moodContext.notesEncrypted
            ? Buffer.from(moodContext.notesEncrypted).toString("base64")
            : null,
          createdAt: moodContext.createdAt.toISOString(),
          updatedAt: moodContext.updatedAt.toISOString(),
        }
      : { note: readNote(moodContext.notesEncrypted, null) }),
    workStatus: moodContext.workStatus,
    workMinutes: moodContext.workMinutes,
    overtimeMinutes: moodContext.overtimeMinutes,
    workLoad: moodContext.workLoad,
    workSatisfaction: moodContext.workSatisfaction,
    // The two multi-selects ride as the stored JSON string, unparsed. The
    // restore writes the column back verbatim, so a file cannot arrive with a
    // list the parser and the column disagree about.
    contactCircles: moodContext.contactCircles,
    contactForm: moodContext.contactForm,
    contactExtent: moodContext.contactExtent,
    contactQuality: moodContext.contactQuality,
    contactSupport: moodContext.contactSupport,
    leisureCategories: moodContext.leisureCategories,
    leisureMinutes: moodContext.leisureMinutes,
    leisureJoy: moodContext.leisureJoy,
    leisureRecovery: moodContext.leisureRecovery,
    eventType: moodContext.eventType,
    eventValence: moodContext.eventValence,
    eventAt: moodContext.eventAt?.toISOString() ?? null,
  };
}

/**
 * One mood entry, with its links partitioned and its day context folded in.
 *
 * The parameter is spelled out rather than the `e` every other mapper here
 * uses, and deliberately: `mood-backup-completeness.test.ts` proves a
 * selected column reaches a payload by matching `: moodEntry.`. A matcher
 * on `: e.` would also match any other mapper's one-letter parameter and could
 * therefore never fail.
 */
function serialiseMoodEntry(
  moodEntry: BackupMoodEntry,
  disasterRecovery: boolean,
) {
  // The two link arms partition the entry's links exhaustively: a link is
  // a rated factor when its tag is RATED and it actually carries a score,
  // and a structured tag otherwise. Total on purpose — a malformed link
  // (a RATED tag whose rating went missing) rides as a tag key and comes
  // back NAMED as unresolvable on restore, rather than falling between the
  // two arms and disappearing the way every BINARY link used to.
  const isRatedFactor = (link: (typeof moodEntry.tagLinks)[number]) =>
    link.moodTag.kind === "RATED" && link.rating !== null;

  const factors = moodEntry.tagLinks.filter(isRatedFactor).map((tagLink) => ({
    key: tagLink.moodTag.key,
    rating: tagLink.rating as number,
  }));
  // BINARY link keys. Their own array rather than a nullable rating inside
  // `factors`: the restore resolves `factors` against `kind: "RATED"` and
  // reports what it cannot resolve, so a rating-less entry in that array
  // would collide with both. A separate key leaves every backup file
  // written before this parsing and restoring exactly as it did.
  const structuredTags = moodEntry.tagLinks
    .filter((link) => !isRatedFactor(link))
    .map((tagLink) => tagLink.moodTag.key);

  return {
    ...(disasterRecovery
      ? {
          note: moodEntry.note,
          noteEncrypted: moodEntry.noteEncrypted
            ? Buffer.from(moodEntry.noteEncrypted).toString("base64")
            : null,
          syncedAt: moodEntry.syncedAt.toISOString(),
          syncVersion: moodEntry.syncVersion,
          // Who deleted a tombstone: only where the phone reported it.
          ...(moodEntry.appleHealthDeletedAt
            ? {
                appleHealthDeletedAt:
                  moodEntry.appleHealthDeletedAt.toISOString(),
              }
            : {}),
          createdAt: moodEntry.createdAt.toISOString(),
          updatedAt: moodEntry.updatedAt.toISOString(),
          // When each link was written, by tag key, for both link arms.
          linkCreatedAt: moodEntry.tagLinks.map((tagLink) => ({
            key: tagLink.moodTag.key,
            createdAt: tagLink.createdAt.toISOString(),
          })),
        }
      : { note: readNote(moodEntry.noteEncrypted, moodEntry.note) }),
    id: moodEntry.id,
    date: moodEntry.date,
    mood: moodEntry.mood,
    score: moodEntry.score,
    // The five level-A values, under the keys the write path takes. Both
    // arms carry them: they are the entry's own answers, not a storage
    // detail, and a portable export that dropped them would hand back a
    // file describing the day less well than the row it came from.
    a1: moodEntry.moodA1,
    a2: moodEntry.stressA2,
    a3: moodEntry.energyA3,
    a4: moodEntry.connectionA4,
    a5: moodEntry.stabilityA5,
    tags: moodEntry.tags,
    source: moodEntry.source,
    loggedAt: moodEntry.moodLoggedAt.toISOString(),
    externalId: moodEntry.externalId,
    // The zone the `date` string is anchored to. Without it a restored row
    // falls back to the legacy Europe/Berlin reading and an account that
    // logged elsewhere gets its day boundaries quietly moved.
    tz: moodEntry.tz,
    deletedAt: moodEntry.deletedAt?.toISOString() ?? null,
    factors,
    structuredTags,
    // The day context, or null. Null rather than an empty object, because
    // "no context" and "a context whose every field is empty" are
    // different facts and the restore has to keep them apart.
    context: moodEntry.context
      ? serialiseMoodContext(moodEntry.context, disasterRecovery)
      : null,
  };
}

/**
 * Every backup mood entry, one serialised row at a time.
 *
 * Same total-order argument as the intake events above: `moodLoggedAt desc`
 * alone is not a cursor, and two entries logged in the same millisecond are
 * exactly what a bulk import produces.
 */
export async function* iterateBackupMoodEntries(
  prisma: PrismaClient,
  userId: string,
  disasterRecovery: boolean,
): AsyncGenerator<Record<string, unknown>, void, void> {
  let cursorId: string | null = null;
  for (;;) {
    const page: BackupMoodEntry[] = await prisma.moodEntry.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: [{ moodLoggedAt: "desc" }, { id: "desc" }],
      take: BULK_PAGE_SIZE,
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: MOOD_ENTRY_QUERY_SELECT,
    });
    if (page.length === 0) return;
    for (const moodEntry of page) {
      yield serialiseMoodEntry(moodEntry, disasterRecovery);
    }
    if (page.length < BULK_PAGE_SIZE) return;
    cursorId = page[page.length - 1]!.id;
  }
}

/**
 * The mood slice of the payload: the entries (rows, or a marker for them),
 * then the account's own categories, hidden set and tags.
 */
export async function buildMoodBackupPart(
  ctx: BackupExportContext,
): Promise<BackupExportPart> {
  const { prisma, userId, disasterRecovery } = ctx;
  const [moodEntries, customMoodTags, customMoodTagCategories, hiddenMoodTags] =
    await Promise.all([
      ctx.deferBulk
        ? null
        : collect(iterateBackupMoodEntries(prisma, userId, disasterRecovery)),
      // The account's OWN mood tags. The seeded catalogue is reference data every
      // instance has; a tag the user made lives only here. Without it the restore
      // cannot resolve the entry's factor keys — and unlike the cycle path, which
      // used to drop them silently, the mood path throws, so an account with one
      // custom rated tag could not be restored at all.
      prisma.moodTag.findMany({
        where: { userId },
        orderBy: [{ key: "asc" }, { id: "asc" }],
      }),
      // The account's OWN categories. Seeded ones (`userId: null`) belong to the
      // instance and are deliberately not carried — but a custom tag's
      // `categoryId` is a real foreign key, so a category the account created
      // itself has to travel or the tag above cannot be written at all. Before
      // this section existed, that was not a gap in the restore: it was a
      // constraint violation that took the WHOLE file down with it, so an
      // account that had ever grouped its own mood factors could not be
      // restored.
      prisma.moodTagCategory.findMany({
        where: { userId },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      }),
      // Which tags the account chose to hide. Carried by KEY rather than id:
      // what people hide is almost always a SEEDED tag, whose id differs on
      // every instance, so an id would resolve to nothing on the way back.
      prisma.moodTagHidden.findMany({
        where: { userId },
        select: { moodTag: { select: { key: true } }, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { moodTagId: "asc" }],
      }),
    ]);
  return {
    section: {
      moodEntries: ctx.deferBulk
        ? deferredRows(() =>
            iterateBackupMoodEntries(prisma, userId, disasterRecovery),
          )
        : moodEntries!,
      customMoodTagCategories: customMoodTagCategories.map((category) => ({
        id: category.id,
        key: category.key,
        labelKey: category.labelKey,
        icon: category.icon,
        sortOrder: category.sortOrder,
        isActive: category.isActive,
        // The person's own words: ciphertext in a disaster-recovery payload,
        // readable in a portable one (see `sealed-text.ts`).
        ...(disasterRecovery
          ? { labelEncrypted: category.labelEncrypted }
          : {
              label: category.labelEncrypted
                ? openSealedForExport(
                    category.labelEncrypted,
                    "mood category label",
                  )
                : null,
            }),
      })),
      hiddenMoodTags: hiddenMoodTags.map((hidden) => ({
        key: hidden.moodTag.key,
        createdAt: hidden.createdAt.toISOString(),
      })),
      customMoodTags: customMoodTags.map((tag) => ({
        ...(disasterRecovery ? { id: tag.id } : {}),
        key: tag.key,
        labelKey: tag.labelKey,
        categoryId: tag.categoryId,
        kind: tag.kind,
        isActive: tag.isActive,
        icon: tag.icon,
        sortOrder: tag.sortOrder,
        // Ciphertext in a disaster-recovery payload (the same instance's key
        // reads it back), readable in a portable one (see `sealed-text.ts`).
        ...(disasterRecovery
          ? { labelEncrypted: tag.labelEncrypted }
          : {
              label: tag.labelEncrypted
                ? openSealedForExport(tag.labelEncrypted, "mood tag label")
                : null,
            }),
        scaleMin: tag.scaleMin,
        scaleMax: tag.scaleMax,
        inverse: tag.inverse,
      })),
    },
    counts: {
      moodEntries: moodEntries?.length ?? 0,
      customMoodTagCategories: customMoodTagCategories.length,
      hiddenMoodTags: hiddenMoodTags.length,
    },
  };
}
