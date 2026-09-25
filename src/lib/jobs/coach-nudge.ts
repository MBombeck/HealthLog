/**
 * v1.15.20 — proactive Coach nudge (MVP).
 *
 * One daily cron tick (05:15 Europe/Berlin, after the nightly score
 * passes have settled) evaluates a small set of DETERMINISTIC triggers
 * per user and — when one fires — dispatches a single `COACH_NUDGE`
 * notification deep-linking to `/coach`. No AI call happens
 * here: the triggers are plain arithmetic over already-persisted rows;
 * the Coach conversation the nudge invites the user into is where the
 * model gets involved.
 *
 * Gates, in order (the `status-cron-candidates` pattern):
 *   1. Operator kill-switch via `getAssistantFlags().coach` — the
 *      master assistant switch forces this off too.
 *   2. Per-user `disableCoach: false` — no Coach surface, no nudge.
 *   3. The `coach` capability for the user (`aiCapabilityForJob`): the
 *      operator's switches, the person's Coach switch, provider-work
 *      authority and one provider-presence definition (the operator's
 *      shared key and the central Codex included). A nudge into a Coach
 *      that cannot answer is worse than silence. The one reason that does
 *      not stop the nudge is a missing consent receipt: the deterministic
 *      template needs no model, and the Coach it invites the user into asks
 *      for consent itself.
 *   4. Per-user opt-out: `notificationPrefs.coach.nudgesEnabled`
 *      (default ON; Settings → Notifications). v1.16.5 adds per-group
 *      toggles underneath (medication / vitals / routine) — a disabled
 *      group's triggers are never evaluated for that user.
 *   5. Frequency cap: at most one nudge per rolling window — 7 days by
 *      default, 14 when the user picked "biweekly" — anchored on the
 *      `push_attempts` ledger (`eventType = COACH_NUDGE`,
 *      `result = "ok"`) — no new table, 90-day retention dwarfs the
 *      14-day lookback, and a failed dispatch leaves the slot free.
 *
 * Triggers (first hit wins, evaluated cheapest-first):
 *   - `compliance`: 7-day medication adherence < 60 % with at least
 *     5 due doses (deliberate skips excluded — a planned break is not
 *     a compliance problem).
 *   - `bp`: 7-day systolic mean above the user's effective target
 *     (override-aware via `getEffectiveRange`) with ≥ 3 readings.
 *   - `score`: recovery score falling sharply — the last 7-day mean
 *     sits ≥ 15 points under the previous 7-day mean (≥ 3 samples in
 *     each window).
 *   - `selfContext` (v1.16.0): the self-context questionnaire is
 *     incomplete or 60+ days stale AND the user actively talks to the
 *     Coach (a CoachUsage row in the last 14 days) — a gentle check-up
 *     nudge to refresh the personal context the Coach reads. Presence
 *     is checked only on encrypted columns the user included for AI;
 *     nothing is decrypted during trigger evaluation.
 *   - `weight` (v1.16.5): the weekly weight mean sits outside the
 *     user's effective green range AND has drifted further away from
 *     it than the previous week's mean (≥ 0.5 kg) — trend drift, not a
 *     single outlier reading.
 *   - `sleepDebt` (v1.16.5): at least 4 of the last 7 nights fall
 *     clearly (0.5 h margin) under the user's effective sleep floor,
 *     with at least 5 recorded nights so a sparse week stays silent.
 *   - `measurementGap` (v1.16.5): a previously active account
 *     (measurements on ≥ 10 distinct days in the preceding 3 weeks)
 *     records NOTHING for 7 straight days — an abrupt stop, whether
 *     disengagement or a silently broken sync, is worth a check-in.
 *
 * Trigger groups (v1.16.5, per-group opt-outs in the prefs blob):
 *   medication → compliance; vitals → bp / score / weight / sleepDebt;
 *   routine → measurementGap / selfContext.
 *
 * Copy (v1.25.0): a warm, localized, deterministic TEMPLATE. The title
 * carries a greeting with the user's name ("Guten Morgen, …" / "Hey …",
 * rotating; the 05:15 cron makes a morning frame safe); the body carries
 * one calm observation and a gentle invite, never an imperative. When the
 * user set a Coach focus the body adds a NON-QUOTING acknowledgment — the
 * raw self-context sentence is never read back, only its presence
 * referenced. Nothing is decrypted here; the focus is a presence flag.
 *
 * AI enrichment (v1.25.0, opt-in, default OFF): when the user opted in AND
 * a provider is healthy, the body is composed through the model instead of
 * the template — under a per-user budget gate, a tight per-call timeout and
 * a per-tick ceiling. ANY error/timeout/budget falls silently back to the
 * deterministic template, which is always the safe default.
 *
 * Anti-nag (NORTH-STAR): the rolling frequency cap already prevents two
 * nudges in a window (so never two days running), nothing-to-say is silence
 * by construction (no trigger → no nudge), and a user who engaged the Coach
 * in the last ~24 h is skipped.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getAssistantFlags } from "@/lib/feature-flags";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { annotate } from "@/lib/logging/context";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { dispatchNotification } from "@/lib/notifications/dispatcher";
import { resolveCoachNudgePrefs } from "@/lib/validations/notification-prefs";
import { recordProactiveNudge } from "@/lib/ai/coach/persistence";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { coerceLocale } from "@/lib/i18n/config";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import {
  composeNudgeWithAI,
  createNudgeAiTickBudget,
  type ComposeNudgeWithAI,
  type NudgeAiTickBudget,
} from "@/lib/jobs/coach-nudge-ai";
import { getEvent } from "@/lib/logging/context";
import { resolveCanonicalRecovery } from "@/lib/insights/derived/recovery-resolve";
import { resolveRestMode } from "@/lib/illness/rest-mode";
import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import {
  DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  type HealthProfileAiSection,
} from "@/lib/validations/health-profile-facts";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SELF_CONTEXT_AI_SECTIONS = [
  "ABOUT_ME",
  "CONDITIONS",
  "ALLERGIES",
  "COACH_FOCUS",
] as const satisfies readonly HealthProfileAiSection[];

/** Pg-boss queue + cron — imported by the reminder worker's bootstrap. */
export const COACH_NUDGE_QUEUE = "coach-nudge";
/** 05:15 Europe/Berlin — after the 04:45–04:55 score crons settled. */
export const COACH_NUDGE_CRON = "15 5 * * *";

