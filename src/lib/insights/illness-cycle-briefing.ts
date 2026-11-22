/**
 * v1.18.11 — illness + cycle context for the daily briefing.
 *
 * The briefing used to narrate as if nothing were going on even when the user
 * is mid-illness-episode or mid-cycle, because — unlike the Coach — it never
 * pulled those states into its prompt. This module reuses the SAME server-
 * authoritative builders the Coach snapshot assembles (`buildIllnessSnapshotBlock`,
 * `buildCycleSnapshotBlock`) and folds the result into the insight-generator
 * prompt as a SYSTEM CONTEXT block — the same append mechanism the GLP-1 plateau
 * and derived-signal detectors use.
 *
 * Both blocks are module-gated: the illness builder short-circuits to null for a
 * non-illness / opted-out account, and the cycle block is additionally gated on
 * the fully-resolved cycle module. A user with neither pays zero token cost and
 * the briefing prompt is byte-for-byte unchanged. CONTEXT only — labels +
 * lifecycle + dates + phase; no decrypted notes, no fabricated numbers.
 *
 * Server-only.
 */
import {
  buildIllnessSnapshotBlock,
  type CoachIllnessBlock,
} from "@/lib/ai/coach/illness-snapshot";
import {
  buildCycleSnapshotBlock,
  type CycleSnapshotBlock,
} from "@/lib/ai/coach/cycle-snapshot";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { pregnancyContextPromptBlock } from "@/lib/ai/pregnancy-context";
import type { Locale } from "@/lib/i18n/config";

export interface BriefingIllnessCycleContext {
  illness: CoachIllnessBlock | null;
  cycle: CycleSnapshotBlock | null;
}

/**
 * Assemble the illness + cycle context for the briefing, or `null` when neither
 * module surfaces anything. Reuses the Coach builders verbatim so the briefing
 * never disagrees with the Coach about the user's current state.
 */
export async function buildBriefingIllnessCycleContext(
  userId: string,
  gender: string | null | undefined,
  timezone: string | null | undefined,
  now: Date = new Date(),
): Promise<BriefingIllnessCycleContext | null> {
  const cycleEnabled = await isCycleAvailableForUser(userId);
  const [illness, cycle] = await Promise.all([
    // Module-gated internally — short-circuits to null for a non-illness account.
    buildIllnessSnapshotBlock(userId, now),
    cycleEnabled
      ? buildCycleSnapshotBlock(userId, gender, now, timezone)
      : Promise.resolve(null),
  ]);

  if (!illness && !cycle) return null;
  return { illness, cycle };
}

/**
 * Build the SYSTEM CONTEXT block appended to the briefing user prompt. Mirrors
 * the derived-briefing / GLP-1 plateau append mechanism. DE + EN bodies; other
 * locales fall through to EN (the same chain the message bundles use).
 *
 * Returns the empty string when there is nothing to say, so the caller can
 * append unconditionally.
 */
export function buildBriefingIllnessCyclePrompt(
  ctx: BriefingIllnessCycleContext,
  locale: Locale,
): string {
  const de = locale === "de";
  const lines: string[] = [];

  if (ctx.illness) {
    if (ctx.illness.restMode && ctx.illness.active.length > 0) {
      const labels = ctx.illness.active
        .map((e) => `${e.label} (${e.type}, ${e.lifecycle})`)
        .join("; ");
      lines.push(
        de
          ? `- Aktive Erkrankung(en) gerade: ${labels}. Der Nutzer ist im Rest Mode — lies abweichende Vitalwerte oder eine niedrige Erholung als krankheitsbedingt, nicht alarmierend, und dränge NICHT auf häufigeres Messen.`
          : `- Active illness episode(s) right now: ${labels}. The user is in Rest Mode — read off-band vitals or low recovery as illness-explained rather than alarming, and do NOT push a "measure more often" cadence.`,
      );
    } else if (ctx.illness.active.length > 0) {
      // Chronic ongoing conditions only: context for a measured dip, but not
      // Rest Mode, so no cadence pause and no "unwell" framing (#1216).
      const labels = ctx.illness.active
        .map((e) => `${e.label} (${e.type}, ${e.lifecycle})`)
        .join("; ");
      lines.push(
        de
          ? `- Bekannte chronische Erkrankung(en): ${labels}. Ein abweichender Vitalwert kann damit zusammenhängen; das ist Kontext, kein akutes Kranksein und kein Rest Mode.`
          : `- Known chronic condition(s): ${labels}. An off-band vital may relate to them; this is context, not an acute illness and not Rest Mode.`,
      );
    } else if (ctx.illness.recentResolved.length > 0) {
      lines.push(
        de
          ? `- Keine aktive Erkrankung; zuletzt aufgelöst: ${ctx.illness.recentResolved[0].label}.`
          : `- No active illness; most recently resolved: ${ctx.illness.recentResolved[0].label}.`,
      );
    }
  }

  if (ctx.cycle) {
    const c = ctx.cycle;
    if (c.phase && c.dayOfCycle !== null) {
      lines.push(
        de
          ? `- Zyklus: Tag ${c.dayOfCycle}, ${c.phase}-Phase. Beschreibend, nie als Ursache; keine Verhütungs- oder "sichere Tage"-Aussagen.`
          : `- Cycle: day ${c.dayOfCycle}, ${c.phase} phase. Descriptive only, never causal; no contraception / "safe day" claims.`,
      );
    }
    if (c.phaseInsight) {
      lines.push(
        de
          ? `- ${c.phaseInsight.interpretation}`
          : `- ${c.phaseInsight.interpretation}`,
      );
    }
  }

  // A pregnancy or the weeks after a birth: the same rule every model
  // surface carries (`pregnancy-context.ts`), from the cycle block's state.
  const pregnancy = ctx.cycle?.pregnancy
    ? pregnancyContextPromptBlock(ctx.cycle.pregnancy, de ? "de" : "en")
    : "";

  if (lines.length === 0) return pregnancy;

  const body = lines.join("\n");
  return (
    (de
      ? `

SYSTEM CONTEXT — GESUNDHEITSZUSTAND (KRANKHEIT / ZYKLUS)

Die App hat folgenden aktuellen Kontext aus den eigenen Daten des Nutzers ermittelt (beschreibend, keine Diagnose):
${body}

Berücksichtige diesen Kontext im dailyBriefing-Ton; erfinde KEINE Zahlen und stelle KEINE medizinische Ursache her.`
      : `

SYSTEM CONTEXT — HEALTH STATE (ILLNESS / CYCLE)

The app derived this current context from the user's own data (descriptive, not a diagnosis):
${body}

Factor this context into the dailyBriefing tone; do NOT invent numbers and do NOT attribute a medical cause.`) +
    pregnancy
  );
}
