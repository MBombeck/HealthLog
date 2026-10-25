/**
 * v1.43 (#1217) — the reads behind an AI usage level.
 *
 * The vocabulary, the resolver and the estimate are pure and live in
 * `@/lib/ai/usage-level`; this file gathers their inputs:
 *
 *   - the operator's bounds and sync gap: the `AppSettings` singleton, one
 *     memoised read per request (read afresh inside a background run, so a
 *     changed ceiling reaches the next account of a nightly pass);
 *   - the record's stored choice: one point read of `users.ai_usage_level`;
 *   - the measured use: the record's `coach_usage` rows of the last seven
 *     full days in its own time zone.
 *
 * A level is resolved for the RECORD, like every AI capability: a background
 * job runs per record, and a delegate or guardian inside somebody else's
 * record sees that record's level. Only the account itself can change it
 * (`PUT /api/auth/me/ai-usage`); a managed profile has no choice of its own
 * and follows the instance default.
 */
import { readOperatorRow } from "@/lib/settings/operator-row";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  AI_USAGE_LEVEL_EFFECTS,
  AI_USAGE_MEASURE_DAYS,
  DEFAULT_AI_USAGE_DEFAULT_LEVEL,
  DEFAULT_AI_USAGE_MAX_LEVEL,
  DEFAULT_SYNC_REGEN_GAP_HOURS,
  buildAiUsageState,
  parseSyncRegenGapHours,
  resolveAiUsageLevel,
  usageLevelFromDb,
  type AiUsageLevel,
  type AiUsageResolution,
  type AiUsageState,
} from "@/lib/ai/usage-level";

/** The operator's side of the usage levels. */
export interface AiUsageSettings {
  maxLevel: AiUsageLevel;
  defaultLevel: AiUsageLevel;
  /** The stored sync gap (1..48), `null` when the operator set none. */
  storedSyncRegenGapHours: number | null;
  /** The sync gap in effect: the stored one, else the environment, else six. */
  syncRegenGapHours: number;
}

/** The environment's sync gap, else six. */
export function envSyncRegenGapHours(): number {
  return (
    parseSyncRegenGapHours(process.env.AI_SYNC_REGEN_GAP_HOURS) ??
    DEFAULT_SYNC_REGEN_GAP_HOURS
  );
}

/** Pure: the operator's settings from the raw row (or its absence). */
export function aiUsageSettingsFromRow(
  row: {
    aiUsageMaxLevel?: string | null;
    aiUsageDefaultLevel?: string | null;
    aiSyncRegenGapHours?: number | null;
  } | null,
): AiUsageSettings {
  const stored = parseSyncRegenGapHours(row?.aiSyncRegenGapHours);
  return {
    maxLevel:
      usageLevelFromDb(row?.aiUsageMaxLevel) ?? DEFAULT_AI_USAGE_MAX_LEVEL,
    defaultLevel:
      usageLevelFromDb(row?.aiUsageDefaultLevel) ??
      DEFAULT_AI_USAGE_DEFAULT_LEVEL,
    storedSyncRegenGapHours: stored,
    syncRegenGapHours: stored ?? envSyncRegenGapHours(),
  };
}

/**
 * The operator's bounds and sync gap. An unreadable row reads as the
 * instance defaults (`standard` / `standard`, the environment's gap): the
 * levels bound spend, and the default is what an untouched instance runs at.
 */
export function loadAiUsageSettings(): Promise<AiUsageSettings> {
  const read = async (): Promise<AiUsageSettings> => {
    try {
      const row = await readOperatorRow();
      return aiUsageSettingsFromRow(row);
    } catch {
      getEvent()?.addWarning(
        "Failed to load the AI usage settings; the instance defaults apply",
      );
      return aiUsageSettingsFromRow(null);
    }
  };
  try {
    return memoizePerRequest("ai-usage-settings", read, {
      freshInBackground: true,
    });
  } catch {
    return read();
  }
}