/**
 * Frequency cap default: one nudge per user per rolling week. v1.16.5 —
 * the per-user `nudgeFrequency` pref ("weekly" | "biweekly") can widen
 * this to 14 days; the constant remains the default and the unit-test
 * anchor.
 */
export const COACH_NUDGE_MIN_INTERVAL_DAYS = 7;

/** Compliance trigger: 7-day rate below this fires (0..1). */
export const COACH_NUDGE_COMPLIANCE_THRESHOLD = 0.6;
/** Compliance trigger: minimum due doses before the rate is trusted. */
export const COACH_NUDGE_COMPLIANCE_MIN_DOSES = 5;
/** BP trigger: minimum systolic readings in the 7-day window. */
export const COACH_NUDGE_BP_MIN_READINGS = 3;
/** Score trigger: minimum recovery-score points the weekly mean must drop. */
export const COACH_NUDGE_SCORE_DROP = 15;
/** Score trigger: minimum samples per weekly window. */
export const COACH_NUDGE_SCORE_MIN_SAMPLES = 3;
/** Self-context trigger: profile older than this counts as stale. */
export const COACH_NUDGE_SELF_CONTEXT_STALE_DAYS = 60;
/** Self-context trigger: Coach usage within this window counts as active. */
export const COACH_NUDGE_COACH_ACTIVE_DAYS = 14;
/** Weight trigger: minimum readings per weekly window. */
export const COACH_NUDGE_WEIGHT_MIN_READINGS = 3;
/** Weight trigger: minimum kg the weekly mean must drift AWAY from the range. */
export const COACH_NUDGE_WEIGHT_DRIFT_KG = 0.5;
/** Sleep trigger: minimum recorded nights in the 7-day window. */
export const COACH_NUDGE_SLEEP_MIN_NIGHTS = 5;
/** Sleep trigger: a night must undershoot the floor by this margin (h). */
export const COACH_NUDGE_SLEEP_DEFICIT_MARGIN_H = 0.5;
/** Sleep trigger: nights under the floor required to fire. */
export const COACH_NUDGE_SLEEP_DEFICIT_NIGHTS = 4;
/** Gap trigger: distinct active days required in the prior 3 weeks. */
export const COACH_NUDGE_GAP_MIN_ACTIVE_DAYS = 10;
/** Gap trigger: length of the silent window that fires (days). */
export const COACH_NUDGE_GAP_SILENT_DAYS = 7;
/** Gap trigger: activity lookback BEFORE the silent window (days). */
export const COACH_NUDGE_GAP_LOOKBACK_DAYS = 21;
/**
 * Anti-nag suppression: skip the nudge when the user already talked to the
 * Coach within this window. A proactive outreach to someone who just engaged
 * is noise, not care.
 */
export const COACH_NUDGE_RECENT_ENGAGEMENT_HOURS = 24;

export type CoachNudgeTrigger =
  | "compliance"
  | "bp"
  | "score"
  | "selfContext"
  | "weight"
  | "sleepDebt"
  | "measurementGap";

/** v1.16.5 — per-group opt-outs map triggers onto three pref toggles. */
export type CoachNudgeTriggerGroup = "medication" | "vitals" | "routine";

export const COACH_NUDGE_TRIGGER_GROUPS: Record<
  CoachNudgeTrigger,
  CoachNudgeTriggerGroup
> = {
  compliance: "medication",
  bp: "vitals",
  score: "vitals",
  weight: "vitals",
  sleepDebt: "vitals",
  measurementGap: "routine",
  selfContext: "routine",
};

