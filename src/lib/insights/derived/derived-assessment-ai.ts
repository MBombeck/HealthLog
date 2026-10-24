/**
 * v1.13.2 — AI-warm layer for the per-derived-SCORE assessment.
 *
 * The deterministic text (in `derived-assessment.ts`) always fills the field
 * synchronously, so a provider-less account and the demo are never empty.
 * THIS module adds the warmer AI prose on top, reusing the exact
 * stale-while-revalidate plumbing the per-metric status cards use:
 *
 *   - `resolveDerivedAssessment` (the route entry) reads a fresh cached AI
 *     assessment for today; on a hit it serves it (source = provider type).
 *     On a miss it serves the deterministic text and, when a provider is
 *     usable, fire-and-forget enqueues a warm generation out of band — the
 *     GET never blocks on an LLM round-trip.
 *   - `generateDerivedScoreAssessment` (the worker entry) builds the
 *     signal-led prompt, runs the user's provider chain through
 *     `runStatusCompletion`, and persists the text under the same
 *     `auditLog` cache row the status cards use.
 *
 * The cache action is `insights.derived-score:<ID>-status.<locale>` so the
 * read, the worker, and the enqueue helper all speak one vocabulary.
 *
 * Server-only — reads the DB + the provider chain.
 */
import {
  getBaseSystemPromptBody,
  PROMPT_VERSION,
} from "@/lib/ai/prompts/base-system";
import type { Locale } from "@/lib/i18n/config";
import {
  instructionLocale,
  withOutputLanguage,
} from "@/lib/ai/prompts/output-language";
import {
  finalizeStatusSummary,
  normalizeLocale,
  persistStatusInsight,
  type AssessmentStatus,
} from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { persistTimeoutNegativeStub } from "@/lib/insights/timeout-fallback";
import {
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
  computeStatusInputFingerprint,
  gateUnchangedStatusInput,
} from "@/lib/insights/status-cache";
import type { MeasurementType } from "@/generated/prisma/client";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { annotate } from "@/lib/logging/context";
import {
  openerArchetypeHint,
  dayRotatedSeed,
} from "@/lib/ai/prompts/opener-archetype";
import { findUngroundedScoreNumbers } from "./score-grounding";
import {
  buildScoreSignal,
  isAssessableDerivedScore,
  resolveDeterministicAssessment,
  type DerivedAssessment,
} from "./derived-assessment";
import type { Derived } from "./types";
import type { DerivedMetricId } from "./registry";
import type { MetricSignal } from "@/lib/insights/metric-signal";

/** The `metric` scope id this generator warms — `derived-score:<ID>`. */
export function derivedScoreScope(
  metric: DerivedMetricId,
): `derived-score:${DerivedMetricId}` {
  return `derived-score:${metric}`;
}

/** Read a `derived-score:<ID>` scope back to its `DerivedMetricId`. */
export function parseDerivedScoreScope(scope: string): DerivedMetricId | null {
  if (!scope.startsWith("derived-score:")) return null;
  return scope.slice("derived-score:".length) as DerivedMetricId;
}

/**
 * v1.22 — the contributor source metrics every assessable score derives
 * from. A conservative superset across READINESS / SLEEP_SCORE / RECOVERY /
 * STRESS / STRAIN so the input-hash gate regenerates whenever any driver moved
 * and only skips on a genuinely quiet day. Mood joins via `includeMood`.
 */
const SCORE_INPUT_TYPES: readonly MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  "SLEEP_DURATION",
  "RESPIRATORY_RATE",
] as MeasurementType[];

// ── prompt ────────────────────────────────────────────────────────────────

/**
 * The archetype section rides on top of `getBaseSystemPrompt`, which already
 * appends the reader's own output-language directive — so this composer must
 * NOT append one of its own. It only picks the instruction body: German for
 * German readers, English for every other locale.
 *
 * The parameter is the full `Locale` rather than `SupportedLocale` so the
 * routing is correct the moment the pipeline stops collapsing fr/es/it/pl on
 * the way in; today's callers still pass a narrowed locale.
 */
