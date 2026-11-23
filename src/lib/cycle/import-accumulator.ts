/**
 * Cycle-import accumulator — folds the reproductive HealthKit samples a
 * `export.xml` parse emits into one merged `CycleDayLog` per user-local day.
 *
 * The streaming importer (`import-apple-health-export.ts`) sees one
 * `<Record>` per HK sample. Several reproductive samples can share a day
 * (flow + cervical mucus + a symptom). The `CycleDayLog` is one canonical
 * row per `(user, date)`, so we merge same-day samples in memory and flush
 * one upsert per day at the end of the parse.
 *
 * Dedup / idempotency: each merged day writes with `source:APPLE_HEALTH` and
 * a synthetic per-day `externalId` (`hkcycle:<YYYY-MM-DD>`), so a re-import
 * upserts the same row on the `(userId, source, externalId)` NULL-distinct
 * key — first-write-wins at the day grain, last-writer-wins on the field
 * set (the day-log write helper's contract). This mirrors the cumulative
 * `stats:<HKType>:<day>` convention the measurement importer already uses.
 *
 * A contraceptive STATUS sample additionally nudges the `CycleProfile`
 * goal toward AVOID_PREGNANCY — but only when the goal is still on its
 * GENERAL_HEALTH default, so an explicit user choice is never clobbered.
 */
import { prisma } from "@/lib/db";
import { upsertCycleDayLog } from "@/lib/cycle/day-log-write";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { auditLog } from "@/lib/auth/audit";
import {
  HK_LACTATION,
  HK_PREGNANCY,
  mapHkCycleSample,
  isCycleHkIdentifier,
  type CycleDayLogFields,
} from "@/lib/cycle/healthkit-mapping";
import {
  decideImportedPregnancyState,
  type StatusSample,
} from "@/lib/cycle/pregnancy-import";
import {
  PREGNANCY_PROFILE_SELECT,
  pregnancyFieldsOf,
  pregnancyWriteData,
} from "@/lib/cycle/pregnancy-store";
import { userDayKey } from "@/lib/tz/format";
import type { CycleDayLogInput } from "@/lib/validations/cycle";
import type { ContraceptiveKind } from "@/generated/prisma/client";

/** Synthetic per-day externalId prefix for HealthKit-imported cycle rows. */
export const HK_CYCLE_DAY_EXTERNAL_PREFIX = "hkcycle:";

/** A zeroed cycle-import result — the no-cycle / aborted-flush fallback. */
export const EMPTY_CYCLE_IMPORT_STATS: CycleImportStats = {
  samplesConsumed: 0,
  samplesSkippedModuleDisabled: 0,
  daysUpserted: 0,
  daysInserted: 0,
  daysFailed: 0,
  firstFailureReason: null,
  goalNudged: false,
  pregnancyStateSet: null,
};

/** Per-day merge state held during the parse. */
interface DayBucket {
  fields: CycleDayLogFields;
  symptomKeys: Set<string>;
  /** A contraceptive method seen this day → triggers the profile nudge. */
  contraceptiveNudge: ContraceptiveKind | null;
}

/** Terminal stats the importer folds into its `ImportJobResult`. */
export interface CycleImportStats {
  /** Reproductive samples consumed into a day-bucket. */
  samplesConsumed: number;
  /**
   * Reproductive samples the export carried but the fold dropped because
   * cycle tracking is disabled for the account. Named so the "read 900k /
   * imported 880k" gap stops being unexplained.
   */
  samplesSkippedModuleDisabled: number;
  /** Day-logs upserted at flush. */
  daysUpserted: number;
  /** Day-logs that the write created (vs refreshed). */
  daysInserted: number;
  /**
   * Day-logs whose write FAILED at flush. The flush is fault-isolated per
   * day, so `daysUpserted` counts what actually landed rather than being
   * zeroed by one colliding day.
   */
  daysFailed: number;
  /** The first per-day failure's message, for the operator-facing line. */
  firstFailureReason: string | null;
  /** Whether a CycleProfile goal nudge fired. */
  goalNudged: boolean;
  /**
   * The state the pregnancy / lactation samples set on a profile
   * that held none (`pregnancy-import.ts`), or null.
   */
  pregnancyStateSet: "PREGNANT" | "POSTPARTUM" | null;
}