export interface CoachNudgeSummary {
  candidatesScanned: number;
  dispatched: number;
  /**
   * v1.18.6 (CCH-02) — nudges written into the conversation rail as an
   * initial ASSISTANT message. Counted independently of `dispatched`:
   * the conversation lands even when no push channel is configured, so
   * `persisted` can exceed `dispatched`.
   */
  persisted: number;
  skippedOptedOut: number;
  skippedNoProvider: number;
  /**
   * The `coach` capability is unavailable for a reason other than a missing
   * provider or consent (operator switch, Coach switch, authority, a failed
   * check).
   */
  skippedUnavailable: number;
  skippedRecentNudge: number;
  /**
   * v1.25.0 — anti-nag: the user talked to the Coach within the last ~24 h,
   * so the proactive nudge is suppressed (engaging someone who just engaged
   * is noise, not care).
   */
  skippedRecentEngagement: number;
  skippedNoTrigger: number;
  skippedNoChannel: number;
  /**
   * v1.18.1 P4 — Rest Mode pause: a cadence-nudge ("weigh more often",
   * "measure BP morning + evening") is the wrong message to a user who is
   * actively unwell. While an illness episode is active the nudge is paused,
   * not penalised: nothing is recorded against the user, the cadence simply
   * resumes once the episode resolves.
   */
  skippedDuringIllness: number;
  failed: number;
}

/**
 * Pure trigger predicates — exported for the unit tests so the
 * thresholds stay pinned without a DB.
 */
export function evaluateComplianceTrigger(
  rows: { takenAt: Date | null; skipped: boolean; autoMissed: boolean }[],
): boolean {
  // Deliberate skips are a planned break, not a compliance problem —
  // exclude them from both numerator and denominator (the compliance
  // engine's own semantics).
  //
  // v1.16.1 — only RESOLVED slots count toward the denominator: taken
  // rows and auto-missed rows (the hourly auto-miss cron flips a pending
  // once its overdue window has closed, so `autoMissed` IS the
  // "overdueEnd < now" signal without re-deriving per-schedule windows
  // here). A still-open pending — today's not-yet-due slot, or one whose
  // grace window is still running — used to count as a miss and could
  // nudge a perfectly adherent user at 05:15 over doses they simply
  // had not reached yet.
  const due = rows.filter(
    (r) => !r.skipped && (r.takenAt !== null || r.autoMissed),
  );
  if (due.length < COACH_NUDGE_COMPLIANCE_MIN_DOSES) return false;
  const taken = due.filter((r) => r.takenAt !== null).length;
  return taken / due.length < COACH_NUDGE_COMPLIANCE_THRESHOLD;
}

export function evaluateBpTrigger(
  systolicValues: number[],
  greenMax: number | null,
): boolean {
  if (greenMax === null) return false;
  if (systolicValues.length < COACH_NUDGE_BP_MIN_READINGS) return false;
  const mean =
    systolicValues.reduce((sum, v) => sum + v, 0) / systolicValues.length;
  return mean > greenMax;
}

export interface SelfContextTriggerInput {
  /** Presence-only view of the questionnaire (encrypted columns). */
  profile: {
    hasAboutMe: boolean;
    hasConditions: boolean;
    hasAllergies: boolean;
    hasCoachFocus: boolean;
    updatedAt: Date;
  } | null;
  /** Most recent CoachUsage activity, or null when never used. */
  lastCoachUseAt: Date | null;
}

/**
 * v1.16.0 — fourth trigger: the self-context is incomplete (any of the
 * four fields empty, or no profile at all) or stale (60+ days), AND
 * the user actively talks to the Coach. Without the activity gate this
 * would nag every passive account forever.
 */
export function evaluateSelfContextTrigger(
  input: SelfContextTriggerInput,
  now: Date,
): boolean {
  const { profile, lastCoachUseAt } = input;
  if (
    lastCoachUseAt === null ||
    now.getTime() - lastCoachUseAt.getTime() >
      COACH_NUDGE_COACH_ACTIVE_DAYS * MS_PER_DAY
  ) {
    return false;
  }
  if (profile === null) return true;
  const incomplete =
    !profile.hasAboutMe ||
    !profile.hasConditions ||
    !profile.hasAllergies ||
    !profile.hasCoachFocus;
  const stale =
    now.getTime() - profile.updatedAt.getTime() >
    COACH_NUDGE_SELF_CONTEXT_STALE_DAYS * MS_PER_DAY;
  return incomplete || stale;
}

export function evaluateScoreTrigger(
  recentValues: number[],
  priorValues: number[],
): boolean {
  if (
    recentValues.length < COACH_NUDGE_SCORE_MIN_SAMPLES ||
    priorValues.length < COACH_NUDGE_SCORE_MIN_SAMPLES
  ) {
    return false;
  }
  const mean = (values: number[]) =>
    values.reduce((sum, v) => sum + v, 0) / values.length;
  return mean(priorValues) - mean(recentValues) >= COACH_NUDGE_SCORE_DROP;
}

/**
 * v1.16.5 — weight trend drift against the user's effective green
 * range. Two conditions, both required, so a single heavy breakfast
 * never nudges:
 *   1. the recent 7-day mean sits OUTSIDE the green range, and
 *   2. it has drifted at least `COACH_NUDGE_WEIGHT_DRIFT_KG` further
 *      away from the range than the prior week's mean — direction-aware
 *      via distance-to-range, so it fires for moving away on either
 *      side and stays silent while the user converges back.
 * Both windows need `COACH_NUDGE_WEIGHT_MIN_READINGS` readings; no
 * resolvable range (no height, no override) never fires.
 */
