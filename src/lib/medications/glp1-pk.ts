/**
 * v1.4.25 W19c — GLP-1 pharmacokinetic helpers (pure module).
 *
 * One-compartment Bateman absorption / elimination math for the five
 * EMA-approved GLP-1 receptor agonists in `glp1-knowledge.ts`.
 *
 * SCOPE LIMIT — read this before extending the file.
 *
 *   This module implements a **one-compartment** first-order
 *   absorption + first-order elimination model. It is suitable
 *   ONLY for **qualitative** display surfaces — the "shot phase"
 *   chip (rising / peak / fading) on the dashboard tile (research
 *   §2.4 / §2.5) and the opt-in research-view AreaChart that the
 *   W19c-Frontend dialog gates behind Research Mode (research §2.3).
 *
 *   Two-compartment math is **explicitly out of scope** for W19c
 *   for two regulatory reasons:
 *
 *     1. The journal-of-record (Schneck & Urva 2024, DOI
 *        10.1002/psp4.13099) confirms a two-compartment structure
 *        as the high-fidelity model. Importing it into HealthLog
 *        would invite users to read off **numeric** plasma
 *        concentrations — and numeric concentrations cross the EU
 *        MDR Class I "predict / advise" threshold (research §11,
 *        §12.4) that HealthLog is engineered to stay decisively
 *        below.
 *
 *     2. The one-compartment closed form is sufficient to surface
 *        a qualitative phase label (the chip only needs to know
 *        whether C(t) is climbing, peaking, or decaying). The
 *        sawtooth shape of the superimposed multi-dose curve is
 *        also adequate for the research-view AreaChart, which
 *        deliberately hides the y-axis tick labels and frames the
 *        line as "Estimated level (relative)" — never "plasma
 *        concentration", never with a unit (research §2.3).
 *
 *   If a future maintainer needs the two-compartment model
 *   (deferred to v1.5 / R8 per research §12.2), it must ship
 *   alongside (a) the v1.5 medical-device review, (b) a renewed
 *   Coach refusal-layer audit, and (c) an explicit Marc-direct
 *   decision to keep the y-axis unit-less. Do NOT add it as a
 *   silent refactor of this file.
 *
 * REGULATORY RATIONALE for the one-compartment fallback (research §2.6):
 *
 *   §2.6 records the cross-check against psp4.13099 verbatim:
 *
 *     "One-compartment for the qualitative phase chip; two-compartment
 *      for the curve, matching the journal-of-record and the
 *      Mounjaro Simulator."
 *
 *   This file ships the first half of that sentence. The second
 *   half waits for v1.5.
 *
 * Per-drug constants live in the catalog (`glp1-knowledge.ts`); this
 * module reads them, never re-publishes them. The catalog cites the
 * EMA EPAR PDF per record + the psp4.13099 paper for tirzepatide.
 * All numeric values are PUBLIC regulatory reference values; no
 * licence entanglement.
 *
 * PURITY — this module has zero I/O. No Prisma. No fetch. No
 * `Date.now()`. Every function accepts an explicit `asOf` Date so
 * callers can render deterministic charts and tests can replay the
 * same dose history at any reference time.
 */

import {
  GLP1_DRUGS,
  type Glp1DrugId,
} from "@/lib/medications/glp1-knowledge";

/**
 * Version stamp of the MDR-disclaimer copy that the Research Mode
 * dialog displays. The API endpoint at
 * `/api/auth/me/research-mode` records this exact string on the
 * user row at acknowledgment time; the Settings UI re-prompts the
 * user when the persisted value drifts behind this constant.
 *
 * Format: `YYYY-MM-DD.N` — date the copy was finalised, plus a
 * single-digit counter so two updates on the same day stay
 * distinct.
 *
 * BUMP THIS STRING when:
 *   - the disclaimer wording changes (any user-facing text edit),
 *   - a new drug joins the catalog (the disclaimer enumerates them),
 *   - the EMA EPAR cited as source changes version.
 *
 * Do NOT change it silently for cosmetic edits — every bump forces
 * every user to re-acknowledge on next chart open, which is the
 * desired behaviour but also visible friction.
 */
export const RESEARCH_MODE_DISCLAIMER_VERSION = "2026-05-14.1";

/**
 * A logged GLP-1 intake event reduced to the two fields the PK
 * math actually needs. The caller adapts from the project's richer
 * `MedicationIntakeEvent` row — keeping the input minimal makes the
 * module easy to test and avoids accidentally pulling Prisma types
 * into a pure module.
 */
export type DoseEvent = {
  /** When the dose was administered. */
  takenAt: Date;
  /** Dose in milligrams (matches `MedicationIntakeEvent.dosage`
   *  semantics for the GLP-1 surface — pure mg, no unit conversion
   *  inside this module). */
  doseMg: number;
};