/**
 * In-memory fold of the reproductive HK samples for one user's import.
 * Construct once per parse; `consume()` per matching `<Record>`; `flush()`
 * once at the end.
 */
export class CycleImportAccumulator {
  private readonly byDay = new Map<string, DayBucket>();
  private readonly pregnancySamples: StatusSample[] = [];
  private readonly lactationSamples: StatusSample[] = [];
  private samplesConsumed = 0;
  private gated: boolean | null = null;

  constructor(
    private readonly userId: string,
    private readonly userTimezone: string,
  ) {}

  /** Does this importer own the inbound HK identifier? */
  static handles(hkIdentifier: string): boolean {
    return isCycleHkIdentifier(hkIdentifier);
  }

  /** Is this a pregnancy / lactation STATUS sample? */
  static handlesStatus(hkIdentifier: string): boolean {
    return hkIdentifier === HK_PREGNANCY || hkIdentifier === HK_LACTATION;
  }

  /** True once at least one reproductive sample was taken in. */
  hasSamples(): boolean {
    return (
      this.byDay.size > 0 ||
      this.pregnancySamples.length > 0 ||
      this.lactationSamples.length > 0
    );
  }

  /**
   * Hold one pregnancy or lactation status sample (user-local first
   * and last day, `end` null while open) for the decision at flush.
   */
  consumeStatus(hkIdentifier: string, start: string, end: string | null): void {
    const sample = { start, end };
    if (hkIdentifier === HK_PREGNANCY) this.pregnancySamples.push(sample);
    else if (hkIdentifier === HK_LACTATION) this.lactationSamples.push(sample);
    else return;
    this.samplesConsumed += 1;
  }

  /** Samples consumed so far — for the module-disabled skip accounting. */
  sampleCount(): number {
    return this.samplesConsumed;
  }

  /** Accumulated day-buckets — for the whole-flush-failed accounting. */
  dayCount(): number {
    return this.byDay.size;
  }

  /**
   * Fold one reproductive HK sample into its day-bucket. `dayKey` is the
   * already-resolved user-local `YYYY-MM-DD`. `rawValue` is the sample's
   * `value` attribute (symbolic name or integer string). `protectionUsed`
   * is the resolved SexualActivity protection metadata (or undefined).
   * Returns true when the sample was consumed (recognised + routed).
   */
  consume(
    hkIdentifier: string,
    dayKey: string,
    rawValue: string | undefined,
    protectionUsed?: boolean,
  ): boolean {
    const route = mapHkCycleSample(hkIdentifier, rawValue, protectionUsed);
    if (route.kind === "skip") return false;

    const bucket = this.bucketFor(dayKey);
    this.mergeFields(bucket, route.fields);

    if (route.kind === "day-log+profile" && route.profile.contraceptive) {
      bucket.contraceptiveNudge = route.profile.contraceptive;
    }

    this.samplesConsumed += 1;
    return true;
  }

  private bucketFor(dayKey: string): DayBucket {
    let bucket = this.byDay.get(dayKey);
    if (!bucket) {
      bucket = { fields: {}, symptomKeys: new Set(), contraceptiveNudge: null };
      this.byDay.set(dayKey, bucket);
    }
    return bucket;
  }

  /** Last-writer-wins merge of a sample's fields into the day-bucket. */
  private mergeFields(bucket: DayBucket, fields: CycleDayLogFields): void {
    if (fields.symptomKey) bucket.symptomKeys.add(fields.symptomKey);
    if (fields.flow !== undefined) bucket.fields.flow = fields.flow;
    if (fields.intermenstrualBleeding !== undefined) {
      bucket.fields.intermenstrualBleeding = fields.intermenstrualBleeding;
    }
    if (fields.ovulationTest !== undefined) {
      bucket.fields.ovulationTest = fields.ovulationTest;
    }
    if (fields.cervicalMucus !== undefined) {
      bucket.fields.cervicalMucus = fields.cervicalMucus;
    }
    if (fields.sexualActivity !== undefined) {
      bucket.fields.sexualActivity = fields.sexualActivity;
    }
    if (fields.protectedSex !== undefined) {
      bucket.fields.protectedSex = fields.protectedSex;
    }
    if (fields.pregnancyTest !== undefined) {
      bucket.fields.pregnancyTest = fields.pregnancyTest;
    }
    if (fields.progesteroneTest !== undefined) {
      bucket.fields.progesteroneTest = fields.progesteroneTest;
    }
    if (fields.contraceptive !== undefined) {
      bucket.fields.contraceptive = fields.contraceptive;
    }
  }