/** One record's level: its stored choice against the operator's bounds. */
export interface RecordAiUsage extends AiUsageResolution {
  preference: AiUsageLevel | null;
  settings: AiUsageSettings;
  /**
   * The record is pending deletion. Read in the same point read as the level,
   * so the capability gate's deletion check costs no statement of its own.
   */
  deletionPending: boolean;
}

/**
 * The level in effect for one record. A missing row (an account deleted
 * under a running job) reads as no choice, so the default applies.
 */
export function loadRecordAiUsage(recordId: string): Promise<RecordAiUsage> {
  const read = async (): Promise<RecordAiUsage> => {
    const [settings, row] = await Promise.all([
      loadAiUsageSettings(),
      prisma.user.findUnique({
        where: { id: recordId },
        select: { aiUsageLevel: true, deletionRequestedAt: true },
      }),
    ]);
    const preference = usageLevelFromDb(row?.aiUsageLevel);
    return {
      deletionPending: row?.deletionRequestedAt != null,
      ...resolveAiUsageLevel({
        preference,
        defaultLevel: settings.defaultLevel,
        maxLevel: settings.maxLevel,
      }),
      preference,
      settings,
    };
  };
  try {
    return memoizePerRequest(`ai-usage:${recordId}`, read, {
      freshInBackground: true,
    });
  } catch {
    return read();
  }
}

/** Just the effective level, for a job or a gate. */
export async function loadRecordUsageLevel(
  recordId: string,
): Promise<AiUsageLevel> {
  return (await loadRecordAiUsage(recordId)).level;
}

/**
 * The status snapshot's char cap for this record's level. An unreadable level
 * reads as the instance default's cap, never as an uncapped snapshot.
 */
export async function statusSnapshotCharsForRecord(
  recordId: string,
): Promise<number> {
  try {
    const level = await loadRecordUsageLevel(recordId);
    return AI_USAGE_LEVEL_EFFECTS[level].statusSnapshotChars;
  } catch {
    return AI_USAGE_LEVEL_EFFECTS[DEFAULT_AI_USAGE_DEFAULT_LEVEL]
      .statusSnapshotChars;
  }
}

/**
 * The record's measured AI use: the mean of its `coach_usage` totals over the
 * last seven full days in its own time zone (today is still running and does
 * not count). `coach_usage` counts the Coach and the background work
 * together. A day without a row had no AI use recorded and is not counted, so
 * `days` says how many days stand behind the mean.
 */
export async function loadMeasuredAiUsage(
  recordId: string,
  now: Date = new Date(),
): Promise<{ tokensPerDay: number | null; days: number }> {
  const today = userDayKey(now, await resolveUserTimezone(recordId));
  const keys = Array.from({ length: AI_USAGE_MEASURE_DAYS }, (_, i) =>
    shiftDateKey(today, -(i + 1)),
  );
  const rows = await prisma.coachUsage.findMany({
    where: { userId: recordId, dateKey: { in: keys } },
    select: { totalTokens: true },
  });
  if (rows.length === 0) return { tokensPerDay: null, days: 0 };
  const total = rows.reduce((sum, row) => sum + row.totalTokens, 0);
  return { tokensPerDay: Math.round(total / rows.length), days: rows.length };
}

/**
 * `ai.usage` for one record. `withMeasurement: false` publishes the levels
 * without the measured use or the estimates: a delegate sees which level the
 * record runs at, never how much the owner spends.
 */
export async function loadAiUsageState(
  recordId: string,
  options: { withMeasurement: boolean },
): Promise<AiUsageState> {
  const [usage, measured] = await Promise.all([
    loadRecordAiUsage(recordId),
    options.withMeasurement
      ? loadMeasuredAiUsage(recordId).catch(() => ({
          tokensPerDay: null,
          days: 0,
        }))
      : Promise.resolve({ tokensPerDay: null, days: 0 }),
  ]);
  return buildAiUsageState({
    preference: usage.preference,
    defaultLevel: usage.settings.defaultLevel,
    maxLevel: usage.settings.maxLevel,
    measuredTokensPerDay: measured.tokensPerDay,
    measuredDays: measured.days,
  });
}
