/**
 * v1.11.0 W3 — period-narrative GENERATOR (Pillar P1).
 *
 * A sibling of `generateComprehensiveInsight`: it feeds the W2
 * `buildPeriodNarrativeContext` output — a compact, provenance-carrying
 * `label + number + source` context — into the user's provider chain with a
 * TIGHT, descriptive-never-causal prompt and persists the generated prose in
 * the typed `insight_narratives` table (AES-256-GCM at rest).
 *
 * Honesty floor (inherited verbatim from the W1/W2 layers it consumes):
 *  - The context is the only ground truth. The prompt forbids inventing any
 *    number, trend, driver, or threshold not present in the context.
 *  - Drivers are already BH-FDR survivors with conservative `interpretation`
 *    strings; the narrative may restate them as associations, NEVER as
 *    causes.
 *  - An `insufficient` context (too little history) yields NO narrative — the
 *    generator returns `{ status: "insufficient" }` and writes nothing, so a
 *    sparse account never gets a fabricated story.
 *  - No provider configured → `{ status: "skipped", reason: "no-provider" }`,
 *    no LLM call. A provider timeout / error is non-fatal and writes nothing.
 *
 * Cache + stale-while-revalidate mirror the per-status assessments: a fresh
 * read serves today's row instantly; a regenerate upserts the single
 * (user, period, locale) row in place (delete/regenerate-clean by
 * construction — the unique index forbids duplicates).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { annotate } from "@/lib/logging/context";
import { AI_BUDGETS, REFERENCE_AI_SEED } from "@/lib/ai/ai-budgets";
import { dayRotatedSeed } from "@/lib/ai/prompts/opener-archetype";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import { aiCapabilityToServe } from "@/lib/ai/capabilities/gate";
import {
  buildPeriodNarrativeContext,
  type NarrativePeriod,
  type PeriodNarrativeContext,
} from "@/lib/insights/narrative/period-narrative";
import {
  buildDeterministicNarrative,
  DETERMINISTIC_PROVIDER_TYPE,
} from "@/lib/insights/narrative/period-narrative-deterministic";
import { composeSharedContracts } from "@/lib/ai/prompts/shared-contracts";
import {
  instructionLocale,
  targetLanguageName,
  withOutputLanguage,
} from "@/lib/ai/prompts/output-language";
import type { Locale } from "@/lib/i18n/config";
import {
  validateNarrativeText,
  buildNarrativeCorrection,
} from "@/lib/insights/narrative/narrative-grounding";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * Stable identifier for the narrative prompt revision. Bumped whenever the
 * prompt below changes so the cross-feature attribution aggregator can slice
 * quality per (provider × prompt) and a prompt change is observable.
 *
 * 1.14.0 — output language: French, Spanish, Italian and Polish readers used
 * to fall to the German instruction body (the route narrowed every non-`en`
 * locale to `de`), so they received German retrospectives. They now compose
 * the English body with their language named in an added rule and the
 * locale's own reply-language directive appended last. The German and English
 * prompts are unchanged apart from this version string (test-pinned).
 */
export const NARRATIVE_PROMPT_VERSION = "1.14.0" as const;

/** A narrative cached this recently is served without regenerating. */
const NARRATIVE_FRESH_MS = 20 * 60 * 60 * 1000;

export type NarrativeGenerateOutcome =
  | { status: "cached" }
  | { status: "generated"; providerType: string }
  | { status: "skipped"; reason: "no-provider" }
  | { status: "insufficient" }
  | { status: "failed"; reason: string };

