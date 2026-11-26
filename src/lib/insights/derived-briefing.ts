/**
 * v1.10.0 — derived-signal context for the daily briefing.
 *
 * Picks the most relevant 1–2 derived wellness signals (a notable
 * readiness / recovery shift) and folds them into the insight-generator
 * prompt as a SYSTEM CONTEXT block — the same mechanism the GLP-1 plateau
 * detector uses. Gated on confidence: a signal only surfaces when its
 * derived value is `ok` AND its confidence band is `high` or `medium`, so
 * the briefing never narrates a shaky few-day number.
 *
 * Reads the one `computeDerivedMetric` contract — no recompute. Returns
 * `null` (the common case) when nothing notable crosses the gate, so the
 * generate route pays zero token cost for users with no derived signal.
 *
 * 1.50: a readiness that is not `fresh` rests on an earlier day and is no
 * statement about today, so it is not offered. Recovery follows the one
 * proxy rule (`isProxyRecovery`): the computed proxy is HealthLog's own
 * readiness blend and is never offered as a second signal; a device's
 * recovery is offered under the device's own name.
 *
 * Server-only.
 */
import {
  computeDerivedMetric,
  isDerivedOk,
  type BaselineProfile,
} from "@/lib/insights/derived";
import type { Locale } from "@/lib/i18n/config";
import { prisma } from "@/lib/db";
import {
  isProxyRecovery,
  readCurrentCanonicalRecovery,
} from "@/lib/insights/derived/recovery-resolve";
import { recoverySourceLabelEn } from "@/lib/scores/registry";

/** One derived signal worth a sentence in the briefing. */
export interface DerivedBriefingSignal {
  /** Sentinel id the model echoes into `sourceMetric` (e.g. "readiness"). */
  sourceMetric: string;
  /** Human label ("readiness", "WHOOP Recovery (device score)"). */
  label: string;
  /** Latest 0–100 score. */
  score: number;
  /** Band ("green" / "yellow" / "red"). */
  band: string;
  /** Confidence 0–100. */
  confidence: number;
}

export interface DerivedBriefingContext {
  signals: DerivedBriefingSignal[];
}

/** The notable-signal candidates, in priority order. */
const CANDIDATES: Array<{
  metric: "READINESS" | "RECOVERY_SCORE";
  sourceMetric: string;
  label: string;
}> = [
  { metric: "READINESS", sourceMetric: "readiness", label: "readiness" },
  { metric: "RECOVERY_SCORE", sourceMetric: "recovery", label: "recovery" },
];

/** Confidence floor — only `high`/`medium` bands surface in the briefing. */
const CONFIDENCE_FLOOR = 50;
/** A signal is notable when it sits outside the comfortable green band. */
function isNotable(band: string, confidence: number): boolean {
  return (
    confidence >= CONFIDENCE_FLOOR && (band === "yellow" || band === "red")
  );
}

/**
 * Detect the 1–2 most relevant derived signals for the briefing, or `null`
 * when nothing crosses the confidence + notability gate. Computes the
 * candidates off the one shared profile (no per-metric profile re-read).
 */
export async function detectDerivedBriefingSignals(
  userId: string,
  profile: BaselineProfile,
  now: Date = new Date(),
): Promise<DerivedBriefingContext | null> {
  const signals: DerivedBriefingSignal[] = [];

  for (const cand of CANDIDATES) {
    let derived;
    try {
      derived = await computeDerivedMetric({
        metric: cand.metric,
        userId,
        profile,
        now,
      });
    } catch {
      continue;
    }
    if (!isDerivedOk(derived)) continue;
    const v = derived.value as {
      score?: number;
      band?: string;
      fresh?: boolean;
    };
    if (typeof v.score !== "number" || typeof v.band !== "string") continue;
    // An old blend says nothing about today.
    if (cand.metric === "READINESS" && v.fresh !== true) continue;
    if (!isNotable(v.band, derived.confidence.score)) continue;
    let label = cand.label;
    if (cand.metric === "RECOVERY_SCORE") {
      const current = await readCurrentCanonicalRecovery(
        prisma,
        userId,
        now,
      ).catch(() => null);
      // The proxy is HealthLog's readiness blend, not a second signal.
      if (current === null || isProxyRecovery(current)) continue;
      label = `${recoverySourceLabelEn(current.source)} (device score)`;
    }
    signals.push({
      sourceMetric: cand.sourceMetric,
      label,
      score: v.score,
      band: v.band,
      confidence: derived.confidence.score,
    });
    if (signals.length >= 2) break;
  }

  return signals.length > 0 ? { signals } : null;
}

/**
 * Build the SYSTEM CONTEXT block appended to the user prompt. Mirrors the
 * GLP-1 plateau detector's append mechanism. DE + EN bodies; other locales
 * fall through to EN (the same chain the message bundles use).
 */
export function buildDerivedBriefingPrompt(
  ctx: DerivedBriefingContext,
  locale: Locale,
): string {
  const lines = ctx.signals
    .map(
      (s) =>
        `- ${s.label}: ${s.score}/100 (${s.band} band, confidence ${s.confidence})`,
    )
    .join("\n");
  const sentinels = ctx.signals.map((s) => `"${s.sourceMetric}"`).join(" / ");

  if (locale === "de") {
    return `

SYSTEM CONTEXT — ABGELEITETE WELLNESS-SIGNALE

Die App hat folgende abgeleitete Wellness-Werte berechnet (beschreibend, keine klinische Beurteilung):
${lines}

Wenn du einen dailyBriefing-keyFinding zu einem dieser Signale emittierst:
- sourceMetric: ${sentinels}
- tone: "info" (gelb) bzw. "watch" (rot)
- Rahmen es als beobachtetes Muster aus den eigenen Daten des Nutzers, keine Diagnose
- nenne den Wert und das Band; verweise NICHT auf eine medizinische Ursache
- KEINE Empfehlung zu Medikamenten oder Dosierung`;
  }

  return `

SYSTEM CONTEXT — DERIVED WELLNESS SIGNALS

The app computed these derived wellness scores (descriptive, not a clinical assessment):
${lines}

If you emit a dailyBriefing keyFinding for one of these signals:
- sourceMetric: ${sentinels}
- tone: "info" (yellow) or "watch" (red)
- frame as an observed pattern from the user's own data, never a diagnosis
- state the value and the band; do NOT attribute it to a medical cause
- NEVER recommend a medication or dose change`;
}
