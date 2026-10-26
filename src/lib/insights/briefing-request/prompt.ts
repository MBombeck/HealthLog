/**
 * The on-demand briefing's prompt: the feature snapshot, and every
 * SYSTEM CONTEXT block that rides on it.
 */
import { metricsFromPresentSections } from "@/lib/ai/medical-references";
import {
  buildAboutMeInsightBlock,
  getSelfContextTextForUser,
} from "@/lib/ai/coach/about-me";
import { buildBriefingPersonalisationBlock } from "@/lib/ai/prompts/insight-generator";
import { buildUserPrompt } from "@/lib/ai/prompts/insight-system-prompt";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import {
  briefingFormForRecord,
  buildBriefingShortFormBlock,
} from "@/lib/insights/briefing-short-form";
import { buildComparisonSnapshotForUser } from "@/lib/insights/comprehensive-generate";
import {
  buildDerivedBriefingPrompt,
  detectDerivedBriefingSignals,
} from "@/lib/insights/derived-briefing";
import {
  buildGlp1PlateauPrompt,
  detectGlp1Plateau,
} from "@/lib/insights/glp1-plateau";
import {
  buildBriefingIllnessCycleContext,
  buildBriefingIllnessCyclePrompt,
} from "@/lib/insights/illness-cycle-briefing";
import { toProfileSex } from "@/lib/profile/sex";
import { resolveUserTimezone } from "@/lib/tz/resolver";

import type { GenerationContext } from "./context";
import type { PreparedFeatures } from "./features";

export type BriefingPrompt = Awaited<ReturnType<typeof buildBriefingPrompt>>;

export async function buildBriefingPrompt(
  ctx: GenerationContext,
  prepared: PreparedFeatures,
) {
  const { userId, dbUser, locale } = ctx;
  const { features, featuresJson, units } = prepared;
  // The persisted comparison toggle: when active, a compact prior-period
  // snapshot built from the `features` summaries that already include
  // `avg30LastMonth` / `avg30LastYear`. The narrative is default-on whenever
  // the toggle is on — the pulldown is the single affordance.
  const comparisonSnapshot = await buildComparisonSnapshotForUser(userId);
  // GLP-1 plateau detector: a SYSTEM CONTEXT block when the active GLP-1
  // medication has been on a stable dose for ≥21 days with the weight delta
  // within ±0.5 kg, asking for an observational glp1_plateau keyFinding (no
  // dose recommendation per GROUND RULE 13). Null — the common case — costs
  // no tokens.
  const plateauContext = await detectGlp1Plateau(userId);
  let userPrompt = buildUserPrompt(
    featuresJson,
    dbUser?.insightsPrivacyMode ?? "aggregated",
    locale,
    comparisonSnapshot ?? undefined,
  );
  if (plateauContext) {
    userPrompt += buildGlp1PlateauPrompt(plateauContext, locale, units.system);
  }
  // The user-authored "about me" self-description (Settings → AI), as a
  // delimited, user-provided SYSTEM CONTEXT block. Null (no text /
  // undecryptable) costs nothing.
  const aboutMe = await getSelfContextTextForUser(userId, locale);
  if (aboutMe) {
    userPrompt += buildAboutMeInsightBlock(aboutMe, locale);
  }
  // A notable derived wellness signal (readiness / recovery shift,
  // confidence-gated), read from the one derived contract; null (the common
  // case) costs nothing.
  const derivedSex = toProfileSex(dbUser?.gender);
  const derivedBriefing = await detectDerivedBriefingSignals(userId, {
    ageYears: getAgeFromDateOfBirth(dbUser?.dateOfBirth ?? null),
    sex: derivedSex,
    heightCm: dbUser?.heightCm ?? null,
  });
  if (derivedBriefing) {
    userPrompt += buildDerivedBriefingPrompt(derivedBriefing, locale);
  }

  // Illness-episode + cycle state, so a mid-illness or mid-cycle user gets
  // context-aware prose. The same server-authoritative builders the Coach
  // assembles; both are module-gated and short-circuit to null (zero token
  // cost) for users without them.
  const illnessCycleCtx = await buildBriefingIllnessCycleContext(
    userId,
    dbUser?.gender ?? null,
    await resolveUserTimezone(userId),
  );
  if (illnessCycleCtx) {
    userPrompt += buildBriefingIllnessCyclePrompt(illnessCycleCtx, locale);
  }

  // Opener-archetype rotation + sparse first-name personalization
  // (deterministic per user+day; omitted for unnamed accounts).
  userPrompt += buildBriefingPersonalisationBlock(
    userId,
    dbUser?.displayName ?? null,
    locale,
    await resolveUserTimezone(userId),
  );
  // The short form on the `frugal` usage level; the full contract on every
  // other level (#1217).
  const briefingForm = await briefingFormForRecord(userId);
  userPrompt += buildBriefingShortFormBlock(locale, briefingForm);

  // The curated SOURCES block for the metric sections this briefing
  // actually carries, so a normative claim can cite a real `referenceId` the
  // schema + UI footnote already support. The plain prompt stays unchanged
  // when no applicable metric section is present.
  const referenceMetrics = metricsFromPresentSections({
    bloodPressure: features.bloodPressure != null,
    weight: features.weight != null,
    pulse: features.pulse != null,
    mood: features.mood != null,
    medication: (features.medications?.length ?? 0) > 0,
  });

  return {
    userPrompt,
    comparisonSnapshot,
    aboutMe,
    briefingForm,
    referenceMetrics,
  };
}