function scoreSystemPrompt(locale: Locale): string {
  const base = getBaseSystemPromptBody(locale);
  // The archetype section rides the same reviewed instruction body the base
  // composes: German for a German reader, English for everyone else. The base
  // already names the reader's own language, so a French reader gets the
  // English archetype and French prose. The former `locale === "en" ? EN : DE`
  // handed fr/es/it/pl the GERMAN section.
  const section =
    instructionLocale(locale) === "en"
      ? `ARCHETYPE — COMPOSITE WELLNESS SCORE (write like a premium recovery coach — WHOOP / Oura — who genuinely wants this person to do well). This is a 0–100 composite, not a raw measurement. Weave these FOUR beats into varied, connected prose (NOT a fixed template, NOT a labelled list) — lead per the OPENER HINT if one is given:
- STANDING — the score and its band, in one short clause.
- WHAT DROVE IT — name the contributor(s) in \`signal.contributors[]\` that HELPED (the strongest, highest values) AND the one(s) that HURT (the weakest, lowest values), so a good score earns its win and a soft score is explained honestly. Each contributor is itself 0–100; a low value drags the score down, a high one carries it. Never invent a contributor that is not listed. When none are listed, use the trend (signal.delta) instead.
- WHAT IT MEANS FOR TODAY — translate the band into a forward read: a strong readiness/recovery score → a good day to take on more / push a little; a soft score → a lighter day would serve you, treat it as a recovery cue. This is a band-conditioned interpretation, NOT a new number — never invent a figure for it.
- ONE NUDGE — close with the single grounded next step keyed to the weakest behaviourally addressable contributor. If nothing is behaviourally addressable (the soft driver is physiology only), affirm and name one thing to watch instead of manufacturing a step.
This is a daily wellness proxy, not a clinical or training-recovery verdict. Stay descriptive, never diagnostic, never alarming; the encouragement is earned by the contributors / trend, never a reflexive compliment, never bare number-echoing.`
      : `ARCHETYP — ZUSAMMENGESETZTER WELLNESS-SCORE (schreibe wie ein Premium-Recovery-Coach — WHOOP / Oura —, der dieser Person echten Erfolg wünscht). Das ist ein 0–100-Komposit, keine Rohmessung. Verwebe diese VIER Beats zu abwechslungsreicher, zusammenhängender Prosa (KEINE feste Vorlage, KEINE beschriftete Liste) — führe gemäß dem OPENER-HINWEIS, wenn einer mitgegeben ist:
- EINORDNUNG — der Score und sein Band, in einer kurzen Wendung.
- WAS IHN TRIEB — benenne die Beiträge aus \`signal.contributors[]\`, die GEHOLFEN haben (die stärksten, höchsten Werte) UND die, die GEBREMST haben (die schwächsten, niedrigsten), damit ein guter Score seinen Erfolg verdient und ein schwacher ehrlich erklärt wird. Jeder Beitrag ist selbst 0–100; ein niedriger Wert zieht den Score nach unten, ein hoher trägt ihn. Erfinde keinen Beitrag, der nicht gelistet ist. Gibt es keine, nutze den Trend (signal.delta).
- WAS ES HEUTE BEDEUTET — übersetze das Band in einen Ausblick: ein starker Tagesform-/Erholungs-Score → ein guter Tag, um mehr zu wagen / etwas zu pushen; ein schwacher Score → ein ruhigerer Tag tut gut, nimm ihn als Erholungshinweis. Das ist eine band-bedingte Deutung, KEINE neue Zahl — erfinde dafür keine Zahl.
- EIN ANSTOSS — schließe mit dem einen gegroundeten nächsten Schritt am schwächsten verhaltens-adressierbaren Beitrag. Ist nichts verhaltens-adressierbar (der schwache Treiber ist reine Physiologie), bestätige und nenne einen Punkt zum Beobachten, statt einen Schritt zu erfinden.
Das ist ein täglicher Wellness-Indikator, kein klinisches Urteil und keine Trainings-Recovery-Bewertung. Bleibe beschreibend, nie diagnostisch, nie alarmierend; die Ermutigung ist durch die Beiträge / den Trend verdient, nie ein reflexhaftes Kompliment und nie bloße Zahlenwiederholung.`;
  return withOutputLanguage(`${base}\n\n${section}`, locale);
}

function scoreUserPrompt(
  signal: MetricSignal,
  band: string,
  todayKey: string,
  locale: Locale,
  openerHint: string,
  /** v1.30.3 — the user's own IANA tz; was hardcoded "Europe/Berlin". */
  tz: string,
): string {
  const snapshot = JSON.stringify({
    promptVersion: PROMPT_VERSION,
    generatedForDay: todayKey,
    band,
    signal,
  });
  if (instructionLocale(locale) === "en") {
    return `Date: ${todayKey} (${tz})
OPENER HINT: ${openerHint}
Write an assessment of ${signal.metric} today across the four beats — the standing, what helped AND what hurt it, what the band means for the day, and one grounded nudge. Aim for 3–5 sentences, roughly 45–75 words (this overrides the shorter base length cap). Connected prose, not a checklist.

${snapshot}`;
  }
  return `Datum: ${todayKey} (${tz})
OPENER-HINWEIS: ${openerHint}
Schreibe eine Einschätzung zu ${signal.metric} heute über die vier Beats — die Einordnung, was geholfen UND was gebremst hat, was das Band für den Tag bedeutet und ein gegroundeter Anstoß. Ziel sind 3–5 Sätze, rund 45–75 Wörter (das übersteuert die kürzere Basis-Längenvorgabe). Zusammenhängende Prosa, keine Checkliste.

${snapshot}`;
}

