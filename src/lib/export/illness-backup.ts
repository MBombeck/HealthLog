/**
 * The illness history: episodes, their day logs, and the symptoms each day
 * recorded. Both backup ends in one file.
 */
import { Buffer } from "node:buffer";

import type { PrismaClient } from "@/generated/prisma/client";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  toIllnessEpisodeDTO,
  toIllnessDayLogDTO,
  dayLogSymptomInclude,
  type IllnessEpisodeDTO,
  type IllnessDayLogDTO,
} from "@/lib/illness/dto";
import {
  decodeEncryptedBytes,
  type RestoreContext,
} from "@/lib/export/restore-context";
import { recordUnknownKeys } from "@/lib/export/restore-skips";

// ── Export ───────────────────────────────────────────────────────────────────

type CanonicalIllnessDayLog = IllnessDayLogDTO & {
  noteEncrypted?: string | null;
  tz?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
};

export type CanonicalIllnessEpisode = IllnessEpisodeDTO & {
  noteEncrypted?: string | null;
  /** The body site's ciphertext, disaster-recovery purpose only (v1.39.2). */
  bodySiteEncrypted?: string | null;
  deletedAt?: string | null;
  dayLogs: CanonicalIllnessDayLog[];
};

/** The illness slice of the records section: episodes with their day logs. */
export async function buildIllnessBackupSlice(
  prisma: Pick<PrismaClient, "illnessEpisode">,
  userId: string,
  disasterRecovery: boolean,
): Promise<{ illnessEpisodes: CanonicalIllnessEpisode[] }> {
  const episodeRows = await prisma.illnessEpisode.findMany({
    where: disasterRecovery ? { userId } : { userId, deletedAt: null },
    orderBy: [{ onsetAt: "desc" }, { id: "asc" }],
    include: {
      dayLogs: {
        ...(disasterRecovery ? {} : { where: { deletedAt: null } }),
        orderBy: [{ date: "asc" }, { id: "asc" }],
        include: {
          symptomLinks: {
            ...dayLogSymptomInclude.symptomLinks,
            orderBy: { symptomId: "asc" },
          },
        },
      },
    },
  });

  const illnessEpisodes: CanonicalIllnessEpisode[] = disasterRecovery
    ? episodeRows.map((row) => ({
        id: row.id,
        label: row.label,
        type: row.type,
        lifecycle: row.lifecycle,
        onsetAt: row.onsetAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        parentConditionId: row.parentConditionId,
        note: null,
        noteEncrypted: row.noteEncrypted
          ? Buffer.from(row.noteEncrypted).toString("base64")
          : null,
        // Ciphertext verbatim, like the note: the disaster-recovery file never
        // carries the site in the clear.
        bodySite: null,
        bodySiteEncrypted: row.bodySiteEncrypted
          ? Buffer.from(row.bodySiteEncrypted).toString("base64")
          : null,
        laterality: row.laterality,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        dayLogs: row.dayLogs.map((dayLog) => ({
          id: dayLog.id,
          episodeId: dayLog.episodeId,
          date: dayLog.date,
          functionalImpact: dayLog.functionalImpact,
          feverC: dayLog.feverC,
          note: null,
          noteEncrypted: dayLog.noteEncrypted
            ? Buffer.from(dayLog.noteEncrypted).toString("base64")
            : null,
          tz: dayLog.tz,
          createdAt: dayLog.createdAt.toISOString(),
          updatedAt: dayLog.updatedAt.toISOString(),
          deletedAt: dayLog.deletedAt?.toISOString() ?? null,
          symptoms: dayLog.symptomLinks.map((link) => ({
            key: link.symptom.key,
            severity: link.severity,
            createdAt: link.createdAt.toISOString(),
          })),
        })),
      }))
    : episodeRows.map((row) => ({
        ...toIllnessEpisodeDTO(row),
        // The zone the day is anchored to travels with it, the rule the
        // measurements follow: without it a day logged abroad files under
        // another date once it is restored elsewhere.
        dayLogs: row.dayLogs.map((dayLog) => ({
          ...toIllnessDayLogDTO(dayLog),
          tz: dayLog.tz,
        })),
      }));

  return { illnessEpisodes };
}

// ── Restore ──────────────────────────────────────────────────────────────────

export async function clearIllness(ctx: RestoreContext): Promise<void> {
  const illnessEpisodes = await ctx.tx.illnessEpisode.deleteMany({
    where: { userId: ctx.ownerId },
  });
  ctx.cleared.illnessEpisodes = illnessEpisodes.count;
}

