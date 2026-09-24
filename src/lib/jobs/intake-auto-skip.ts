/**
 * v1.4.46 — hourly cron that gives a forgotten medication dose a terminal
 * state. Without it the dashboard "compliance" tile keeps counting a never-
 * acted dose as `pending` forever (the row's `takenAt` stays NULL), which
 * prevents the next day's intake from rendering cleanly in the "today"
 * window.
 *
 * v1.15.9 — the terminal state is now `auto_missed = true`, NOT
 * `skipped = true`. A forgotten dose is a real MISS — it must count against
 * adherence. The old behaviour flipped `skipped = true`, and because the
 * compliance engine EXCLUDES skipped doses from the denominator (a
 * deliberate user pause), a forgotten dose then vanished from the rate
 * entirely, silently inflating adherence. Setting `auto_missed` keeps the
 * never-acted dose distinct from a user-initiated skip: the engine pairs an
 * `auto_missed` slot to a `missed` status (counts against the rate) while a
 * `skipped` row stays excluded (a deliberate drug holiday).
 *
 * v1.15.20 — the cutoff is cadence-aware instead of a flat 24 h. The band
 * model gives a day-scale cadence (weekly / rolling injectables) an overdue
 * tail of `weeklyOnTimeDays + weeklyOverdueDays` (5 days by default — the
 * clinical 4-day rule plus the ±1-day on-time band), so stamping the miss
 * 24 h after the anchor contradicted the dose-history ledger, which still
 * showed the slot as takeable. The pass now derives ONE conservative
 * auto-miss delay per medication from its schedule family (no per-row band
 * mint): `cutoff = scheduledFor + on-time reach + overdue reach` of the
 * family, floored at the legacy 24 h grace. The same pass also restricts
 * the flip to live rows (`deletedAt: null` — a tombstoned row must never be
 * resurrected as a miss) and bumps `syncVersion` so sync clients see the
 * transition.
 *
 * Rule: set `auto_missed = true` for every live `MedicationIntakeEvent`
 * where:
 *   * `skipped = false` AND
 *   * `auto_missed = false` AND
 *   * `takenAt IS NULL` AND
 *   * `deletedAt IS NULL` AND
 *   * `scheduledFor < NOW() - <per-medication auto-miss delay>` AND
 *   * `scheduledFor >= medication.createdAt`
 *
 * The last clause (#1028): the today projector mints a pending placeholder
 * for every slot of the current day, so a medication added at 16:00 carries
 * placeholders for its 09:00 and 14:00 slots. Those slots were never
 * expected, and a placeholder on one records nothing. Stamping it a miss
 * put a forgotten dose into every reader that counts raw rows (the miss-free
 * streak, the Coach snapshot) for a day before the medication existed. It
 * stays pending instead: the dose history drops it, and a dose the person
 * does record for that slot still converges onto it.
 *
 * The 24 h floor is intentional: a slightly late mark (user took the
 * morning dose at noon when the schedule was 09:00) shouldn't be flipped
 * before the user has had a full day to record it.
 *
 * Idempotent by construction: the second pass within the same hour finds
 * zero candidate rows because the first pass already flipped them. Safe to
 * re-run on worker restart.
 *
 * Compliance coupling: the engine-backed compliance paths read `auto_missed`
 * directly. The helper deliberately does NOT touch any rollup — the next
 * read-path call recomputes from the live rows. It DOES (v1.16.1) drop the
 * affected users' server caches via `invalidateUserMedications`, because the
 * cached compliance / intake / summary payloads were built on the
 * pre-flip denominator and would otherwise serve it for up to their TTL.
 */
import type { PrismaClient } from "@/generated/prisma/client";

import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import { normaliseDoseWindows } from "@/lib/medications/scheduling/worker-helpers";

export const INTAKE_AUTO_SKIP_QUEUE = "intake-auto-skip";

/**
 * Cron schedule. Hourly at :05 so the tick doesn't collide with the
 * top-of-the-hour reminder-check (:00) or the rollup fold (:30)
 * cadences. Europe/Berlin matches the rest of the worker's schedules.
 */
export const INTAKE_AUTO_SKIP_CRON = "5 * * * *";

/**
 * Grace floor before auto-skip kicks in. 24 h matches the spec and
 * the user's real-world cadence (late entries up to a full day after
 * the schedule are still legitimate). Day-scale cadences extend past
 * this floor via the band-model reach (see `medicationAutoMissDelayMs`).
 */