  /**
   * Resolve whether the cycle module is enabled for the user — the
   * fully-resolved two-layer gate (per-user toggle AND the operator
   * server-wide kill-switch). Cached for the parse lifetime. The importer
   * skips the whole cycle fold when this is false so a non-cycle account's
   * (or an operator-disabled instance's) Apple Health export never silently
   * provisions cycle rows.
   */
  async isEnabled(): Promise<boolean> {
    if (this.gated !== null) return this.gated;
    // v1.18.0 — the FULLY-resolved cycle module: the per-user toggle AND the
    // operator server-wide kill-switch. An operator-disabled instance never
    // accumulates / writes cycle rows from an import. No profile auto-create.
    this.gated = await isCycleAvailableForUser(this.userId);
    return this.gated;
  }

  /**
   * Upsert one merged `CycleDayLog` per accumulated day. No-op when nothing
   * was consumed. Returns the terminal stats for the importer result.
   */
  async flush(): Promise<CycleImportStats> {
    const stats: CycleImportStats = {
      samplesConsumed: this.samplesConsumed,
      samplesSkippedModuleDisabled: 0,
      daysUpserted: 0,
      daysInserted: 0,
      daysFailed: 0,
      firstFailureReason: null,
      goalNudged: false,
      pregnancyStateSet: await this.applyPregnancyStatus(),
    };
    if (this.byDay.size === 0) return stats;

    let contraceptiveNudge: ContraceptiveKind | null = null;

    // Hoist cycle attribution out of the per-day loop: load the user's
    // (non-deleted) cycle start dates once and resolve the owning span in
    // memory (latest start <= date) rather than a query per day.
    const cycleRows = await prisma.menstrualCycle.findMany({
      where: { userId: this.userId, deletedAt: null },
      orderBy: { startDate: "asc" },
      select: { id: true, startDate: true },
    });
    const owningCycleId = (date: string): string | null => {
      let id: string | null = null;
      for (const c of cycleRows) {
        if (c.startDate <= date) id = c.id;
        else break;
      }
      return id;
    };

    // Resolve the invariant encryption flag once for the whole flush, instead
    // of re-reading the profile per upserted day (QA M-3). Default ON if the
    // profile somehow vanished between the gate check and here.
    const encProfile = await prisma.cycleProfile.findUnique({
      where: { userId: this.userId },
      select: { sensitiveCategoryEncryption: true },
    });
    const encryptSensitive = encProfile?.sensitiveCategoryEncryption ?? true;

    for (const [dayKey, bucket] of this.byDay.entries()) {
      const symptoms =
        bucket.symptomKeys.size > 0
          ? Array.from(bucket.symptomKeys).map((key) => ({ key }))
          : undefined;

      const entry: CycleDayLogInput = {
        date: dayKey,
        ...bucket.fields,
        ...(symptoms ? { symptoms } : {}),
        source: "APPLE_HEALTH",
        externalId: `${HK_CYCLE_DAY_EXTERNAL_PREFIX}${dayKey}`,
        // The day-log write helper requires a `loggedAt`; anchor it to noon
        // of the day so it is stable across re-imports (the row's measured
        // moment is the day, not a wall-clock instant from the sample).
        loggedAt: `${dayKey}T12:00:00.000Z`,
      };

      const cycleId = owningCycleId(dayKey);
      // Fault-isolated per day: one colliding day must not zero the stats
      // for the days that DID land (the pre-fix shape reported
      // `samplesConsumed: 0` after partial writes — a false "nothing
      // happened" over rows already in the table).
      try {
        const result = await upsertCycleDayLog(
          this.userId,
          entry,
          this.userTimezone,
          cycleId,
          encryptSensitive,
        );
        stats.daysUpserted += 1;
        if (!result.existed) stats.daysInserted += 1;
      } catch (err: unknown) {
        stats.daysFailed += 1;
        stats.firstFailureReason ??=
          err instanceof Error ? err.message : String(err);
        continue;
      }

      // The most-recent contraceptive method across the import drives the
      // single goal nudge (applied once after the day loop).
      if (bucket.contraceptiveNudge) {
        contraceptiveNudge = bucket.contraceptiveNudge;
      }
    }

    // Goal nudge: an active contraceptive method moves a still-default
    // GENERAL_HEALTH profile to AVOID_PREGNANCY. NONE/UNSPECIFIED do not
    // assert avoidance intent, so they leave the goal untouched.
    if (
      contraceptiveNudge &&
      contraceptiveNudge !== "NONE" &&
      contraceptiveNudge !== "UNSPECIFIED"
    ) {
      const updated = await prisma.cycleProfile.updateMany({
        where: { userId: this.userId, goal: "GENERAL_HEALTH" },
        data: { goal: "AVOID_PREGNANCY" },
      });
      if (updated.count > 0) {
        stats.goalNudged = true;
        // A server-side mutation of an intent-revealing setting must not be
        // invisible — record it on the audit trail.
        await auditLog("cycle.profile.goal-nudged", {
          userId: this.userId,
          details: {
            from: "GENERAL_HEALTH",
            to: "AVOID_PREGNANCY",
            via: "apple-health-import",
          },
        });
      }
    }

    return stats;
  }