export function evaluateWeightTrigger(
  recentValues: number[],
  priorValues: number[],
  range: { greenMin: number; greenMax: number } | null,
): boolean {
  if (range === null) return false;
  if (
    recentValues.length < COACH_NUDGE_WEIGHT_MIN_READINGS ||
    priorValues.length < COACH_NUDGE_WEIGHT_MIN_READINGS
  ) {
    return false;
  }
  const mean = (values: number[]) =>
    values.reduce((sum, v) => sum + v, 0) / values.length;
  const distance = (v: number) =>
    Math.max(0, range.greenMin - v, v - range.greenMax);
  const recentDistance = distance(mean(recentValues));
  const priorDistance = distance(mean(priorValues));
  return (
    recentDistance > 0 &&
    recentDistance - priorDistance >= COACH_NUDGE_WEIGHT_DRIFT_KG
  );
}

/**
 * v1.16.5 — sleep-deficit series. Fires when at least
 * `COACH_NUDGE_SLEEP_DEFICIT_NIGHTS` of the recorded nights undershoot
 * the effective sleep floor by a clear margin (0.5 h — a 6:55 night
 * against a 7 h floor is not a deficit pattern). Requires at least
 * `COACH_NUDGE_SLEEP_MIN_NIGHTS` recorded nights in the 7-day window so
 * a sparsely tracked week stays silent; no resolvable floor never fires.
 */
export function evaluateSleepDebtTrigger(
  nightlyHours: number[],
  greenMin: number | null,
): boolean {
  if (greenMin === null) return false;
  if (nightlyHours.length < COACH_NUDGE_SLEEP_MIN_NIGHTS) return false;
  const deficits = nightlyHours.filter(
    (h) => h < greenMin - COACH_NUDGE_SLEEP_DEFICIT_MARGIN_H,
  ).length;
  return deficits >= COACH_NUDGE_SLEEP_DEFICIT_NIGHTS;
}

/**
 * v1.16.5 — measurement-gap series: a previously ACTIVE account that
 * abruptly stops recording anything. Active means measurements on at
 * least `COACH_NUDGE_GAP_MIN_ACTIVE_DAYS` distinct days across the
 * three weeks BEFORE the silent window; the trigger fires only when the
 * last `COACH_NUDGE_GAP_SILENT_DAYS` days hold zero measurements. A
 * sporadically tracking account never qualifies as "active", so it is
 * never nagged for being itself.
 */
export function evaluateMeasurementGapTrigger(
  priorActiveDays: number,
  recentMeasurementCount: number,
): boolean {
  return (
    priorActiveDays >= COACH_NUDGE_GAP_MIN_ACTIVE_DAYS &&
    recentMeasurementCount === 0
  );
}

/** The per-trigger observation key. The title is a greeting (see below). */
const NUDGE_BODY_KEY: Record<CoachNudgeTrigger, string> = {
  compliance: "coachNudges.complianceBody",
  bp: "coachNudges.bpBody",
  score: "coachNudges.scoreBody",
  selfContext: "coachNudges.selfContextBody",
  weight: "coachNudges.weightBody",
  sleepDebt: "coachNudges.sleepDebtBody",
  measurementGap: "coachNudges.measurementGapBody",
};

/** Two rotating morning-safe openers; index picked from `openerSeed`. */
const GREETING_KEYS = [
  {
    named: "coachNudges.greetingMorningNamed",
    plain: "coachNudges.greetingMorning",
  },
  { named: "coachNudges.greetingHeyNamed", plain: "coachNudges.greetingHey" },
] as const;

export interface NudgePayloadOptions {
  /**
   * Display name for the greeting. Null / empty → a name-less greeting
   * ("Guten Morgen") rather than an awkward "Guten Morgen, ".
   */
  name?: string | null;
  /**
   * Whether the user set a Coach focus. Drives a NON-QUOTING acknowledgment
   * line — the raw focus sentence is never read back, only its presence
   * referenced. Ignored for the self-context check-up (it asks the user to
   * refresh that very focus).
   */
  hasCoachFocus?: boolean;
  /**
   * Deterministic rotation seed for the greeting opener (e.g. the day of the
   * month) so the opener varies day to day but stays stable within a tick.
   */
  openerSeed?: number;
}

/**
 * v1.25.0 — derive a warm greeting name from the user's profile. Prefers the
 * explicit display name, then the given (first) token of the full name; falls
 * back to a sanitised username only when it is not an email-shaped login.
 * Returns null when nothing safe is available, so the greeting drops the name
 * rather than addressing the user by an email or an empty string.
 */
export function resolveGreetingName(user: {
  displayName?: string | null;
  fullName?: string | null;
  username?: string | null;
}): string | null {
  const firstToken = (raw: string | null | undefined): string | null => {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return null;
    const token = trimmed.split(/\s+/)[0];
    return token && token.length > 0 ? token.slice(0, 40) : null;
  };
  const fromDisplay = firstToken(user.displayName);
  if (fromDisplay) return fromDisplay;
  const fromFull = firstToken(user.fullName);
  if (fromFull) return fromFull;
  const username = (user.username ?? "").trim();
  if (username && !username.includes("@") && !/\s/.test(username)) {
    return username.slice(0, 40);
  }
  return null;
}

/**
 * Build the localised push payload for a trigger.
 *
 * v1.25.0 — the TITLE is a warm greeting (with the user's name when known,
 * rotating openers; 05:15 makes a morning frame safe). The BODY is one calm
 * observation plus a gentle invite, deliberately vague on numbers — a lock
 * screen is not the place for health figures; the Coach conversation carries
 * the detail. When the user set a Coach focus the body adds a non-quoting
 * acknowledgment (the raw focus sentence is never read back). The
 * self-context check-up skips that acknowledgment: it is itself the prompt to
 * refresh the focus.
 */