export const INTAKE_AUTO_SKIP_GRACE_HOURS = 24;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Padding added on top of a derived day-scale reach so a DST transition
 * inside the multi-day tail (the band minter mints its bounds on calendar
 * days, which can shift an hour across a transition) can never flip a slot
 * that the ledger still shows as takeable.
 */
const DST_PAD_MS = HOUR_MS;

export interface IntakeAutoSkipPayload {
  triggeredAt: string;
}

export interface IntakeAutoSkipResult {
  /** Rows that flipped from pending to `auto_missed = true` on this pass. */
  skippedCount: number;
  /**
   * Base (24 h floor) cutoff the pass applied — useful for the audit trail.
   * Day-scale medications use an earlier per-medication cutoff derived from
   * their band reach.
   */
  cutoff: Date;
  /**
   * v1.16.1 — users whose server caches were invalidated because a flip
   * touched (or may have touched) one of their medications. Slight
   * over-approximation by design: a flip group invalidates every
   * candidate user of its medications, matching the documented
   * "redundant eviction is cheap, under-eviction surfaces stale data"
   * stance of `invalidate.ts`.
   */
  invalidatedUserIds: string[];
}

/**
 * The narrow schedule projection the delay derivation reads. Mirrors the
 * field-shape family signal the band minter falls back to when too few
 * slots exist to measure a realised gap — the cron must not mint bands per
 * row, so the conservative field-shape classification is the right tool.
 */
interface AutoMissScheduleRow {
  rrule: string | null;
  rollingIntervalDays: number | null;
  doseWindows: unknown;
}

/** True when the schedule's field shape describes a day-scale cadence. */
function isDayScaleSchedule(schedule: AutoMissScheduleRow): boolean {
  if (
    schedule.rollingIntervalDays !== null &&
    schedule.rollingIntervalDays >= 2
  ) {
    return true;
  }
  return /FREQ=(WEEKLY|MONTHLY|YEARLY)/i.test(schedule.rrule ?? "");
}

/**
 * Conservative auto-miss delay for one medication, derived ONCE per
 * medication (never per row): the maximum band reach across its schedules.
 *
 *   - day-scale (weekly / rolling): `weeklyOnTimeDays + weeklyOverdueDays`
 *     days past the anchor (5 days by default) + a DST pad;
 *   - minute-scale with configured `doseWindows`: the explicit window end
 *     can sit up to a local day past the slot anchor (e.g. an 00:00 anchor
 *     with a 23:59 window end), so the reach is a day + the overdue tail;
 *   - minute-scale default: the legacy 24 h grace already dominates the
 *     default ±1 h + 3 h tail.
 *
 * A mixed-cadence medication (daily oral + weekly injection on one row)
 * waits for the widest schedule — conservative by design: stamping a miss
 * late is recoverable noise, stamping it while the ledger still shows the
 * slot takeable is a contradiction.
 */
export function medicationAutoMissDelayMs(
  schedules: AutoMissScheduleRow[],
): number {
  const floorMs = INTAKE_AUTO_SKIP_GRACE_HOURS * HOUR_MS;
  let delayMs = floorMs;
  for (const schedule of schedules) {
    if (isDayScaleSchedule(schedule)) {
      const reachMs =
        (DOSE_WINDOW_DEFAULTS.weeklyOnTimeDays +
          DOSE_WINDOW_DEFAULTS.weeklyOverdueDays) *
          DAY_MS +
        DST_PAD_MS;
      delayMs = Math.max(delayMs, reachMs);
    } else if (normaliseDoseWindows(schedule.doseWindows) !== null) {
      const reachMs =
        DAY_MS +
        DOSE_WINDOW_DEFAULTS.dailyOverdueMinutes * MINUTE_MS +
        DST_PAD_MS;
      delayMs = Math.max(delayMs, reachMs);
    }
  }
  return delayMs;
}

