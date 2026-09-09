/**
 * Repair for walking distances the `export.zip` import stored 1000x too
 * small (issue #944).
 *
 * THE DEFECT (fixed in code from this release): `mapAppleHealthEntry()`
 * accepted the `<Record unit="…">` attribute and never read it, so a
 * `HKQuantityTypeIdentifierDistanceWalkingRunning` record — which Apple
 * writes in the account's own display unit, `km` on a metric archive —
 * was folded into the day's total as if the number were already metres.
 * Every day of an imported history reads as a couple of metres walked.
 *
 * THE CODE FIX converts the record's own unit into the table's `hkUnit`
 * before storage, so every FUTURE import is right. This module heals what
 * is already in the database.
 *
 * ── The criterion ──────────────────────────────────────────────────
 *
 * A row is a candidate only when it carries the stamp the export importer
 * itself writes, never because its value "looks small":
 *
 *   type                  = WALKING_RUNNING_DISTANCE
 *   source                = APPLE_HEALTH
 *   aggregationProvenance = EXPORT_XML_SOURCE_MAX
 *   externalId LIKE         stats:HKQuantityTypeIdentifierDistanceWalkingRunning:%
 *   deletedAt             IS NULL
 *
 * `EXPORT_XML_SOURCE_MAX` is written in exactly one place — the archive
 * fold in `import-apple-health-export.ts` — and the `stats:<HK>:<day>`
 * externalId is minted by `dailyStatsExternalId()` for that same fold. A
 * row a native iOS sync has since overwritten carries
 * `HEALTHKIT_STATISTICS` and its value came from HealthKit's own
 * statistics query, so it is correct and out of scope. A row whose
 * provenance is `LEGACY_UNKNOWN` or NULL cannot be PROVEN to have come
 * from the archive path and is therefore left alone: re-importing the
 * archive on the fixed build repairs those, and is the authoritative
 * repair for any account that still has its `export.zip`.
 *
 * ── The refusal ────────────────────────────────────────────────────
 *
 * The criterion proves an archive ORIGIN. It cannot prove the archive was
 * imported on the broken build — an account re-imported since carries the
 * same stamp with the right numbers, and its rest days still pass the
 * plausibility check after another x1000. So any candidate whose repaired
 * value would leave the range refuses the whole account: nothing is
 * written, the rows are reported, and the operator decides. Re-importing
 * the archive is the authoritative repair and needs no script.
 *
 * ── Idempotency ────────────────────────────────────────────────────
 *
 * Applying the repair writes one `AuditLog` row per account inside the
 * same transaction as the update. An account that already carries that
 * row is skipped, so a second run finds nothing to do — the multiplier
 * can never be applied twice.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { auditLog } from "@/lib/auth/audit";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { validateMeasurementRange } from "@/lib/validations/measurement";

import { dailyStatsExternalId } from "./apple-health-mapping";
import { convertHkValue } from "./hk-units";

/** The audit action that marks an account's distances as repaired. */
export const APPLE_HEALTH_DISTANCE_REPAIR_ACTION =
  "measurement.apple_health_distance.repaired";

/** Minted by the same helper the export fold uses, so the two cannot drift. */
export const EXPORT_DISTANCE_EXTERNAL_ID_PREFIX = dailyStatsExternalId(
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "",
);

/**
 * The unit the affected archive was written in. Apple writes `km` on a
 * metric account and `mi` on an imperial one, and the stored row keeps no
 * record of which — the importer discarded the attribute, which is the
 * defect. The operator names it; `km` is the default because it is what
 * the Health app writes for every metric locale.
 */
export type ArchiveDistanceUnit = "km" | "mi";

export interface RepairCandidateRow {
  id: string;
  measuredAt: Date;
  value: number;
}

export interface AccountRepairPlan {
  userId: string;
  /** Candidate rows that would be multiplied. */
  repairable: RepairCandidateRow[];
  /**
   * Candidates whose repaired value would leave the plausibility range
   * (`validateMeasurementRange`). One row here refuses the whole account:
   * it is evidence the rows are NOT the 1000x class.
   */
  outOfRange: RepairCandidateRow[];
  /** Non-null when this account already carries the repair's audit row. */
  alreadyRepairedAt: Date | null;
  /** Candidate rows found, whatever the disposition above. */
  candidateCount: number;
}

/** The DB surface this module needs — the script hands it the real client. */
export type RepairClient = Pick<
  PrismaClient,
  "measurement" | "auditLog" | "$transaction"
>;

const REPAIRED_TYPE = "WALKING_RUNNING_DISTANCE" as const;

/** metres per unit of the archive's own length unit. */
export function repairFactorFor(unit: ArchiveDistanceUnit): number {
  const factor = convertHkValue(1, unit, "m");
  // The two archive units are length units by construction; the shared
  // table is the single source of the factor either way.
  if (factor === null) throw new Error(`no metre factor for unit "${unit}"`);
  return factor;
}

/**
 * List the repair candidates per account. Read-only — this is what the
 * script's dry run prints.
 */