  /**
   * Set the pregnancy state from the status samples, on a profile that holds
   * none and whose owner never set or cleared one (`pregnancy-import.ts` has
   * the rules). A record with no cycle settings yet gets them. Audited, like the
   * goal nudge: a server-side change to an intent-revealing setting is never
   * invisible.
   */
  private async applyPregnancyStatus(): Promise<
    "PREGNANT" | "POSTPARTUM" | null
  > {
    if (this.pregnancySamples.length + this.lactationSamples.length === 0) {
      return null;
    }
    const today = userDayKey(new Date(), this.userTimezone);
    const decision = decideImportedPregnancyState(
      this.pregnancySamples,
      this.lactationSamples,
      today,
    );
    if (!decision) return null;
    const data = pregnancyWriteData({
      reproductiveState: decision.state,
      pregnancyStartDate:
        decision.state === "PREGNANT" ? decision.startDate : null,
      pregnancyDueDate: null,
      deliveryDate:
        decision.state === "POSTPARTUM" ? decision.deliveryDate : null,
      postpartumWeeks: null,
    });
    const profile = await prisma.cycleProfile.findUnique({
      where: { userId: this.userId },
      select: PREGNANCY_PROFILE_SELECT,
    });
    if (!profile) {
      // No cycle settings yet, so no choice of the owner's to respect.
      await prisma.cycleProfile.create({
        data: { userId: this.userId, ...data },
      });
    } else {
      // A state the owner holds, or ever set or cleared, is theirs: an
      // import never sets it behind them. Both live in the sealed state, so
      // a profile without one is the only one an import may write, and the
      // write claims exactly that.
      const opened = pregnancyFieldsOf(profile);
      if (opened.reproductiveState !== null || opened.ownerDecided) {
        return null;
      }
      const written = await prisma.cycleProfile.updateMany({
        where: {
          userId: this.userId,
          pregnancyEncrypted: profile.pregnancyEncrypted,
        },
        data: { pregnancyEncrypted: data.pregnancyEncrypted },
      });
      if (written.count === 0) return null;
    }
    await prisma.cyclePrediction.deleteMany({ where: { userId: this.userId } });
    await auditLog("cycle.profile.pregnancy-imported", {
      userId: this.userId,
      details: { to: decision.state, via: "apple-health-import" },
    });
    return decision.state;
  }
}