/**
 * A single sample of the simulated concentration curve.
 *
 *   tHours       — hours since `asOf` minus a fixed look-back window
 *                  (negative for past samples, positive for future).
 *   concentration — unit-less qualitative estimate. The number has
 *                   no clinical meaning on its own; it is only useful
 *                   when plotted as a series so users see the
 *                   sawtooth rising/falling shape (research §2.3
 *                   on y-axis labelling).
 */
export type PkSample = {
  tHours: number;
  concentration: number;
};

/**
 * Options for `computeOneCompartment`.
 *
 *   asOf       — reference "now" the chart is anchored to. The
 *                returned samples are spaced around this point.
 *   windowHoursBefore — how far back to start sampling, hours
 *                       (default = 14 × 24 = two weeks of history).
 *   windowHoursAfter  — how far forward to project, hours
 *                       (default = 7 × 24 = one week ahead).
 *   stepHours        — sample spacing (default 6 h — a finer grid
 *                      buys nothing for a chart whose y-axis is
 *                      unit-less and whose x-axis is weeks).
 */
export type OneCompartmentOptions = {
  windowHoursBefore?: number;
  windowHoursAfter?: number;
  stepHours?: number;
};

const DEFAULT_WINDOW_HOURS_BEFORE = 14 * 24;
const DEFAULT_WINDOW_HOURS_AFTER = 7 * 24;
const DEFAULT_STEP_HOURS = 6;
const HOURS_PER_DAY = 24;
const LN_2 = Math.log(2);

/**
 * Resolve the absorption rate constant `Ka` for a drug record.
 *
 * Where the EMA EPAR publishes a pop-PK Ka estimate (today: only
 * tirzepatide via psp4.13099 Table 3), the catalog carries the
 * number verbatim. For drugs where EMA only publishes a terminal
 * half-life and a Tmax, we derive Ka from the rule-of-thumb that
 * `Ka ≈ ln(2) / (Tmax / 3)` for a one-compartment absorption
 * profile — a coarse approximation that is good enough for the
 * qualitative chip + unit-less curve (this module's scope).
 */
function resolveKa(drugId: Glp1DrugId): number {
  const record = GLP1_DRUGS[drugId];
  const publishedKa = record.pharmacology.absorptionRateHourlyKa;
  if (publishedKa != null && publishedKa > 0) {
    return publishedKa;
  }
  // Fallback: a rough Ka estimate from Tmax. The factor of 3 is a
  // standard textbook one-compartment heuristic that places Tmax
  // at roughly Ka^-1 × ln(Ka/Ke); for Ka >> Ke (typical of weekly
  // GLP-1 agonists) this collapses to Tmax ≈ 3/Ka. The chart is
  // qualitative; a 30% error in Ka does not change the
  // rising/peak/fading classification.
  return (3 * LN_2) / Math.max(record.pharmacology.tmaxHours, 1);
}

/**
 * Resolve the elimination rate constant `Ke` from the EMA-published
 * terminal half-life (days → hours).
 */
function resolveKe(drugId: Glp1DrugId): number {
  const halfLifeHours = GLP1_DRUGS[drugId].pharmacology.halfLifeDays * HOURS_PER_DAY;
  // Defensive: catalog values are positive by construction, but
  // guard against accidental zero so the division below never
  // explodes if a future maintainer mis-edits a record.
  return LN_2 / Math.max(halfLifeHours, 1e-6);
}

/**
 * Single-dose Bateman concentration at time `tHours` after dose
 * administration. Returns 0 for `tHours < 0` (no contribution
 * before the dose was injected).
 *
 *   C(t) = (F * D * Ka / (V * (Ka - Ke))) * (exp(-Ke t) - exp(-Ka t))
 *
 * The leading scale factor folds bioavailability `F`, dose `D`,
 * absorption rate `Ka`, and volume of distribution `V`. The
 * chart's y-axis is unit-less by design (research §2.3), but the
 * relative magnitudes across doses still need the scale factor so
 * a 5 mg dose looks taller than a 2.5 mg dose.
 *
 * NaN/edge case handling — when `Ka === Ke` the closed form
 * diverges; we fall back to the L'Hôpital limit
 * `C(t) = (F * D * Ka / V) * t * exp(-Ka t)`. This branch is
 * unlikely to fire on real EMA values (Ka and Ke differ by orders
 * of magnitude for every approved GLP-1) but keeps the function
 * total.
 */
function singleDoseConcentration(
  drugId: Glp1DrugId,
  doseMg: number,
  tHours: number,
): number {
  if (!(tHours > 0)) return 0;
  const record = GLP1_DRUGS[drugId];
  const ka = resolveKa(drugId);
  const ke = resolveKe(drugId);
  const f = record.pharmacology.bioavailability;
  // `vdLitersPerKg` is per-kg; the chart is qualitative so a 70 kg
  // reference is fine — using the user's actual weight would be a
  // *correction* worth doing in v1.5 when individual numeric
  // concentrations are surfaced (which W19c deliberately doesn't).
  const referenceWeightKg = 70;
  const v = record.pharmacology.vdLitersPerKg * referenceWeightKg;
  if (!(v > 0)) return 0;

  if (Math.abs(ka - ke) < 1e-9) {
    return ((f * doseMg * ka) / v) * tHours * Math.exp(-ka * tHours);
  }

  const scale = (f * doseMg * ka) / (v * (ka - ke));
  return scale * (Math.exp(-ke * tHours) - Math.exp(-ka * tHours));
}