export async function planAppleHealthDistanceRepair(
  client: RepairClient,
  options: { archiveUnit: ArchiveDistanceUnit },
): Promise<AccountRepairPlan[]> {
  const factor = repairFactorFor(options.archiveUnit);

  const rows = await client.measurement.findMany({
    where: {
      type: REPAIRED_TYPE,
      source: "APPLE_HEALTH",
      aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
      externalId: { startsWith: EXPORT_DISTANCE_EXTERNAL_ID_PREFIX },
      deletedAt: null,
    },
    select: { id: true, userId: true, value: true, measuredAt: true },
    orderBy: [{ userId: "asc" }, { measuredAt: "asc" }],
  });
  if (rows.length === 0) return [];

  const userIds = Array.from(new Set(rows.map((row) => row.userId)));
  const repaired = await client.auditLog.findMany({
    where: {
      action: APPLE_HEALTH_DISTANCE_REPAIR_ACTION,
      userId: { in: userIds },
    },
    select: { userId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const repairedAt = new Map<string, Date>();
  for (const entry of repaired) {
    if (entry.userId) repairedAt.set(entry.userId, entry.createdAt);
  }

  const plans = new Map<string, AccountRepairPlan>();
  for (const row of rows) {
    let plan = plans.get(row.userId);
    if (!plan) {
      plan = {
        userId: row.userId,
        repairable: [],
        outOfRange: [],
        alreadyRepairedAt: repairedAt.get(row.userId) ?? null,
        candidateCount: 0,
      };
      plans.set(row.userId, plan);
    }
    plan.candidateCount += 1;
    if (plan.alreadyRepairedAt) continue;
    const candidate: RepairCandidateRow = {
      id: row.id,
      measuredAt: row.measuredAt,
      value: row.value,
    };
    if (validateMeasurementRange(REPAIRED_TYPE, row.value * factor) !== null) {
      plan.outOfRange.push(candidate);
    } else {
      plan.repairable.push(candidate);
    }
  }
  return Array.from(plans.values());
}

export interface RepairOutcome {
  userId: string;
  updated: number;
  skipped: number;
  /**
   * Why the account was left alone, when it was. Null on a run that wrote.
   * The script prints it verbatim.
   */
  refusedReason: string | null;
  /** The out-of-range candidates — what a refusal was decided on. */
  skippedRows: RepairCandidateRow[];
}

/**
 * The refusal an out-of-range candidate earns.
 *
 * The provenance criterion proves an archive origin; it cannot prove the
 * archive was imported on the BROKEN build. An account that has since been
 * re-imported on the fixed build carries the same stamp with the right
 * numbers, and its rest days — under 200 m, phone left at home — pass the
 * plausibility check after another x1000 and would be written. So a single
 * row that would leave the range is treated as what it is: evidence the
 * account is not the 1000x class. The whole account stops.
 */
function outOfRangeRefusal(plan: AccountRepairPlan, factor: number): string {
  return (
    `${plan.outOfRange.length} of ${plan.candidateCount} candidate row(s) ` +
    `leave the plausible range after x${factor}, so these rows are not the ` +
    "1000x class — the account was most likely re-imported on the fixed " +
    "build, or its archive was never in the affected unit. Nothing written. " +
    "Check the dry run's worked examples against the account's Health app " +
    "before forcing anything."
  );
}

/**
 * Apply one account's plan: every repairable row multiplied by the
 * archive unit's metre factor in ONE transaction, together with the audit
 * row that makes a second run a no-op. Returns what it did.
 */
export async function applyAppleHealthDistanceRepair(
  client: RepairClient,
  plan: AccountRepairPlan,
  options: { archiveUnit: ArchiveDistanceUnit },
): Promise<RepairOutcome> {
  const factor = repairFactorFor(options.archiveUnit);
  const skipped = plan.outOfRange.length;
  const base = {
    userId: plan.userId,
    updated: 0,
    skipped,
    skippedRows: plan.outOfRange,
  };
  if (plan.alreadyRepairedAt) {
    return {
      ...base,
      refusedReason: `already repaired on ${plan.alreadyRepairedAt.toISOString()}`,
    };
  }
  // Refuse the ACCOUNT, not just the row: see `outOfRangeRefusal`.
  if (plan.outOfRange.length > 0) {
    return { ...base, refusedReason: outOfRangeRefusal(plan, factor) };
  }
  if (plan.repairable.length === 0) {
    return { ...base, refusedReason: "no repairable rows" };
  }

  const ids = plan.repairable.map((row) => row.id);
  await client.$transaction(async (tx) => {
    // One statement per chunk rather than one per row: an account with a
    // decade of history carries thousands of rows and an interactive
    // transaction has a clock on it. `sync_version` + `updated_at` are
    // bumped by hand because raw SQL bypasses Prisma's `@updatedAt`, and
    // the iOS delta feed pages on exactly those two columns.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await tx.$executeRaw`
        UPDATE measurements
           SET value = value * ${factor},
               unit = 'm',
               sync_version = sync_version + 1,
               updated_at = NOW()
         WHERE id = ANY(${chunk})`;
    }
    await auditLog(APPLE_HEALTH_DISTANCE_REPAIR_ACTION, {
      client: tx,
      userId: plan.userId,
      actorUserId: null,
      details: {
        type: REPAIRED_TYPE,
        archiveUnit: options.archiveUnit,
        factor,
        rows: ids.length,
        skippedOutOfRange: skipped,
        issue: 944,
      },
    });
  });

  // Best-effort tail: the DAY/WEEK/MONTH/YEAR rollups and the cached
  // status insights hold the pre-repair numbers until they are recomputed.
  await afterMeasurementMutation(
    plan.userId,
    plan.repairable.map((row) => ({
      type: REPAIRED_TYPE,
      measuredAt: row.measuredAt,
    })),
    "repair-apple-health-distance",
  );

  return {
    userId: plan.userId,
    updated: ids.length,
    skipped,
    refusedReason: null,
    skippedRows: plan.outOfRange,
  };
}

/** Narrowing helper for the script's `--unit` flag. */
export function parseArchiveUnit(raw: string): ArchiveDistanceUnit | null {
  return raw === "km" || raw === "mi" ? raw : null;
}