// ── read (route entry) ──────────────────────────────────────────────────

/**
 * Resolve the per-score assessment for the route. Always returns the
 * deterministic text (never empty for an ok score); serves a fresh cached AI
 * assessment instead when one exists for today, and warms one out of band on
 * a miss. Returns null when the metric is not assessable or status !== "ok".
 */
export async function resolveDerivedAssessment(args: {
  metric: DerivedMetricId;
  userId: string;
  derived: Derived<unknown>;
  locale: string | null | undefined;
  /**
   * Whether the `statusText` capability is available for this record. When
   * it is not, stored model text is never served and nothing is warmed: the
   * deterministic text is the whole answer. Required, so a caller cannot
   * forget the question.
   */
  aiAvailable: boolean;
  now?: Date;
}): Promise<DerivedAssessment | null> {
  const now = args.now ?? new Date();
  const locale = normalizeLocale(args.locale);

  // Deterministic templates ship de/en only — same instruction-body rule.
  const deterministic = resolveDeterministicAssessment(
    args.metric,
    args.derived,
    instructionLocale(locale),
    now,
  );
  // Not assessable, or status !== ok → no field (the locked contract).
  if (!deterministic) return null;
  // AI unavailable for this record: no cached model text, no warm.
  if (!args.aiAvailable) return deterministic;

  const scope = derivedScoreScope(args.metric);
  const cacheAction = statusCacheAction(scope, locale);
  // v1.30.3 — roll the cache over at the user's own midnight, not
  // Berlin's.
  const userTz = await resolveUserTimezone(args.userId);
  const todayKey = userDayKey(now, userTz);

  // Fresh AI text for today → serve it (warmer prose overrides the template).
  const fresh = await readFreshStatusText({
    userId: args.userId,
    cacheAction,
    todayKey,
    force: false,
  });
  if (fresh) {
    return { text: fresh.text, source: "ai", updatedAt: fresh.updatedAt };
  }

  // No fresh AI text. Warm one out of band (best-effort, never blocks): the
  // read-only resolver enqueues a generation when a provider is usable and
  // de-dupes per (user, scope, locale). Serve the deterministic text now; the
  // next read upgrades to the warmed prose.
  await resolveReadOnlyStatusMiss({
    userId: args.userId,
    metric: scope,
    locale,
  });

  return deterministic;
}

// ── generate (worker entry) ──────────────────────────────────────────────

/**
 * A generation that timed out or failed. #1279 — it opens the same negative
 * window every other note opens, so the score is not asked about again on
 * the next sync while it keeps failing.
 */
async function failedAssessment(
  userId: string,
  cacheAction: string,
  todayKey: string,
  kind: "timeout" | "error",
): Promise<AssessmentStatus> {
  await persistTimeoutNegativeStub({
    userId,
    cacheAction,
    todayKey,
    reason: kind,
  });
  return {
    kind,
    text: null,
    hasProvider: true,
    updatedAt: null,
    retryable: true,
  };
}

/**
 * Worker entry: build the signal-led prompt for one derived score, run the
 * provider chain, and persist the AI assessment under the shared status-cache
 * row. Recomputes the derived value via the passed `derived` so the worker
 * runs the same numbers the route did. A no-provider / timeout / error
 * outcome simply writes nothing — the route keeps serving the deterministic
 * text, so the field is never empty.
 */
