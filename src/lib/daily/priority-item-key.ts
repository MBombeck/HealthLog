/**
 * Deterministic identity keys for the Today rail items. Every item carries
 * one, so a client can tell two rows apart without deriving an id from what
 * they show (two dose rows read alike). Only the dismissible
 * (observational) kinds — `milestone`, `ecg_new_recording`,
 * `tension_window`, `same_time_baseline` — can be dismissed by it; the
 * actionable kinds' keys are identity only. Pure string
 * formatting, no DB, no clock: both the digest composer (`./digest.ts`, which
 * stamps the key onto the emitted `PriorityItem`) and the IO seam
 * (`./load-digest.ts`, which needs the SAME keys to look up which of today's
 * candidates are already dismissed) import from here so the format is one
 * source of truth.
 *
 * Each key is namespaced `<kind>:...` (see `isDismissibleItemKey` in
 * `./priority-item.ts`) and folds in enough of the underlying candidate's own
 * identity that a fresh instance the NEXT day never collides with today's
 * dismissed one — a milestone by its reach day, an ECG recording by its own
 * timestamp, a tension window by the local day it was detected for.
 */
import { createHash } from "node:crypto";

import type { Milestone } from "@/lib/daily/milestones";

/** `milestone:<kind>:<metricType>:<sinceDate>` — one key per durable state reached. */
export function milestoneItemKey(
  milestone: Pick<Milestone, "kind" | "metricType" | "sinceDate">,
): string {
  return `milestone:${milestone.kind}:${milestone.metricType}:${milestone.sinceDate}`;
}

/** `ecg_new_recording:<recordedAt ISO>` — the recording's own timestamp is unique. */
export function ecgItemKey(recordedAt: Date): string {
  return `ecg_new_recording:${recordedAt.toISOString()}`;
}

/**
 * `tension_window:<localDayKey>:<partOfDay>` — at most one per user per day.
 * `partOfDay` mirrors `DailyDigestTensionWindow["partOfDay"]` (`./digest.ts`)
 * by value rather than by import, so this module stays a leaf the digest
 * composer can depend on without a cycle.
 */
export function tensionWindowItemKey(
  localDayKey: string,
  partOfDay: "morning" | "afternoon" | "evening" | "night",
): string {
  return `tension_window:${localDayKey}:${partOfDay}`;
}

/**
 * `same_time_baseline:<localDayKey>:<MeasurementType>` — one key per metric
 * per local day.
 *
 * Deliberately NOT keyed on the hour the comparison was anchored to. The card
 * refreshes as the day goes on, and folding the hour into the key would mean a
 * dismissal at 14:00 was undone at 15:00 — the user would have to swat the
 * same card away nine times before bed. Dismissing it means "not today".
 */
export function sameTimeBaselineItemKey(
  localDayKey: string,
  type: string,
): string {
  return `same_time_baseline:${localDayKey}:${type}`;
}

/** One persisted acknowledgement per Health Score algorithm version. */
export function healthScoreAlgorithmItemKey(scoreVersion: number): string {
  return `health_score_algorithm:${scoreVersion}`;
}

/**
 * The Health Score notice key for one account, folding in the person's
 * OWN recipe version beside the global method version.
 *
 * Two things can change what a score means, and the person needs
 * telling once about each: we change the method (`scoreVersion`), or
 * they change what counts (`configVersion`). One ledger key carrying
 * only the first would leave a recipe change unannounced, and a key
 * carrying only the second would swallow the next method change for
 * everybody who ever opened the settings page. Both dimensions ride the
 * key, so a move in either raises the notice exactly once and a
 * dismissal of one never dismisses the other.
 *
 * An account that never chose keeps the bare
 * `health_score_algorithm:<v>` key unchanged. That is not cosmetic:
 * lengthening the key for everyone would leave every existing
 * acknowledgement pointing at a key nothing looks up, and the method
 * notice would reappear for every account on upgrade.
 *
 * The `health_score_algorithm:` prefix is deliberate — it is the
 * dismiss ledger's namespace (`isDismissibleItemKey`, the dismiss
 * route's score-cache eviction), not user-facing copy, and reusing it
 * is what lets the recipe notice ride machinery that already dismisses
 * and evicts correctly instead of growing a second one beside it.
 */
export function healthScoreNoticeItemKey(
  scoreVersion: number,
  configVersion: number,
): string {
  const base = healthScoreAlgorithmItemKey(scoreVersion);
  return configVersion >= 1 ? `${base}:config:${configVersion}` : base;
}

/**
 * `health-score:v<scoreVersion>:composition:<hash>` — one acknowledgement
 * per SET of pillars a score rests on.
 *
 * The third thing that can change what the number means, after the method
 * and the person's own recipe: a pillar stops counting on its own. A window
 * rolls past its floor, a module goes off, a source goes quiet — and the
 * level moves with nothing on the panel saying why. The delta is already
 * suppressed for exactly this case, which prevents a false "you dropped six
 * points" and says nothing about the six points.
 *
 * Keyed on the RESULTING set rather than on the day, and that choice is the
 * whole behaviour: a set that stays the same tomorrow resolves to the same
 * key, so a dismissal holds instead of the note reappearing every morning,
 * and the next real change hashes differently and raises it again. The cost
 * is that a set the person has already acknowledged stays acknowledged if
 * they later return to it — A → B, dismissed, B → A, B again is silent.
 * That is the honest reading of the dismissal: they have been told what a
 * score on set B rests on, and nothing about B has changed since.
 *
 * The ids are sorted before hashing, so the same set never produces two
 * keys through registry order alone, and the hash is truncated because the
 * key is an identity to compare, not a value to invert.
 *
 * A namespace of its own rather than a suffix under
 * `health_score_algorithm:` — dismissing "the rules moved" must not also
 * dismiss "a pillar left", and one prefix carrying both would make the two
 * indistinguishable to the ledger.
 */
export function healthScoreCompositionItemKey(
  scoreVersion: number,
  composition: readonly string[],
): string {
  const hash = createHash("sha256")
    .update([...composition].sort().join(","))
    .digest("hex")
    .slice(0, 12);
  return `health-score:v${scoreVersion}:composition:${hash}`;
}

/**
 * `dose_window:<medicationId>:<dueAt ISO>` — one key per dose slot. Two doses
 * of one medication, or two medications due at once, never share one; a dose
 * turning overdue keeps its key. `-` stands in for a part an older cached
 * snapshot does not carry.
 */
export function doseWindowItemKey(
  medicationId: string | null | undefined,
  dueAt: string | null | undefined,
): string {
  return `dose_window:${medicationId || "-"}:${dueAt || "-"}`;
}

/** `sync_issue:<integration>` — one item per broken integration. */
export function syncIssueItemKey(integration: string): string {
  return `sync_issue:${integration}`;
}

/** `coach_checkin:<planId>` — the plan the check-in asks about. */
export function coachCheckinItemKey(planId: string): string {
  return `coach_checkin:${planId}`;
}

/** `preventive_care:<localDayKey>` — the one summary item of the day. */
export function preventiveCareItemKey(localDayKey: string): string {
  return `preventive_care:${localDayKey}`;
}

/**
 * `upcoming_visit:<dayOffset>:<first visit id>` — one item per visit day
 * (today, and the next day with a visit).
 */
export function upcomingVisitItemKey(
  dayOffset: number,
  firstVisitId: string,
): string {
  return `upcoming_visit:${dayOffset}:${firstVisitId}`;
}