/**
 * Sample the one-compartment Bateman curve for a series of doses,
 * by linear superposition of single-dose contributions. Returns
 * one `PkSample` per step across the requested window.
 *
 * The math is intentionally simple — every clinical-decision-support
 * boundary research §11 + §12.4 lists is held back from this
 * function: no projection of when the next dose will peak, no
 * "should you escalate" inference, no individual prediction
 * (the y-axis is unit-less). The caller (W19c-Frontend) renders
 * the returned samples as a Recharts AreaChart with hidden y-axis
 * ticks, exactly as research §2.4 sketches.
 *
 * @param drug   Drug id from the catalog.
 * @param doses  Past + scheduled doses. Order does not matter;
 *               doses outside the sampling window contribute 0
 *               after enough half-lives.
 * @param asOf   Reference "now" the window is anchored to.
 * @param opts   Window + step overrides; defaults render a
 *               two-weeks-back / one-week-ahead chart at 6 h
 *               resolution.
 */
export function computeOneCompartment(
  drug: Glp1DrugId,
  doses: readonly DoseEvent[],
  asOf: Date,
  opts: OneCompartmentOptions = {},
): PkSample[] {
  const windowBefore = opts.windowHoursBefore ?? DEFAULT_WINDOW_HOURS_BEFORE;
  const windowAfter = opts.windowHoursAfter ?? DEFAULT_WINDOW_HOURS_AFTER;
  const step = Math.max(opts.stepHours ?? DEFAULT_STEP_HOURS, 0.25);

  const asOfMs = asOf.getTime();
  // Pre-compute dose offsets in hours relative to `asOf` so the
  // inner loop is pure arithmetic. A negative offset means the
  // dose was taken before `asOf`; positive offsets (scheduled
  // future doses) are honoured — the curve climbs after them.
  const doseOffsetsHours = doses.map((d) => ({
    offsetHours: (d.takenAt.getTime() - asOfMs) / (1000 * 60 * 60),
    doseMg: d.doseMg,
  }));

  const samples: PkSample[] = [];
  for (let t = -windowBefore; t <= windowAfter; t += step) {
    let total = 0;
    for (const dose of doseOffsetsHours) {
      // Single-dose helper returns 0 for negative elapsed time,
      // i.e. "the dose hasn't been taken yet at sample time t".
      total += singleDoseConcentration(drug, dose.doseMg, t - dose.offsetHours);
    }
    samples.push({ tHours: t, concentration: total });
  }
  return samples;
}

/**
 * Convenience wrapper — qualitative phase label for a single
 * timepoint. Surfaces the "shot phase" chip on the GLP-1 tile
 * (research §2.4) without exposing any numeric concentration.
 *
 *   "rising"  — concentration is climbing toward its next peak.
 *   "peak"    — within ±10% of the local maximum.
 *   "fading"  — concentration is decaying after the last peak.
 *   "none"    — no contributing doses inside the look-back window
 *               (e.g. user just started; chart cannot infer phase).
 */
export type ShotPhase = "rising" | "peak" | "fading" | "none";

export function shotPhaseAt(
  drug: Glp1DrugId,
  doses: readonly DoseEvent[],
  asOf: Date,
): ShotPhase {
  if (doses.length === 0) return "none";
  // Sample three points around `asOf` so we can read the local
  // gradient without re-implementing the math. The 3 h spacing
  // matches the chip's intended granularity (a chip that flickered
  // hour-to-hour would feel unstable).
  const probeStepHours = 3;
  const samples = computeOneCompartment(drug, doses, asOf, {
    windowHoursBefore: probeStepHours,
    windowHoursAfter: probeStepHours,
    stepHours: probeStepHours,
  });
  if (samples.length < 3) return "none";
  const [before, here, after] = samples;
  if (!(here.concentration > 0)) return "none";

  // "peak" requires the local gradient to be near-flat AND the
  // current value to be at the local maximum of the 3-sample
  // probe window. A 2 % tolerance on the gradient classifies the
  // slow-decay tail of weekly agents (Tirzepatide t½ ≈ 5 d) as
  // "fading" rather than "peak" — at 10 days post-dose the
  // concentration falls only ~3 % across a 6 h probe window,
  // which an over-generous threshold would miscall.
  const peakWindow = Math.max(before.concentration, after.concentration);
  const flatGradient =
    Math.abs(after.concentration - before.concentration) <
    peakWindow * 0.02;
  if (flatGradient && here.concentration >= peakWindow * 0.99) {
    return "peak";
  }
  return after.concentration > before.concentration ? "rising" : "fading";
}