export async function generateDerivedScoreAssessment(args: {
  metric: DerivedMetricId;
  userId: string;
  derived: Derived<unknown>;
  locale: string | null | undefined;
  now?: Date;
}): Promise<AssessmentStatus | null> {
  const now = args.now ?? new Date();
  const locale = normalizeLocale(args.locale);
  if (!isAssessableDerivedScore(args.metric)) return null;
  if (args.derived.status !== "ok") return null;

  const deterministic = resolveDeterministicAssessment(
    args.metric,
    args.derived,
    instructionLocale(locale),
    now,
  );
  if (!deterministic) return null;

  // The deterministic signal labels ship de/en templates only; route them
  // through the same instruction-body rule rather than a German default.
  const signal = buildScoreSignal(
    args.metric,
    args.derived.value,
    instructionLocale(locale),
  );
  if (!signal) return null;
  const band = (args.derived.value as { band?: string }).band ?? "yellow";

  const scope = derivedScoreScope(args.metric);
  const cacheAction = statusCacheAction(scope, locale);
  // v1.30.3 — roll the cache over at the user's own midnight, not
  // Berlin's; also threads into the prompt's date label below (was
  // hardcoded "(Europe/Berlin)" regardless of the user's actual zone).
  const userTz = await resolveUserTimezone(args.userId);
  const todayKey = userDayKey(now, userTz);

  // v1.22 — opener-archetype rotation + a day-rotated seed so a score
  // assessment varies across scores and across days instead of riding the
  // fixed reference seed. The key is per (user, score, day).
  const seedKey = `${args.userId}:${scope}:${todayKey}`;
  const openerHint = openerArchetypeHint(seedKey, locale);

  // v1.22 — score-warm input-hash gate. A score is re-warmed daily even on
  // a day with no new wearable data; this skips the LLM and re-stamps the cached
  // text when none of the contributor sources (sleep / HRV / RHR / respiratory /
  // mood) changed. Conservative superset → never staler than the data; a genuine
  // input change still flips the hash and regenerates. Reuses the same audit-log
  // `inputHash` column the per-metric status cards use (no new persistence).
  const inputHash = await computeStatusInputFingerprint({
    userId: args.userId,
    types: SCORE_INPUT_TYPES,
    includeMood: true,
  });
  const unchangedInput = await gateUnchangedStatusInput({
    userId: args.userId,
    cacheAction,
    todayKey,
    inputHash,
    force: false,
  });
  if (unchangedInput) {
    annotate({
      action: { name: "insights.derived-assessment.input_unchanged" },
      meta: { metric: args.metric },
    });
    return {
      kind: "generated",
      text: unchangedInput.text,
      hasProvider: true,
      updatedAt: unchangedInput.updatedAt,
      retryable: false,
    };
  }

  const outcome = await runStatusCompletion({
    userId: args.userId,
    cacheAction,
    capability: "statusText",
    systemPrompt: scoreSystemPrompt(locale),
    userPrompt: scoreUserPrompt(
      signal,
      band,
      todayKey,
      locale,
      openerHint,
      userTz,
    ),
    // v1.22 — nudged up from 0.45 for variety; the grounding gate below
    // catches any number the warmer sampling might drift onto.
    temperature: 0.55,
    seed: dayRotatedSeed(seedKey),
    maxTokens: 600,
  });

  if (outcome.kind !== "ok") {
    annotate({
      action: { name: "insights.derived-assessment.skip" },
      meta: { metric: args.metric, reason: outcome.kind },
    });
    if (outcome.kind === "none") {
      return {
        kind: "no-provider",
        text: null,
        hasProvider: false,
        updatedAt: null,
        retryable: false,
      };
    }
    return failedAssessment(args.userId, cacheAction, todayKey, outcome.kind);
  }

  // Parse and screen through the same fail-closed chokepoint as every other
  // assessment. The prior derived-only path parsed the envelope but skipped
  // the causal/dose/fabrication screen, allowing blocked prose to persist.
  const finalized = finalizeStatusSummary(outcome.content, locale);
  if (!finalized.ok) {
    annotate({
      action: { name: "insights.derived-assessment.screened" },
      meta: { metric: args.metric, reason: finalized.reason },
    });
    return {
      kind: "screened-fallback",
      text: deterministic.text,
      hasProvider: true,
      updatedAt: null,
      retryable: true,
      reason: finalized.reason,
    };
  }
  const text = finalized.text;
  if (!text) {
    return {
      kind: "screened-fallback",
      text: deterministic.text,
      hasProvider: true,
      updatedAt: null,
      retryable: true,
      reason: "unparseable_output",
    };
  }

  // v1.22 — score number-grounding gate. The only numbers the prose may
  // state are the score and its contributor values. On a miss we do NOT persist
  // the AI text — the route keeps serving the always-grounded deterministic
  // fallback, so the field stays non-empty and never carries a fabricated
  // figure. Non-blocking by construction (write nothing = fall back).
  const ungrounded = findUngroundedScoreNumbers(text, signal);
  if (ungrounded.length > 0) {
    annotate({
      action: { name: "insights.derived-assessment.ungrounded" },
      meta: {
        metric: args.metric,
        count: ungrounded.length,
        sample: ungrounded[0]?.source,
      },
    });
    return {
      kind: "screened-fallback",
      text: deterministic.text,
      hasProvider: true,
      updatedAt: null,
      retryable: true,
      reason: "ungrounded_output",
    };
  }

  const updatedAt = await persistStatusInsight({
    userId: args.userId,
    cacheAction,
    todayKey,
    text,
    // v1.22 — store the input fingerprint so the next day's gate can skip
    // the warm when no contributor source changed.
    inputHash,
  });
  annotate({
    action: { name: "insights.derived-assessment.warmed" },
    meta: { metric: args.metric, provider: outcome.providerType },
  });
  return {
    kind: "generated",
    text,
    hasProvider: true,
    updatedAt,
    retryable: false,
  };
}