/**
 * Run one auto-skip pass. Returns the flipped row count + the base cutoff
 * the pass used. Pure function over the injected Prisma client so
 * unit tests can drive it with an in-memory fake.
 *
 * Efficiency: one `groupBy` finds the medications that carry ANY candidate
 * row past the 24 h floor; one schedules read derives each medication's
 * delay; one `updateMany` per distinct delay (in practice ≤ 3 groups)
 * flips the rows. No per-row work.
 *
 * `nowMs` is injectable for the same testing reason — the production
 * caller passes `Date.now()`; tests pass a frozen instant so the
 * cutoff arithmetic is deterministic.
 */
export async function runIntakeAutoSkipPass(
  prisma: PrismaClient,
  options: { nowMs?: number } = {},
): Promise<IntakeAutoSkipResult> {
  const nowMs = options.nowMs ?? Date.now();
  const baseCutoff = new Date(nowMs - INTAKE_AUTO_SKIP_GRACE_HOURS * HOUR_MS);

  const pendingWhere = {
    skipped: false,
    autoMissed: false,
    takenAt: null,
    // A tombstoned row is gone for every read surface; flipping it would
    // leak a phantom miss back into the sync stream.
    deletedAt: null,
  } as const;

  // Medications carrying at least one candidate row past the 24 h floor.
  // Day-scale rows inside their band tail are filtered out per-medication
  // below; everything younger than the floor is never a candidate. The
  // owning `userId` rides along so a flip can invalidate the affected
  // users' server caches below.
  const candidates = await prisma.medicationIntakeEvent.groupBy({
    by: ["medicationId", "userId"],
    where: { ...pendingWhere, scheduledFor: { lt: baseCutoff } },
  });
  if (candidates.length === 0) {
    return { skippedCount: 0, cutoff: baseCutoff, invalidatedUserIds: [] };
  }

  const usersByMedication = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const users = usersByMedication.get(candidate.medicationId) ?? new Set();
    users.add(candidate.userId);
    usersByMedication.set(candidate.medicationId, users);
  }

  const medications = await prisma.medication.findMany({
    where: { id: { in: [...usersByMedication.keys()] } },
    select: {
      id: true,
      createdAt: true,
      schedules: {
        select: { rrule: true, rollingIntervalDays: true, doseWindows: true },
      },
    },
  });

  // Group medications by their derived delay so one `updateMany` covers
  // each distinct cutoff instead of one query per medication.
  const medsByDelay = new Map<number, Array<{ id: string; createdAt: Date }>>();
  for (const medication of medications) {
    const delayMs = medicationAutoMissDelayMs(medication.schedules);
    const group = medsByDelay.get(delayMs) ?? [];
    group.push({ id: medication.id, createdAt: medication.createdAt });
    medsByDelay.set(delayMs, group);
  }

  let skippedCount = 0;
  const invalidatedUserIds = new Set<string>();
  for (const [delayMs, group] of medsByDelay) {
    const medicationIds = group.map((m) => m.id);
    const { count } = await prisma.medicationIntakeEvent.updateMany({
      where: {
        ...pendingWhere,
        scheduledFor: { lt: new Date(nowMs - delayMs) },
        // Per medication, only slots from its creation on: a placeholder
        // for a slot before it was never an expected dose (see above).
        OR: group.map((m) => ({
          medicationId: m.id,
          scheduledFor: { gte: m.createdAt },
        })),
      },
      // `syncVersion` bumps so delta-sync clients pick up the terminal
      // state instead of holding a stale pending row forever.
      data: { autoMissed: true, syncVersion: { increment: 1 } },
    });
    skippedCount += count;
    if (count > 0) {
      for (const medicationId of medicationIds) {
        for (const userId of usersByMedication.get(medicationId) ?? []) {
          invalidatedUserIds.add(userId);
        }
      }
    }
  }

  // v1.16.1 — a flip changes the compliance denominator the cached
  // payloads (per-medication compliance, intake ledger, dashboard
  // summary, insight targets) were built on, so the affected users'
  // server caches must drop now rather than after the 15-min TTL.
  // The caches are process-local; in the default single-container
  // deploy the worker shares the web process, so this eviction reaches
  // the serving instance directly. In a split web/worker deployment the
  // web container's cache still ages out via its TTL — that bound is
  // the documented staleness ceiling there (same caveat as every other
  // process-local cache, see `server-cache.ts`).
  for (const userId of invalidatedUserIds) {
    invalidateUserMedications(userId);
  }

  return {
    skippedCount,
    cutoff: baseCutoff,
    invalidatedUserIds: [...invalidatedUserIds],
  };
}