interface GenerateOptions {
  /** Which period to narrate. */
  period: NarrativePeriod;
  /**
   * Resolved UI locale for the prompt + row.
   *
   * The full six-locale union: the row is keyed `(user, period, locale)`, so a
   * French reader's French retrospective is stored under `fr` rather than
   * mislabelled as German or English prose.
   */
  locale: Locale;
  /** Skip the freshness short-circuit and force a fresh generation. */
  force?: boolean;
  /** Injected clock for deterministic tests; defaults to now. */
  now?: Date;
  /** Injected for tests — defaults to the real DB context assembler. */
  buildContext?: typeof buildPeriodNarrativeContext;
  /** Injected for tests — defaults to the real bounded provider call. */
  runCompletion?: typeof runStatusCompletion;
  /** Injected for tests — the shared client by default. */
  prisma?: PrismaClient;
  /**
   * v1.22 (W6) — pin the deterministic `REFERENCE_AI_SEED` instead of the
   * day-rotated production seed. Used ONLY by the cross-feature attribution /
   * diff baseline (and tests) that need byte-stable output; real users generate
   * with a day-rotated seed so weekly / monthly narratives vary run-to-run.
   */
  referenceSeed?: boolean;
}

/** The labels-only provenance the surface renders as ⓘ chips. */
export interface NarrativeProvenancePayload {
  metrics: string[];
  window: { from: string; to: string };
  pairsTested: number;
  fdrQ: number;
  computedAt: string;
}