/** The episodes, then the parent links once every episode exists. */
async function restoreEpisodes(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload } = ctx;
  const episodeIds = ctx.links.episodeIds;
  for (const episode of payload.illnessEpisodes) {
    if (
      episode.parentConditionId &&
      !episodeIds.has(episode.parentConditionId)
    ) {
      throw new Error(`Unknown illness parent: ${episode.parentConditionId}`);
    }
    await tx.illnessEpisode.create({
      data: {
        id: episode.id,
        userId: ownerId,
        label: episode.label,
        type: episode.type as never,
        lifecycle: episode.lifecycle as never,
        onsetAt: new Date(episode.onsetAt),
        resolvedAt: episode.resolvedAt ? new Date(episode.resolvedAt) : null,
        parentConditionId: null,
        noteEncrypted:
          episode.noteEncrypted !== undefined
            ? episode.noteEncrypted === null
              ? null
              : decodeEncryptedBytes(episode.noteEncrypted)
            : episode.note == null
              ? null
              : encryptToBytes(episode.note),
        // The same two-armed read as the note: ciphertext verbatim from a
        // disaster-recovery file, plaintext re-encrypted from a portable one,
        // nothing from a file older than the field.
        bodySiteEncrypted:
          episode.bodySiteEncrypted !== undefined &&
          episode.bodySiteEncrypted !== null
            ? decodeEncryptedBytes(episode.bodySiteEncrypted)
            : episode.bodySite?.trim()
              ? encryptToBytes(episode.bodySite.trim())
              : null,
        laterality: episode.laterality ?? null,
        deletedAt: episode.deletedAt ? new Date(episode.deletedAt) : null,
        ...(episode.createdAt
          ? { createdAt: new Date(episode.createdAt) }
          : {}),
        ...(episode.updatedAt
          ? { updatedAt: new Date(episode.updatedAt) }
          : {}),
      },
    });
  }
  for (const episode of payload.illnessEpisodes) {
    if (episode.parentConditionId) {
      await tx.illnessEpisode.update({
        where: { id: episode.id, userId: ownerId },
        // The pointer is a second write to the row; the row's own last write
        // stays the one the file carries.
        data: {
          parentConditionId: episode.parentConditionId,
          ...(episode.updatedAt
            ? { updatedAt: new Date(episode.updatedAt) }
            : {}),
        },
      });
    }
  }
}

/**
 * The day logs with their symptom links.
 *
 * `IllnessSymptom` has no `userId` column at all — it is a purely seeded
 * catalogue, so a key that will not resolve here can ONLY be catalogue drift
 * and never a definition the file failed to carry. Which makes refusing the
 * file over it the least defensible of the three: the file was never able to
 * supply the missing row.
 */
async function restoreDayLogs(ctx: RestoreContext): Promise<void> {
  const { tx, ownerId, payload, skips } = ctx;
  const referencedSymptomKeys = payload.illnessEpisodes.flatMap((episode) =>
    episode.dayLogs.flatMap((dayLog) =>
      dayLog.symptoms.map((symptom) => symptom.key),
    ),
  );
  const symptomKeys = [...new Set(referencedSymptomKeys)];
  const symptomRows =
    symptomKeys.length === 0
      ? []
      : await tx.illnessSymptom.findMany({
          where: { key: { in: symptomKeys } },
          select: { id: true, key: true },
        });
  const symptomByKey = new Map(
    symptomRows.map((symptom) => [symptom.key, symptom.id]),
  );
  recordUnknownKeys(
    skips,
    "illnessSymptom",
    symptomKeys.filter((key) => !symptomByKey.has(key)),
    referencedSymptomKeys,
  );
  for (const episode of payload.illnessEpisodes) {
    for (const dayLog of episode.dayLogs) {
      const symptomLinks = dayLog.symptoms.flatMap((symptom) => {
        const symptomId = symptomByKey.get(symptom.key);
        return symptomId
          ? [
              {
                symptomId,
                severity: symptom.severity ?? null,
                ...(symptom.createdAt
                  ? { createdAt: new Date(symptom.createdAt) }
                  : {}),
              },
            ]
          : [];
      });
      await tx.illnessDayLog.create({
        data: {
          ...(dayLog.id ? { id: dayLog.id } : {}),
          userId: ownerId,
          episodeId: episode.id,
          date: dayLog.date,
          functionalImpact: dayLog.functionalImpact ?? null,
          feverC: dayLog.feverC ?? null,
          noteEncrypted:
            dayLog.noteEncrypted !== undefined
              ? dayLog.noteEncrypted === null
                ? null
                : decodeEncryptedBytes(dayLog.noteEncrypted)
              : dayLog.note == null
                ? null
                : encryptToBytes(dayLog.note),
          tz: dayLog.tz ?? null,
          deletedAt: dayLog.deletedAt ? new Date(dayLog.deletedAt) : null,
          ...(dayLog.createdAt
            ? { createdAt: new Date(dayLog.createdAt) }
            : {}),
          ...(dayLog.updatedAt
            ? { updatedAt: new Date(dayLog.updatedAt) }
            : {}),
          ...(symptomLinks.length > 0
            ? { symptomLinks: { create: symptomLinks } }
            : {}),
        },
      });
    }
  }
}

export async function restoreIllness(ctx: RestoreContext): Promise<void> {
  ctx.reportSection("illness");
  for (const episode of ctx.payload.illnessEpisodes) {
    ctx.links.episodeIds.add(episode.id);
  }
  await restoreEpisodes(ctx);
  await restoreDayLogs(ctx);
}
