/**
 * Apple Health symptom samples into symptom occurrences
 * (`POST /api/symptoms/events/batch`).
 *
 * Each entry is one HealthKit symptom sample the app mapped to a built-in
 * code and an intensity on the diary's 0-10 scale. It lands on the account's
 * built-in definition for that code, created here on first use, labelled in
 * the person's language (`symptoms.builtin.<CODE>`). Built-in definitions
 * hold no slot of the eight-definition cap, so a sample is never refused for
 * it.
 *
 * Per entry, in this order:
 *   - `skipped`: `unsupported_source` (anything but `APPLE_HEALTH`),
 *     `unstable_external_id`, `unknown_code`, `value_out_of_range` (intensity
 *     not an integer 0-10), `implausible_timestamp` (in the future beyond the
 *     shared five-minute skew, before 1900, or ending before it started). All
 *     permanent for the entry as sent.
 *   - `duplicate`: the `(userId, APPLE_HEALTH, externalId)` row exists,
 *     deleted ones included, so a late re-post of a sample the app reported
 *     gone (or the person deleted) never brings it back. A second entry with
 *     an externalId already in the same batch is a duplicate too.
 *   - `inserted`, or `failed` when the write itself failed (transient: the
 *     app keeps the row and resends it).
 *
 * The answer has the shape `POST /api/measurements/batch` answers with.
 */
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { coerceLocale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { annotate } from "@/lib/logging/context";
import type { EntryResult } from "@/lib/measurements/batch-ingest/entries";
import type { BatchIngestResult } from "@/lib/measurements/batch-ingest/ingest";
import { summariseSkips } from "@/lib/measurements/batch-ingest/report";
import { isP2002 } from "@/lib/prisma-errors";
import { APP_MINTED_SOURCE } from "@/lib/sync/external-id-delete";
import {
  classifyExternalId,
  unstableExternalIdMeta,
  UNSTABLE_EXTERNAL_ID_REASON,
  type UnstableExternalIdShape,
} from "@/lib/validations/external-id";
import { isPlausibleEntryInstant } from "@/lib/validations/entry-instant";

import {
  isSymptomBuiltinCode,
  SYMPTOM_BUILTINS,
  symptomBuiltinLabelKey,
  type SymptomBuiltinCode,
} from "./builtin";
import { encryptSymptomText } from "./server";
import { SYMPTOM_INTENSITY_MAX, SYMPTOM_INTENSITY_MIN } from "./shared";

/** One entry as the route's schema hands it over (types checked, not values). */
export interface SymptomBatchEntry {
  code: string;
  occurredAt: Date;
  endAt?: Date;
  intensity: number;
  externalId: string;
  source: string;
}

/** A batch answer: the measurement batch's shape exactly. */
export type SymptomBatchResult = BatchIngestResult;

export const SYMPTOM_BATCH_SKIP_REASONS = [
  "unsupported_source",
  UNSTABLE_EXTERNAL_ID_REASON,
  "unknown_code",
  "value_out_of_range",
  "implausible_timestamp",
] as const;

/** What an accepted entry becomes. */
interface PreparedSymptom {
  index: number;
  code: SymptomBuiltinCode;
  externalId: string;
  occurredAt: Date;
  endAt: Date | null;
  intensity: number;
}

/**
 * The first pass: the per-entry checks that need no database. Returns the
 * skip reason, or the row the entry becomes.
 */
export function classifySymptomEntry(
  entry: SymptomBatchEntry,
  index: number,
  now: number = Date.now(),
): { skip: string; shape?: UnstableExternalIdShape } | PreparedSymptom {
  if (entry.source !== APP_MINTED_SOURCE) return { skip: "unsupported_source" };
  const shape = classifyExternalId(entry.externalId);
  if (shape) return { skip: UNSTABLE_EXTERNAL_ID_REASON, shape };
  if (!isSymptomBuiltinCode(entry.code)) return { skip: "unknown_code" };
  if (
    !Number.isInteger(entry.intensity) ||
    entry.intensity < SYMPTOM_INTENSITY_MIN ||
    entry.intensity > SYMPTOM_INTENSITY_MAX
  ) {
    return { skip: "value_out_of_range" };
  }
  if (!isPlausibleEntryInstant(entry.occurredAt, { now })) {
    return { skip: "implausible_timestamp" };
  }
  let endAt: Date | null = null;
  if (entry.endAt !== undefined) {
    if (
      !isPlausibleEntryInstant(entry.endAt, { now }) ||
      entry.endAt.getTime() < entry.occurredAt.getTime()
    ) {
      return { skip: "implausible_timestamp" };
    }
    // Equal to the start is a moment, stored as one.
    if (entry.endAt.getTime() > entry.occurredAt.getTime()) endAt = entry.endAt;
  }
  return {
    index,
    code: entry.code,
    externalId: entry.externalId,
    occurredAt: entry.occurredAt,
    endAt,
    intensity: entry.intensity,
  };
}

/**
 * The account's built-in definition id for each code, creating the missing
 * ones. A code whose definition could not be created is left out, so its
 * entries answer `failed` and are sent again.
 */
async function resolveBuiltinDefinitions(
  userId: string,
  locale: string | null,
  codes: SymptomBuiltinCode[],
): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();
  if (codes.length === 0) return byCode;
  const existing = await prisma.symptomDefinition.findMany({
    where: { userId, code: { in: codes } },
    select: { id: true, code: true },
  });
  for (const row of existing) if (row.code) byCode.set(row.code, row.id);
  const missing = codes.filter((code) => !byCode.has(code));
  if (missing.length === 0) return byCode;

  const translator = getServerTranslator(coerceLocale(locale));
  const last = await prisma.symptomDefinition.aggregate({
    where: { userId },
    _max: { sortOrder: true },
  });
  let sortOrder = (last._max.sortOrder ?? -1) + 1;
  for (const code of missing) {
    try {
      const created = await prisma.symptomDefinition.create({
        data: {
          userId,
          code,
          labelEncrypted: encryptSymptomText(
            translator.t(symptomBuiltinLabelKey(code)),
          ),
          icon: SYMPTOM_BUILTINS[code].icon,
          sortOrder: Math.min(sortOrder, 1000),
        },
        select: { id: true },
      });
      byCode.set(code, created.id);
      sortOrder += 1;
    } catch (err) {
      if (!isP2002(err)) {
        annotate({ meta: { symptom_builtin_create_failed: true } });
        continue;
      }
      // A concurrent batch created it first; use that one.
      const row = await prisma.symptomDefinition.findUnique({
        where: { userId_code: { userId, code } },
        select: { id: true },
      });
      if (row) byCode.set(code, row.id);
    }
  }
  return byCode;
}