/** UTC YYYY-MM-DD boundary key for a row, in the user's tz. */
function dateKeyFor(now: Date, tz: string): string {
  const { year, month, day } = wallClockInTz(now, tz);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ── prompt ──────────────────────────────────────────────────────────────

/**
 * Placeholder for the extra output-language rule inside the English body.
 *
 * Empty for `en` (whose body is written in the language it asks for), so the
 * composed English prompt stays byte-stable; for the four locales that ride
 * the English body it renders one more hard rule naming the reader's
 * language. The German body carries no token — it names its language by being
 * written in it.
 */
const LANGUAGE_RULE_TOKEN = "{{LANGUAGE_RULE}}";

function languageRule(locale: Locale): string {
  return locale === "de" || locale === "en"
    ? ""
    : `\n- Write the summary in ${targetLanguageName(locale)}.`;
}

const SYSTEM_PROMPT_EN_TEMPLATE = `You summarise one person's health-tracking PERIOD (a week or a month) for that person.
Prompt version: ${NARRATIVE_PROMPT_VERSION}.

Hard rules:
- The supplied CONTEXT is the ONLY source of truth. Never state a number, trend, driver, or threshold that is not in it.
- Be DESCRIPTIVE, never CAUSAL. Say "X moved with Y" or "X was associated with Y", never "X caused Y" or "because of X".
- The listed drivers already survived statistical multiple-comparison control; restate them only as associations and keep their conservative meaning.
- No diagnosis, no medical advice, no alarm. Calm, factual, second person ("your"). When the period earned it, name one genuine win plainly; keep it warm and second-person, never a reflexive compliment.
- SHAPE: lead with the period's one-line verdict (the overall read in plain words), then connect the top movers and surviving associations into a short arc, and close on continuity or one watch-item — synthesize, do not list each metric in turn.
- 2 to 4 short sentences. Plain text only — no markdown, no headings, no bullet points, no emojis.
- If the context is thin, say plainly that there is little to report this period rather than inventing detail.${LANGUAGE_RULE_TOKEN}

${composeSharedContracts("en", ["toneContract", "grounding", "openingShape", "safetyGlp1", "safetyAcute", "metricIdentifierBan", "forbiddenFiller", "formattingContract"])}`;

const SYSTEM_PROMPT_DE = `Du fasst den Gesundheits-Tracking-ZEITRAUM einer Person (eine Woche oder einen Monat) für diese Person zusammen.
Prompt-Version: ${NARRATIVE_PROMPT_VERSION}.

Feste Regeln:
- Der bereitgestellte KONTEXT ist die EINZIGE Wahrheitsquelle. Nenne nie eine Zahl, einen Trend, einen Zusammenhang oder einen Schwellenwert, der nicht darin steht.
- Sei BESCHREIBEND, nie URSÄCHLICH. Sage "X bewegte sich mit Y" oder "X war mit Y assoziiert", nie "X verursachte Y" oder "wegen X".
- Die genannten Zusammenhänge haben bereits die statistische Mehrfachvergleichskorrektur überstanden; gib sie nur als Assoziationen wieder und bewahre ihre vorsichtige Bedeutung.
- Keine Diagnose, kein medizinischer Rat, keine Panik. Ruhig, sachlich, in der zweiten Person ("dein"). Wenn der Zeitraum es hergibt, benenne einen echten Erfolg klar; bleib warm und in der zweiten Person, nie ein reflexhaftes Kompliment.
- FORM: Führe mit dem Ein-Satz-Urteil des Zeitraums (das Gesamtbild in klaren Worten), verbinde dann die stärksten Bewegungen und die belegten Zusammenhänge zu einem kurzen Bogen und schließe mit Konstanz oder einem Punkt zum Beobachten — Synthese, nicht jede Metrik nacheinander auflisten.
- 2 bis 4 kurze Sätze. Nur Klartext — kein Markdown, keine Überschriften, keine Aufzählungen, keine Emojis.
- Wenn der Kontext dünn ist, sage klar, dass es in diesem Zeitraum wenig zu berichten gibt, statt Details zu erfinden.

${composeSharedContracts("de", ["toneContract", "grounding", "openingShape", "safetyGlp1", "safetyAcute", "metricIdentifierBan", "forbiddenFiller", "formattingContract"])}`;

/**
 * The system prompt for one reader.
 *
 * German readers compose the reviewed German body; every other locale
 * composes the English body and is told, in its own language, which language
 * to write in. The former `locale === "de" ? DE : EN` binary was fed by a
 * route that narrowed every non-`en` locale to `de`, so French, Spanish,
 * Italian and Polish readers received German retrospectives.
 */
export function buildNarrativeSystemPrompt(locale: Locale): string {
  const body =
    instructionLocale(locale) === "de"
      ? SYSTEM_PROMPT_DE
      : SYSTEM_PROMPT_EN_TEMPLATE.split(LANGUAGE_RULE_TOKEN).join(
          languageRule(locale),
        );
  return withOutputLanguage(body, locale);
}

/**
 * Test-only view of the composed system prompts (incl. the appended shared
 * contracts), so the cross-surface coverage test can assert fragment presence
 * without re-deriving the composition.
 */
export const SYSTEM_PROMPTS_FOR_TEST: Record<"de" | "en", string> = {
  de: buildNarrativeSystemPrompt("de"),
  en: buildNarrativeSystemPrompt("en"),
};

/** Render the typed context into a compact, model-readable block. */
export function buildNarrativeUserPrompt(
  context: PeriodNarrativeContext,
  locale: "de" | "en",
): string {
  const periodLabel =
    context.period === "week"
      ? locale === "de"
        ? "die letzte Woche (7 Tage)"
        : "the last week (7 days)"
      : locale === "de"
        ? "den letzten Monat (30 Tage)"
        : "the last month (30 days)";

  const lines: string[] = [];
  lines.push(
    locale === "de"
      ? `Zeitraum: ${periodLabel}, verglichen mit dem vorherigen gleich langen Zeitraum.`
      : `Period: ${periodLabel}, compared with the prior period of equal length.`,
  );

  if (context.metricDeltas.length > 0) {
    lines.push(locale === "de" ? "Veränderungen:" : "Changes:");
    for (const d of context.metricDeltas) {
      if (d.current === null) continue;
      const unit = d.unit ? ` ${d.unit}` : "";
      const deltaPart =
        d.delta === null
          ? locale === "de"
            ? "(kein Vergleich möglich)"
            : "(no comparison available)"
          : `${d.delta >= 0 ? "+" : ""}${d.delta}${unit}${
              d.deltaPercent === null ? "" : ` (${d.deltaPercent}%)`
            }`;
      lines.push(
        `- ${d.type}: ${d.current}${unit} ${deltaPart} [${d.currentDays}d]`,
      );
    }
  }

  if (context.bandTransitions.length > 0) {
    lines.push(
      locale === "de"
        ? "Persönlicher Normbereich (Median ± Streuung des Vorzeitraums):"
        : "Personal typical range (prior-period median ± spread):",
    );
    for (const b of context.bandTransitions) {
      const where =
        b.direction === "above"
          ? locale === "de"
            ? "über dem Bereich"
            : "above the range"
          : b.direction === "below"
            ? locale === "de"
              ? "unter dem Bereich"
              : "below the range"
            : locale === "de"
              ? "im Bereich"
              : "in range";
      const unit = b.unit ? ` ${b.unit}` : "";
      lines.push(
        `- ${b.type}: ${b.center}${unit} (${b.bandLow}–${b.bandHigh}${unit}) → ${where}`,
      );
    }
  }

  if (context.drivers.length > 0) {
    lines.push(
      locale === "de"
        ? "Statistisch belegte Assoziationen (NICHT kausal):"
        : "Statistically supported associations (NOT causal):",
    );
    for (const dr of context.drivers) {
      lines.push(
        `- ${dr.behaviour} ~ ${dr.outcome}: r=${dr.r}, q=${dr.qValue}, n=${dr.n} — ${dr.interpretation}`,
      );
    }
  }

  if (context.coincidentFlags.length > 0) {
    lines.push(
      locale === "de"
        ? `Tage mit mehreren gleichzeitig außerhalb des Normbereichs liegenden Werten: ${context.coincidentFlags.length}.`
        : `Days with several vitals outside the typical range together: ${context.coincidentFlags.length}.`,
    );
  }

  lines.push(
    locale === "de"
      ? `(${context.pairsTested} Paare getestet, FDR-Ziel q=${context.fdrQ}.)`
      : `(${context.pairsTested} pairs tested, FDR target q=${context.fdrQ}.)`,
  );

  return lines.join("\n");
}

/**
 * Generate + cache the period narrative for one user. Pure pipeline; no
 * rate-limit / request concerns (the route + cron add those). Returns a typed
 * outcome the caller can log + branch on. Never throws on a provider failure
 * (a cron batch loop must continue to the next user).
 */
export async function generatePeriodNarrative(
  userId: string,
  options: GenerateOptions,
): Promise<NarrativeGenerateOutcome> {
  const { locale } = options;
  // The de/en body language the user prompt, the deterministic fallback and
  // the grounding correction are composed in. The ROW stays keyed by the full
  // `locale`; only the prose scaffolding collapses to a reviewed body.
  const bodyLocale = instructionLocale(locale);
  const force = options.force === true;
  const now = options.now ?? new Date();
  const prisma = options.prisma ?? defaultPrisma;
  const buildContext = options.buildContext ?? buildPeriodNarrativeContext;
  const runCompletion = options.runCompletion ?? runStatusCompletion;
  const period = options.period;

  // Freshness short-circuit — a recently-generated row is served as-is, as
  // long as a reader may serve it. A model-written row whose capability has
  // since become unavailable is hidden on read, so it counts as missing here
  // and the deterministic narrative below takes its place.
  if (!force) {
    const existing = await prisma.insightNarrative.findUnique({
      where: { userId_period_locale: { userId, period, locale } },
      select: { updatedAt: true, providerType: true },
    });
    if (
      existing &&
      now.getTime() - existing.updatedAt.getTime() < NARRATIVE_FRESH_MS &&
      (await narrativeServable(userId, existing.providerType))
    ) {
      return { status: "cached" };
    }
  }

  const context = await buildContext(userId, { period, now, locale });
  if (context.status === "insufficient") {
    annotate({
      action: { name: "insights.narrative.insufficient" },
      meta: { period, reason: context.reason },
    });
    return { status: "insufficient" };
  }

  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = profile?.timezone ?? DEFAULT_TIMEZONE;

  const completion = await runCompletion({
    userId,
    cacheAction: `insights.narrative.${period}.${locale}`,
    capability: "periodNarrative",
    systemPrompt: buildNarrativeSystemPrompt(locale),
    userPrompt: buildNarrativeUserPrompt(context, bodyLocale),
    temperature: AI_BUDGETS.narrative.temperature,
    maxTokens: AI_BUDGETS.narrative.maxTokens,
    // v1.18.7 / v1.22 (W6) — the reference/diff path pins the deterministic
    // seed (byte-stable for attribution); real users get a day-rotated seed so
    // the weekly / monthly narrative varies run-to-run instead of reading
    // near-identical every time (Root cause D — the fixed seed in prod).
    seed: options.referenceSeed
      ? REFERENCE_AI_SEED
      : dayRotatedSeed(`${userId}:${period}:${dateKeyFor(now, tz)}`),
    // The narrative output is PLAIN TEXT (no markdown, no JSON), so suppress
    // the JSON-mode opt-in the status cards default into.
    responseFormat: "text",
    // v1.41 — a period narrative is one of the few background jobs that may
    // reason: medium for the month, low for the week, held to the operator's
    // switch and cap. The grounding retry below repairs and does not reason.
    reasoningJob:
      period === "month" ? "period_narrative_month" : "period_narrative_week",
  });

  // A provider error / timeout is non-fatal — the last good row stays as-is
  // and the next read re-tries. We do NOT fall back to deterministic prose
  // here: a configured provider that briefly fails should not overwrite (or
  // shadow) its own richer narrative with the terse fallback.
  if (completion.kind === "timeout") {
    annotate({
      action: { name: "insights.narrative.timeout" },
      meta: { period, locale },
    });
    return { status: "failed", reason: "timeout" };
  }
  if (completion.kind === "error") {
    return { status: "failed", reason: "provider-error" };
  }

  const provenance: NarrativeProvenancePayload = {
    metrics: context.provenance.metrics,
    window: context.provenance.window,
    pairsTested: context.pairsTested,
    fdrQ: context.fdrQ,
    computedAt: context.provenance.computedAt,
  };
  const dateKey = dateKeyFor(now, tz);

  // Upsert the single (user, period, locale) row in place — delete/regenerate
  // clean by construction. The prose is held AES-256-GCM at rest.
  const persist = async (text: string, providerType: string) => {
    const encryptedContent = encryptToBytes(text);
    await prisma.insightNarrative.upsert({
      where: { userId_period_locale: { userId, period, locale } },
      create: {
        userId,
        period,
        locale,
        dateKey,
        encryptedContent,
        provenanceJson: JSON.stringify(provenance),
        providerType,
        promptVersion: NARRATIVE_PROMPT_VERSION,
      },
      update: {
        dateKey,
        encryptedContent,
        provenanceJson: JSON.stringify(provenance),
        providerType,
        promptVersion: NARRATIVE_PROMPT_VERSION,
      },
    });
    annotate({
      action: { name: "insights.narrative.generated" },
      meta: { period, locale, provider: providerType, seed: REFERENCE_AI_SEED },
    });
  };

  // No usable provider, or the `periodNarrative` capability is unavailable for
  // any other reason → compose the deterministic, non-causal fallback from the
  // same structured context, so the retrospective card is never empty for an
  // active account (iOS H2). A later AI warm overwrites this row in place.
  if (completion.kind === "none") {
    const text = buildDeterministicNarrative(context, bodyLocale);
    await persist(text, DETERMINISTIC_PROVIDER_TYPE);
    return { status: "generated", providerType: DETERMINISTIC_PROVIDER_TYPE };
  }

  let text = completion.content.trim();
  if (text.length === 0) {
    return { status: "failed", reason: "empty" };
  }

  // v1.18.10 (HIGH-3) — grounding gate on the AI prose, matching the rejecting
  // gate Comprehensive Insights already has. Flag causal phrasing and any
  // number absent from the context; on a trip, retry ONCE with a corrective
  // suffix, then fall back to writing NOTHING (last good row stays) rather than
  // persisting an ungrounded or causal story.
  let findings = validateNarrativeText(text, context, locale);
  if (findings.length > 0) {
    annotate({
      action: { name: "insights.narrative.grounding_retry" },
      meta: {
        period,
        locale,
        causal: findings.some((f) => f.reason === "causal_language"),
        ungroundedNumbers: findings.filter(
          (f) => f.reason === "ungrounded_number",
        ).length,
      },
    });
    const retry = await runCompletion({
      userId,
      cacheAction: `insights.narrative.${period}.${locale}`,
      capability: "periodNarrative",
      systemPrompt: buildNarrativeSystemPrompt(locale),
      userPrompt:
        buildNarrativeUserPrompt(context, bodyLocale) +
        buildNarrativeCorrection(findings, bodyLocale),
      temperature: AI_BUDGETS.narrative.temperature,
      maxTokens: AI_BUDGETS.narrative.maxTokens,
      seed: REFERENCE_AI_SEED,
      responseFormat: "text",
    });
    if (retry.kind === "ok") {
      const retryText = retry.content.trim();
      const retryFindings = validateNarrativeText(retryText, context, locale);
      if (retryText.length > 0 && retryFindings.length === 0) {
        text = retryText;
        findings = [];
      } else {
        findings = retryFindings;
      }
    }
    if (findings.length > 0) {
      annotate({
        action: { name: "insights.narrative.grounding_rejected" },
        meta: { period, locale },
      });
      return { status: "failed", reason: "ungrounded" };
    }
  }

  await persist(text, completion.providerType);
  return { status: "generated", providerType: completion.providerType };
}

/** The narrative row, decrypted for a read. */
export interface NarrativeRead {
  period: NarrativePeriod;
  locale: Locale;
  text: string;
  dateKey: string;
  provenance: NarrativeProvenancePayload | null;
  providerType: string | null;
  promptVersion: string | null;
  updatedAt: string;
}

/**
 * Read the latest narrative for `(userId, period, locale)`, decrypting the
 * prose. Null when none was ever generated, or when it is model-written and
 * `periodNarrative` is unavailable for the record. This is the stale-while-revalidate
 * source: it returns whatever was last produced, regardless of age, so the
 * surface renders prior prose immediately while a refresh warms out of band.
 */
export async function readPeriodNarrative(
  userId: string,
  period: NarrativePeriod,
  locale: Locale,
  prisma: PrismaClient = defaultPrisma,
): Promise<NarrativeRead | null> {
  const row = await prisma.insightNarrative.findUnique({
    where: { userId_period_locale: { userId, period, locale } },
  });
  if (!row) return null;
  // Model-written prose is never served while the capability is unavailable,
  // whatever the reason. The deterministic narrative is data and always is.
  if (!(await narrativeServable(userId, row.providerType))) {
    annotate({
      action: { name: "insights.narrative.hidden" },
      meta: { period, locale },
    });
    return null;
  }

  let text: string;
  try {
    text = decryptFromBytes(row.encryptedContent);
  } catch {
    // A row we cannot decrypt is treated as absent — the caller regenerates.
    return null;
  }

  let provenance: NarrativeProvenancePayload | null = null;
  if (row.provenanceJson) {
    try {
      provenance = JSON.parse(row.provenanceJson) as NarrativeProvenancePayload;
    } catch {
      provenance = null;
    }
  }

  return {
    period: row.period as NarrativePeriod,
    locale: row.locale as Locale,
    text,
    dateKey: row.dateKey,
    provenance,
    providerType: row.providerType,
    promptVersion: row.promptVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Whether a stored narrative may be served: always for the deterministic
 * narrative, and for model-written prose only while `periodNarrative` is
 * available for the record, answered from the record's own state whoever is
 * reading.
 */
async function narrativeServable(
  userId: string,
  providerType: string | null,
): Promise<boolean> {
  if (providerType === DETERMINISTIC_PROVIDER_TYPE) return true;
  return (await aiCapabilityToServe(userId, "periodNarrative")).available;
}

/** Prisma `Bytes` ↔ ciphertext, mirroring the CoachMessage helper. */
function encryptToBytes(plaintext: string): Uint8Array<ArrayBuffer> {
  const ciphertext = encrypt(plaintext);
  const encoded = Buffer.from(ciphertext, "utf8");
  const out = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  out.set(encoded);
  return out;
}

function decryptFromBytes(buf: Uint8Array): string {
  return decrypt(Buffer.from(buf).toString("utf8"));
}