export function buildCoachNudgePayload(
  trigger: CoachNudgeTrigger,
  locale: string | null | undefined,
  options: NudgePayloadOptions = {},
): { title: string; body: string } {
  const t = getServerTranslator(coerceLocale(locale)).t;
  const name = options.name?.trim() || null;
  const opener =
    GREETING_KEYS[(options.openerSeed ?? 0) % GREETING_KEYS.length];
  const title = name ? t(opener.named, { name }) : t(opener.plain);

  let body = t(NUDGE_BODY_KEY[trigger]);
  if (options.hasCoachFocus && trigger !== "selfContext") {
    body = `${body} ${t("coachNudges.focusNote")}`;
  }
  return { title, body };
}

/**
 * Evaluate the triggers for one user. Exported for tests; the tick
 * below feeds it the pre-fetched rows. v1.16.5 — `groups` carries the
 * per-group opt-outs from the prefs blob: a disabled group's triggers
 * are skipped entirely (no queries, no evaluation). Defaults to
 * all-enabled so existing callers keep the old behaviour.
 */
export async function findTriggerForUser(
  prisma: PrismaClient,
  user: {
    id: string;
    heightCm: number | null;
    dateOfBirth: Date | null;
    gender: string | null;
    thresholdsJson: unknown;
    timezone?: string | null;
  },
  now: Date,
  groups: Record<CoachNudgeTriggerGroup, boolean> = {
    medication: true,
    vitals: true,
    routine: true,
  },
  aiIncludedSections: ReadonlySet<HealthProfileAiSection> = new Set(
    DEFAULT_HEALTH_PROFILE_AI_SECTIONS,
  ),
): Promise<CoachNudgeTrigger | null> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * MS_PER_DAY);

  const effectiveRange = (
    metric: "BLOOD_PRESSURE_SYS" | "WEIGHT" | "SLEEP_DURATION",
  ) =>
    getEffectiveRange(
      metric,
      {
        heightCm: user.heightCm,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
      },
      (user.thresholdsJson ?? null) as ThresholdOverridesJson | null,
    ).range;

  // ── medication group ───────────────────────────────────────────────
  if (groups.medication) {
    // 1) Medication compliance (7 d). `autoMissed` rides along so the
    //    trigger can restrict its denominator to resolved slots — a
    //    still-open pending is not a miss yet.
    const intakeRows = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        scheduledFor: { gte: sevenDaysAgo, lte: now },
        // v1.39.1 (#1033) — a medication kept as a record expects no dose;
        // its rows must not raise a compliance nudge.
        ...TRACKED_INTAKE_EVENT_WHERE,
      },
      select: { takenAt: true, skipped: true, autoMissed: true },
    });
    if (evaluateComplianceTrigger(intakeRows)) return "compliance";
  }

  // ── vitals group ───────────────────────────────────────────────────
  if (groups.vitals) {
    // 2) Systolic weekly mean vs the user's effective target.
    const systolic = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "BLOOD_PRESSURE_SYS",
        deletedAt: null,
        measuredAt: { gte: sevenDaysAgo, lte: now },
      },
      select: { value: true },
    });
    if (systolic.length >= COACH_NUDGE_BP_MIN_READINGS) {
      if (
        evaluateBpTrigger(
          systolic.map((m) => m.value),
          effectiveRange("BLOOD_PRESSURE_SYS")?.greenMax ?? null,
        )
      ) {
        return "bp";
      }
    }

    // 3) Recovery score falling sharply week-over-week. RECOVERY_SCORE is
    //    written by TWO sources (WHOOP-native + the COMPUTED proxy); reading
    //    the raw rows would blend both series into the trend windows and let a
    //    single night appear twice. Resolve to the ONE canonical row per night
    //    (WHOOP wins when present) before the recent/prior split — the same
    //    "one number, one engine" rule the wellness tile applies.
    const scoreRows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "RECOVERY_SCORE",
        deletedAt: null,
        measuredAt: { gte: fourteenDaysAgo, lte: now },
      },
      select: { value: true, measuredAt: true, source: true },
    });
    const scores = resolveCanonicalRecovery(scoreRows, user.timezone ?? null);
    const recent = scores
      .filter((m) => m.measuredAt >= sevenDaysAgo)
      .map((m) => m.value);
    const prior = scores
      .filter((m) => m.measuredAt < sevenDaysAgo)
      .map((m) => m.value);
    if (evaluateScoreTrigger(recent, prior)) return "score";

    // 4) Weight weekly mean drifting away from the effective range.
    const weightRange = effectiveRange("WEIGHT");
    if (weightRange) {
      const weights = await prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: "WEIGHT",
          deletedAt: null,
          measuredAt: { gte: fourteenDaysAgo, lte: now },
        },
        select: { value: true, measuredAt: true },
      });
      const recentWeights = weights
        .filter((m) => m.measuredAt >= sevenDaysAgo)
        .map((m) => m.value);
      const priorWeights = weights
        .filter((m) => m.measuredAt < sevenDaysAgo)
        .map((m) => m.value);
      if (
        evaluateWeightTrigger(recentWeights, priorWeights, {
          greenMin: weightRange.greenMin,
          greenMax: weightRange.greenMax,
        })
      ) {
        return "weight";
      }
    }

    // 5) Sleep-deficit series: per-night asleep HOURS over the last 7
    //    days, reconstructed through the canonical sleep engine.
    //
    //    `SLEEP_DURATION` is stored one row per STAGE per night, in
    //    MINUTES. The trigger compares against
    //    `effectiveRange("SLEEP_DURATION").greenMin`, which is in HOURS
    //    (7). The prior inline model kept each night's MAX single stage
    //    row (a fragment, not the night) AND fed minutes straight into
    //    the hours comparison — so a real ~360-480 minute night never
    //    cleared `< 6.5` and the nudge could never fire. Reusing
    //    `reconstructSleepNights` gives the proper asleep total
    //    (CORE+DEEP+REM, multi-source de-duped, user-tz wake-day keyed);
    //    dividing by 60 converts to the hours the trigger expects.
    const sleepRows = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        type: "SLEEP_DURATION",
        deletedAt: null,
        measuredAt: { gte: sevenDaysAgo, lte: now },
      },
      select: {
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        deviceType: true,
      },
    });
    if (sleepRows.length > 0) {
      const sourcePriority = await loadUserSourcePriority(user.id);
      const nights = reconstructSleepNights(
        sleepRows,
        user.timezone ?? DEFAULT_TIMEZONE,
        sourcePriority,
      );
      const nightlyHours = nights.map((n) => n.asleepMinutes / 60);
      if (
        evaluateSleepDebtTrigger(
          nightlyHours,
          effectiveRange("SLEEP_DURATION")?.greenMin ?? null,
        )
      ) {
        return "sleepDebt";
      }
    }
  }

  // ── routine group ──────────────────────────────────────────────────
  if (groups.routine) {
    // 6) Measurement gap: an active account going silent for a week.
    //    The recent count is cheap; the distinct-day count over the
    //    prior three weeks runs as one aggregate instead of pulling
    //    every row (dense intraday sources would make that thousands).
    const recentCount = await prisma.measurement.count({
      where: {
        userId: user.id,
        deletedAt: null,
        measuredAt: { gte: sevenDaysAgo, lte: now },
      },
    });
    if (recentCount === 0) {
      const gapWindowStart = new Date(
        sevenDaysAgo.getTime() - COACH_NUDGE_GAP_LOOKBACK_DAYS * MS_PER_DAY,
      );
      const activeDayRows = await prisma.$queryRaw<{ days: number }[]>`
        SELECT COUNT(DISTINCT (measured_at AT TIME ZONE 'UTC')::date)::int AS days
        FROM measurements
        WHERE user_id = ${user.id}
          AND deleted_at IS NULL
          AND measured_at >= ${gapWindowStart}
          AND measured_at < ${sevenDaysAgo}
      `;
      if (
        evaluateMeasurementGapTrigger(activeDayRows[0]?.days ?? 0, recentCount)
      ) {
        return "measurementGap";
      }
    }

    // 7) Self-context incomplete / stale while the Coach is in active
    //    use. Excluded sections count as intentionally complete and their
    //    encrypted columns are not selected.
    const hasIncludedSelfContextSection = SELF_CONTEXT_AI_SECTIONS.some(
      (section) => aiIncludedSections.has(section),
    );
    if (hasIncludedSelfContextSection) {
      const coachActiveCutoff = new Date(
        now.getTime() - COACH_NUDGE_COACH_ACTIVE_DAYS * MS_PER_DAY,
      );
      const recentUsage = await prisma.coachUsage.findFirst({
        where: { userId: user.id, updatedAt: { gte: coachActiveCutoff } },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      });
      if (recentUsage) {
        const profileRow = (await prisma.userHealthProfile.findUnique({
          where: { userId: user.id },
          select: {
            ...(aiIncludedSections.has("ABOUT_ME")
              ? { aboutMeEncrypted: true }
              : {}),
            ...(aiIncludedSections.has("CONDITIONS")
              ? { conditionsEncrypted: true }
              : {}),
            ...(aiIncludedSections.has("ALLERGIES")
              ? { allergiesEncrypted: true }
              : {}),
            ...(aiIncludedSections.has("COACH_FOCUS")
              ? { coachFocusEncrypted: true }
              : {}),
            updatedAt: true,
          },
        })) as {
          aboutMeEncrypted?: Uint8Array | null;
          conditionsEncrypted?: Uint8Array | null;
          allergiesEncrypted?: Uint8Array | null;
          coachFocusEncrypted?: Uint8Array | null;
          updatedAt: Date;
        } | null;
        const triggered = evaluateSelfContextTrigger(
          {
            profile: profileRow
              ? {
                  hasAboutMe:
                    !aiIncludedSections.has("ABOUT_ME") ||
                    profileRow.aboutMeEncrypted != null,
                  hasConditions:
                    !aiIncludedSections.has("CONDITIONS") ||
                    profileRow.conditionsEncrypted != null,
                  hasAllergies:
                    !aiIncludedSections.has("ALLERGIES") ||
                    profileRow.allergiesEncrypted != null,
                  hasCoachFocus:
                    !aiIncludedSections.has("COACH_FOCUS") ||
                    profileRow.coachFocusEncrypted != null,
                  updatedAt: profileRow.updatedAt,
                }
              : null,
            lastCoachUseAt: recentUsage.updatedAt,
          },
          now,
        );
        if (triggered) return "selfContext";
      }
    }
  }

  return null;
}