export async function ingestSymptomBatch(args: {
  userId: string;
  locale: string | null;
  entries: SymptomBatchEntry[];
  ipAddress: string | null;
}): Promise<SymptomBatchResult> {
  const { userId, entries } = args;
  const now = Date.now();
  const results: EntryResult[] = [];
  const unstableShapes: UnstableExternalIdShape[] = [];
  const accepted: PreparedSymptom[] = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const verdict = classifySymptomEntry(entry, index, now);
    if ("skip" in verdict) {
      if (verdict.shape) unstableShapes.push(verdict.shape);
      results[index] = { index, status: "skipped", reason: verdict.skip };
      return;
    }
    if (seen.has(verdict.externalId)) {
      results[index] = { index, status: "duplicate" };
      return;
    }
    seen.add(verdict.externalId);
    accepted.push(verdict);
  });

  // Deleted rows included: the tombstone is what keeps a replay out.
  const stored =
    accepted.length === 0
      ? []
      : await prisma.symptomEvent.findMany({
          where: {
            userId,
            source: APP_MINTED_SOURCE,
            externalId: { in: accepted.map((p) => p.externalId) },
          },
          select: { externalId: true },
        });
  const storedIds = new Set(stored.map((r) => r.externalId));
  const fresh: PreparedSymptom[] = [];
  for (const p of accepted) {
    if (storedIds.has(p.externalId)) {
      results[p.index] = { index: p.index, status: "duplicate" };
    } else {
      fresh.push(p);
    }
  }

  const definitions = await resolveBuiltinDefinitions(userId, args.locale, [
    ...new Set(fresh.map((p) => p.code)),
  ]);
  const writable: Array<PreparedSymptom & { definitionId: string }> = [];
  for (const p of fresh) {
    const definitionId = definitions.get(p.code);
    if (definitionId) writable.push({ ...p, definitionId });
    else results[p.index] = { index: p.index, status: "failed" };
  }

  if (writable.length > 0) {
    try {
      const created = await prisma.symptomEvent.createManyAndReturn({
        data: writable.map((p) => ({
          userId,
          definitionId: p.definitionId,
          occurredAt: p.occurredAt,
          endAt: p.endAt,
          intensity: p.intensity,
          source: APP_MINTED_SOURCE,
          externalId: p.externalId,
        })),
        // A concurrent batch carrying the same sample wins the race; this
        // one reports it as the duplicate it is.
        skipDuplicates: true,
        select: { externalId: true },
      });
      const createdIds = new Set(created.map((r) => r.externalId));
      for (const p of writable) {
        results[p.index] = {
          index: p.index,
          status: createdIds.has(p.externalId) ? "inserted" : "duplicate",
        };
      }
    } catch (err) {
      annotate({
        meta: {
          symptom_batch_write_failed: true,
          symptom_batch_write_error:
            err instanceof Error ? err.name : "unknown",
        },
      });
      for (const p of writable) {
        results[p.index] = { index: p.index, status: "failed" };
      }
    }
  }

  const count = (status: EntryResult["status"]) =>
    results.filter((r) => r.status === status).length;
  const { skipped, skippedByReason } = summariseSkips(results);
  const result: SymptomBatchResult = {
    processed: entries.length,
    inserted: count("inserted"),
    updated: 0,
    duplicates: count("duplicate"),
    failed: count("failed"),
    skipped,
    entries: results,
  };

  if (result.inserted > 0) invalidateUserHealthContext(userId);

  await auditLog("symptoms.batch.ingest", {
    userId,
    ipAddress: args.ipAddress,
    details: {
      processed: result.processed,
      inserted: result.inserted,
      duplicates: result.duplicates,
      skipped: skipped.length,
      failed: result.failed,
    },
  });
  annotate({
    action: { name: "symptoms.batch.ingest" },
    meta: {
      processed: result.processed,
      inserted: result.inserted,
      duplicates: result.duplicates,
      skipped: skipped.length,
      failed: result.failed,
      skipped_by_reason: skippedByReason,
      ...(unstableShapes.length > 0
        ? unstableExternalIdMeta("symptoms.batch", unstableShapes)
        : {}),
    },
  });

  return result;
}