/**
 * Run one coach-nudge cron tick. Per-user work is wrapped in its own
 * try/catch so a single bad row cannot abort the rest of the pass.
 */
export async function runCoachNudgeTick(
  prisma: PrismaClient,
  now: Date,
  options: {
    dispatch?: typeof dispatchNotification;
    recordNudge?: typeof recordProactiveNudge;
    /**
     * v1.25.0 — injectable AI composer (tests stub it). Defaults to the real
     * `composeNudgeWithAI`; the shared per-tick budget is created once below.
     */
    composeAi?: ComposeNudgeWithAI;
  } = {},
): Promise<CoachNudgeSummary> {
  const dispatchImpl = options.dispatch ?? dispatchNotification;
  const recordNudgeImpl = options.recordNudge ?? recordProactiveNudge;
  const composeAiImpl = options.composeAi ?? composeNudgeWithAI;
  // v1.25.0 — one budget for the whole sequential tick: a cap on AI
  // compositions and a wall-clock ceiling so a slow provider can't stall the
  // 05:15 pass across the user base. Exhaustion → template for the rest.
  const aiTickBudget: NudgeAiTickBudget = createNudgeAiTickBudget();

  const summary: CoachNudgeSummary = {
    candidatesScanned: 0,
    dispatched: 0,
    persisted: 0,
    skippedOptedOut: 0,
    skippedNoProvider: 0,
    skippedUnavailable: 0,
    skippedRecentNudge: 0,
    skippedRecentEngagement: 0,
    skippedNoTrigger: 0,
    skippedNoChannel: 0,
    skippedDuringIllness: 0,
    failed: 0,
  };

  // Gate 1 — operator kill-switch (master assistant switch included).
  const flags = await getAssistantFlags();
  if (!flags.coach) return summary;

  // Gate 2 — per-user Coach opt-out.
  const users = await prisma.user.findMany({
    where: { disableCoach: false },
    select: {
      id: true,
      locale: true,
      displayName: true,
      fullName: true,
      username: true,
      notificationPrefs: true,
      heightCm: true,
      dateOfBirth: true,
      gender: true,
      thresholdsJson: true,
      timezone: true,
    },
  });
  if (users.length === 0) return summary;

  for (const user of users) {
    summary.candidatesScanned += 1;
    try {
      // Gate 4 — per-user opt-out: master switch plus the v1.16.5
      // per-group toggles. A user with the master ON but every group
      // OFF counts as opted out, not as "no trigger".
      const nudgePrefs = resolveCoachNudgePrefs(user.notificationPrefs);
      if (
        !nudgePrefs.enabled ||
        (!nudgePrefs.groups.medication &&
          !nudgePrefs.groups.vitals &&
          !nudgePrefs.groups.routine)
      ) {
        summary.skippedOptedOut += 1;
        continue;
      }

      // Gate 3 — the `coach` capability. A Coach that cannot answer gets no
      // nudge; a missing consent receipt alone still gets the template.
      const coach = await aiCapabilityForJob(user.id, "coach");
      if (!coach.available && coach.reason !== "consent_required") {
        if (coach.reason === "no_provider") summary.skippedNoProvider += 1;
        else summary.skippedUnavailable += 1;
        annotate({
          action: { name: "coach.nudge.skipped" },
          meta: { reason: coach.reason },
        });
        continue;
      }

      // Gate 5 — one nudge per rolling window (7 d default, 14 d when
      // the user picked "biweekly"). Anchored on BOTH the push-attempts
      // ledger (a delivered nudge writes an `ok` row per succeeding
      // channel) AND the persisted nudge conversation (v1.18.6 CCH-02
      // writes one regardless of push outcome). A user with no push
      // channel never gets an `ok` row, so without the persisted-side
      // check the cap would be inert for them and every tick would mint a
      // fresh rail conversation. A fully failed dispatch on a push-capable
      // user still leaves the ledger slot free, but the persisted nudge
      // already pins the window — exactly the once-per-window contract.
      const capCutoff = new Date(
        now.getTime() - nudgePrefs.minIntervalDays * MS_PER_DAY,
      );
      const recentNudge = await prisma.pushAttempt.findFirst({
        where: {
          userId: user.id,
          eventType: "COACH_NUDGE",
          result: "ok",
          createdAt: { gte: capCutoff },
        },
        select: { id: true },
      });
      if (recentNudge) {
        summary.skippedRecentNudge += 1;
        continue;
      }
      const recentPersistedNudge = await prisma.coachMessage.findFirst({
        where: {
          providerType: "nudge",
          role: "assistant",
          conversation: { userId: user.id },
          createdAt: { gte: capCutoff },
        },
        select: { id: true },
      });
      if (recentPersistedNudge) {
        summary.skippedRecentNudge += 1;
        continue;
      }

      // Gate 6 — anti-nag engagement suppression (v1.25.0). A user who
      // talked to the Coach within the last ~24 h does not need to be poked
      // toward it; the proactive outreach is for someone who has drifted, not
      // someone already in the conversation. Cheaper than the trigger search,
      // so it sits ahead of it.
      const engagementCutoff = new Date(
        now.getTime() - COACH_NUDGE_RECENT_ENGAGEMENT_HOURS * 60 * 60 * 1000,
      );
      const recentEngagement = await prisma.coachUsage.findFirst({
        where: { userId: user.id, updatedAt: { gte: engagementCutoff } },
        select: { userId: true },
      });
      if (recentEngagement) {
        summary.skippedRecentEngagement += 1;
        continue;
      }

      // Gate 7 — Rest Mode pause (v1.18.1 P4). A user with an active
      // illness/condition episode should not be told to measure more often;
      // the cadence-nudge pauses for the duration of the episode. Module-gated
      // (a non-illness account is never in Rest Mode) and only reached past
      // every cheaper gate, so the read fires for at most a nudge-eligible
      // user per tick.
      const restMode = await resolveRestMode(user.id, now, prisma);
      if (restMode.active) {
        summary.skippedDuringIllness += 1;
        continue;
      }

      const controlRow = await prisma.userHealthProfile.findUnique({
        where: { userId: user.id },
        select: { aiIncludedSections: true },
      });
      const aiIncludedSections = new Set<HealthProfileAiSection>(
        (controlRow?.aiIncludedSections ??
          DEFAULT_HEALTH_PROFILE_AI_SECTIONS) as HealthProfileAiSection[],
      );
      const trigger = await findTriggerForUser(
        prisma,
        user,
        now,
        nudgePrefs.groups,
        aiIncludedSections,
      );
      if (!trigger) {
        summary.skippedNoTrigger += 1;
        continue;
      }

      // Personalisation — the user's Coach focus is referenced ONLY by
      // PRESENCE now (v1.25.0): a non-quoting acknowledgment, never the raw
      // decrypted sentence read back. So a cheap presence read replaces the
      // former decrypt; nothing sensitive is decrypted during the nudge.
      let hasCoachFocus = false;
      if (trigger !== "selfContext" && aiIncludedSections.has("COACH_FOCUS")) {
        const profileRow = await prisma.userHealthProfile.findUnique({
          where: { userId: user.id },
          select: { coachFocusEncrypted: true },
        });
        hasCoachFocus = profileRow?.coachFocusEncrypted != null;
      }

      const locale = await resolveJobLocale(user.locale);
      const name = resolveGreetingName(user);
      // Rotate the opener day to day, stable within a tick.
      const openerSeed = now.getUTCDate();

      // The deterministic template is the DEFAULT and the fail-closed
      // fallback. It is built unconditionally so the AI path always has a
      // ready-made replacement to fall back to on any error/timeout/budget.
      const template = buildCoachNudgePayload(trigger, locale, {
        name,
        hasCoachFocus,
        openerSeed,
      });

      let title = template.title;
      let body = template.body;

      // AI enrichment (opt-in, default OFF). Composes the body through the
      // model under hard guards; ANY failure returns null and we keep the
      // template. The greeting title stays deterministic so the warm,
      // name-led opener is guaranteed regardless of the model's output.
      if (nudgePrefs.aiComposed) {
        const composed = await composeAiImpl({
          userId: user.id,
          trigger,
          locale,
          name,
          hasCoachFocus,
          template,
          tickBudget: aiTickBudget,
        });
        if (composed) {
          title = composed.title;
          body = composed.body;
        }
      }

      // v1.18.6 (CCH-02) — persist the nudge as a real conversation
      // BEFORE dispatching the notification. The proactive nudge used to
      // be notification-only, so a user with no push channel never saw
      // it anywhere; writing it as the initial ASSISTANT message means it
      // always lands in the conversation rail (and clears the FAB unread
      // dot once the user opens the Coach). A persistence failure must
      // not swallow the notification, so it is caught locally and the
      // dispatch still fires.
      let nudgeConversationId: string | null = null;
      try {
        const recorded = await recordNudgeImpl({
          userId: user.id,
          title,
          body,
        });
        // v1.22 (W5) — keep the conversation id so the push deep-links
        // precisely into the proactive thread instead of the generic
        // `/coach`, closing the most-recent-heuristic gap on the web side.
        nudgeConversationId = recorded.conversationId;
        summary.persisted += 1;
      } catch (persistErr: unknown) {
        const message =
          persistErr instanceof Error ? persistErr.message : String(persistErr);
        getEvent()?.addWarning(
          `coach-nudge conversation persist failed for ${user.id}: ${message}`,
        );
      }

      const outcome = await dispatchImpl({
        eventType: "COACH_NUDGE",
        userId: user.id,
        title,
        message: body,
        metadata: {
          scheduledAt: now.toISOString(),
          trigger,
          // Deep link — the web-push sender threads this into the
          // service-worker payload's click target. Point at the exact
          // proactive conversation when it persisted; fall back to the
          // generic Coach surface if persistence failed.
          url: nudgeConversationId
            ? `/coach?c=${nudgeConversationId}`
            : "/coach",
        },
      });

      if (!outcome.dispatched) {
        summary.skippedNoChannel += 1;
        continue;
      }
      summary.dispatched += 1;
    } catch (err: unknown) {
      summary.failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      getEvent()?.addWarning(
        `coach-nudge per-user pass failed for ${user.id}: ${message}`,
      );
    }
  }

  return summary;
}
