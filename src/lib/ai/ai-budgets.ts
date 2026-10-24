/**
 * Per-surface AI generation budgets — the single source of truth for the
 * `temperature` and `maxTokens` each AI surface sends to the provider.
 *
 * Before this module the values were scattered as `?? 0.3` / `?? 1000`
 * magic numbers across the status provider, the Coach route, the
 * comprehensive generator and the period-narrative generator. Centralising
 * them keeps the cost ceiling auditable in one place and ties every number
 * to the output contract it serves (commented per entry below).
 *
 * `seed` (where present) is a deterministic constant pinned for the
 * reference/reproducible surfaces (per the v1.18.7 AI audit MEDIUM-4):
 * the status cards and the period narrative are reference assessments, so a
 * fixed seed makes a prompt change diff-able against a stable baseline. The
 * daily-briefing paragraph is deliberately NOT seeded (it re-rolls for
 * phrasing variety — see comprehensive-generate.ts).
 */

export interface AiBudget {
  /** Sampling temperature. Low for reference surfaces, slightly higher for chat. */
  temperature: number;
  /**
   * Output-token ceiling. Sized to the surface's documented output contract.
   * Optional for surfaces whose caller pins its own token const (self-context).
   */
  maxTokens?: number;
  /**
   * v1.21.5 — optional per-surface upstream timeout (ms) threaded onto the
   * provider call via `CompletionParams.timeoutMs`. Omitted → the client's
   * shared 60 s default holds. Only the comprehensive briefing sets it: its
   * reasoning-heavy generation over the full feature snapshot legitimately
   * runs past 60 s on large accounts, and the default abort clipped it
   * mid-stream — leaving the briefing permanently blank.
   */
  timeoutMs?: number;
}

/**
 * Deterministic seed pinned for the reproducible reference surfaces. A stable
 * constant (not a per-request value) so two runs of the same prompt+snapshot
 * on a seed-aware provider produce byte-identical text — the QA-attribution
 * baseline the audit's MEDIUM-4 calls for.
 */
export const REFERENCE_AI_SEED = 1_618_033 as const;

/**
 * Surface budgets. Each entry's comment states the output contract that
 * fixes its `maxTokens`.
 */
export const AI_BUDGETS = {
  /**
   * Comprehensive insight + dailyBriefing — the largest structured payload
   * (summary + recommendations + dailyBriefing 80-200 words + signals +
   * keyFindings + trendAnnotations + storyboardAnnotations). The output-token
   * ceiling lives in `resolveInsightsMaxTokens()` below (env-tunable via
   * `INSIGHTS_MAX_TOKENS`, default 2500) — the fixed 1500 that used to sit
   * here truncated real briefings on verbose models (v1.28.28, #470):
   * finish_reason "length" mid-JSON surfaced as the generic invalid-JSON 422.
   *
   * v1.21.5 — `timeoutMs` raised to 120 s for THIS surface only. The 60 s
   * client default aborted the reasoning-heavy single-turn generation
   * mid-stream on large accounts (observed: a 60.7 s "operation aborted due
   * to timeout" hop, no upstream status), which left the daily briefing and
   * the insights trend narrative that share its cached block blank. The
   * generation runs off the request hot path (nightly warm + the on-demand
   * background warm), and the explicit regenerate is rate-limited, so the
   * wider ceiling is bounded.
   *
   * v1.25.12 — raised again to 180 s. The same "operation aborted due to
   * timeout" hop (no upstream status) recurred at exactly the 120 s ceiling
   * once the codex default slug moved to the heavier-reasoning `gpt-5.5`
   * line: a wide account (full-history briefing, raw signals included) spends
   * longer in the reasoning channel before the first visible token than the
   * 120 s budget allowed, so the single-provider chain timed out with nothing
   * to fall back to and the briefing rendered its greeting with no body. The
   * per-user `aiResponseTimeoutSeconds` setting still overrides this default
   * for operators on even slower backends; this only lifts the floor for
   * accounts that never set it. The worker cap in `insight-pregenerate.ts`
   * derives from this value times `COMPREHENSIVE_MODEL_CALLS` plus fixed
   * headroom, so it tracks automatically.
   */
  comprehensive: { temperature: 0.3, timeoutMs: 180_000 },

  /**
   * Per-metric status assessment cards — output is a single
   * `{ "summary": "..." }` of 2-4 sentences / 30-60 words
   * (base-system.ts `length` section). ~80 tokens of content + JSON
   * envelope; 250 is a comfortable ceiling (was an over-generous 1000).
   */
  status: { temperature: 0.3, maxTokens: 250 },

  /**
   * Archetype-driven per-metric assessment — the generic metric card
   * (`metric-status.ts`) and the per-biomarker card (`biomarker-status.ts`).
   * Same `{ "summary": "..." }` output contract as `status`, but these two
   * surfaces compose a longer prompt (interpretation block, opener hint,
   * previous-assessment context) and were pinned at temperature 0.45 to buy
   * cadence variety while the snapshot keeps the facts fixed.
   *
   * Both call sites carried those numbers inline — 0.45 / 1000 — so the
   * registry claimed to be the single source of truth while the two widest
   * assessment surfaces quietly ran at 4x the nominal ceiling. This entry
   * makes that shape explicit and auditable. 700 tokens is still generous
   * headroom over the 30-60-word contract; the old 1000 was never sized to
   * anything.
   */
  statusArchetype: { temperature: 0.45, maxTokens: 700 },

  /**
   * Per-workout Activity Insight — the same `{ "summary": "..." }` contract,
   * asked for 3-4 sentences about one recorded session. 0.45 for the same
   * reason the archetype cards take it: the facts are pinned by a fully
   * deterministic evidence block, so the sampling entropy only varies cadence.
   *
   * 260 output tokens is the whole ceiling this surface gets, and it is sized
   * to the copy contract rather than rounded up: 3-4 sentences do not reach
   * it, and a model that ignores the length instruction is cut off rather than
   * indulged. The daily cap on the surface is four, so the worst case a single
   * account can drive here is bounded before the ledger is even consulted.
   */
  workoutInsight: { temperature: 0.45, maxTokens: 260 },

  /**
   * Batched per-metric status assessment (v1.18.7 HIGH-1) — ONE call that
   * returns a `{ perMetric: { bp, weight, pulse, bmi, mood, compliance,
   * general } }` envelope, each value a single 30-60-word assessment in the
   * same contract as a standalone status card. The seven warm calls a fully
   * instrumented account fired per cycle collapse into this one. Sized for
   * up to seven ~80-token summaries plus the JSON envelope: 1400 tokens.
   * Temperature matches the per-card 0.45 (cadence entropy while the FACTS
   * stay pinned by the snapshot + the forbidden-phrase guards).
   */
  statusBatch: { temperature: 0.45, maxTokens: 1400 },

  /**
   * Period narrative (week/month) — 2-4 short plain-text sentences
   * (period-narrative-generate.ts SYSTEM_PROMPT). 400 tokens.
   */
  narrative: { temperature: 0.3, maxTokens: 400 },

  /**
   * Coach SSE chat — a 60-180 word prose reply plus an optional evidence
   * sentinel block (system-prompt.ts rule 1). 600 tokens. Slightly higher
   * temperature than the reference surfaces for conversational variety.
   */
  coach: { temperature: 0.4, maxTokens: 600 },

  /**
   * v1.25.0 — proactive Coach nudge enrichment (opt-in). One short, warm,
   * localized body of 1-2 sentences — no figures, no greeting (the app adds
   * the name-led greeting deterministically). 160 tokens comfortably covers
   * it; the tight `timeoutMs` keeps the sequential 05:15 tick from stalling
   * on a slow provider (any timeout falls back to the template). Temperature
   * a touch higher for warmth without drift.
   */
  coachNudge: { temperature: 0.6, maxTokens: 160, timeoutMs: 9000 },

  /**
   * v1.31.0 — the arrival reaction line. ONE sentence replacing the Today
   * hero's lead for the rest of the day, written at most once per arrival kind
   * per local day (the `ArrivalReaction` unique row is the throttle). 220
   * tokens is generous for a single sentence and leaves room for a model that
   * warms up before it commits. Temperature between the reference surfaces and
   * the conversational ones: the verdict must stay stable against the same
   * evidence, but a line the user reads every day should not read as a
   * template.
   */
  arrivalReaction: { temperature: 0.45, maxTokens: 220, timeoutMs: 12_000 },

  /**
   * Coach rolling-conversation summary worker — a compact summary of the
   * elided older turns. 200 tokens.
   */
  summary: { temperature: 0.3, maxTokens: 200 },

  /**
   * Coach durable-fact extraction worker — a short structured fact list.
   * 300 tokens. Lowest temperature: extraction must be faithful, not
   * creative.
   */
  facts: { temperature: 0.2, maxTokens: 300 },

  /**
   * Coach self-context question generation — a small set of clarifying
   * questions. Temperature only; the caller pins its own token const.
   */
  selfContext: { temperature: 0.4 },

  /**
   * v1.18.9 — Lab-OCR structured extraction, PER READ. A report is read a page
   * at a time (`src/lib/labs/ocr-run.ts`), so this ceiling covers one page's
   * JSON, not the whole document: a dense page is 30-50 rows at roughly 90
   * tokens each, and 8000 leaves room for that. It is the answer budget only;
   * the call carries an explicit reasoning off, and a model that cannot stop
   * thinking gets its minimum thinking budget added on top by its client.
   * One call used to carry the whole report under this ceiling, and a long
   * one stopped mid-row. Temperature 0 — faithful transcription, not
   * generation. `timeoutMs` 120 s: one page of JSON on a slower model runs
   * past the shared 60 s default; the person's own setting still wins.
   */
  ocrExtract: { temperature: 0, maxTokens: 8000, timeoutMs: 120_000 },

  /**
   * v1.43 — a supplement label photo read into its ingredients. One vision
   * call; a label lists a few dozen lines at most, so half the lab budget
   * holds the JSON with room for reasoning. Temperature 0: transcription.
   */
  supplementLabel: { temperature: 0, maxTokens: 4000 },

  /**
   * v1.20.1 — Lab-OCR text-mode reservation. The browser OCR's the image
   * (tesseract.js) and POSTs only the extracted TEXT, so no vision input
   * tokens are spent. This is what the route reserves against the day's
   * budget when it queues the read; the structuring calls themselves run
   * under `ocrExtract`'s per-read ceiling, and the run settles what the
   * provider reported it spent.
   */
  ocrExtractText: { temperature: 0, maxTokens: 1500 },

  /**
   * v1.27.22 (Document vault P2) — filing-metadata assist. ONE call proposes a
   * short `{ title, kind, documentDate }` draft for a stored document. A tiny
   * JSON envelope, so 400 tokens is ample; temperature 0 — a neutral filing
   * label is a transcription task, not generation.
   */
  documentAssist: { temperature: 0, maxTokens: 400 },

  /**
   * v1.27.22 — on-demand, session-only plain-language document summary. A short
   * descriptive paragraph (what kind of document, what it is about), never a
   * diagnosis. 600 tokens covers 2-4 sentences plus headroom; a touch of
   * temperature for readable prose without drift.
   */
  documentSummary: { temperature: 0.3, maxTokens: 600 },

  /**
   * v1.27.22 — raw verbatim transcription of a document's text. Feeds the
   * session-only "extracted text" view AND the content-search index build. A
   * dense multi-page report runs long, so 4000 tokens matches the vision-OCR
   * ceiling; temperature 0 — faithful transcription, not generation.
   */
  documentTranscribe: { temperature: 0, maxTokens: 4000 },

  /**
   * v1.27.33 (Document vault P4 — chat about a document) — a grounded prose
   * reply about ONE stored document's text. 60-180 words, no sentinel blocks,
   * no tools. Mirrors the Coach's 600-token / temperature-0.3 shape; the low
   * temperature keeps the reply close to the document (extractive), not creative.
   */
  documentChat: { temperature: 0.3, maxTokens: 600 },
} as const satisfies Record<string, AiBudget>;

/**
 * The most model calls one comprehensive generation makes one after another:
 * the generation itself, the JSON retry when its reply does not parse, the
 * grounding retry when the briefing quotes a figure the server never
 * computed and the repair when the outbound screen withholds the payload,
 * plus the one repeat the Local and gateway clients send when a thinking
 * model answered with reasoning alone. Every one of them has the person's
 * response timeout (or `comprehensive.timeoutMs`) to itself, so whatever
 * waits on the whole generation from outside (the warm's abort in
 * `insight-pregenerate.ts`, the Insights page's poll for the warm) waits for
 * this many (#1274). `ai-call-timeout-guard.test.ts` holds the generator's
 * stages to this count.
 */
export const COMPREHENSIVE_MODEL_CALLS = 5;

/**
 * The most model calls one status run (`runStatusCompletion`: a status card,
 * the batched assessment, a derived score, a period narrative, a workout
 * line, a Coach memory pass) makes one after another: the call itself, plus
 * the one repeat the Local and gateway clients send when a thinking model
 * answered with reasoning alone. Each has the person's response timeout to
 * itself, so the run's outer bound, the jobs around it and the page that
 * polls for its text all wait for this many (#1274).
 */
export const STATUS_MODEL_CALLS = 2;

/** Bounds + default for the comprehensive / briefing output-token ceiling. */
const INSIGHTS_MAX_TOKENS_DEFAULT = 2500;
const INSIGHTS_MAX_TOKENS_MIN = 500;
const INSIGHTS_MAX_TOKENS_MAX = 8000;

/** Memo of the last parse, keyed on the raw env string so env stubs in tests re-parse. */
let insightsMaxTokensMemo: { raw: string | undefined; value: number } | null =
  null;

/**
 * v1.28.28 (#470) — output-token ceiling for the comprehensive briefing
 * generation (the POST /api/insights/generate inline path, its grounding
 * retry, and every `comprehensive-generate.ts` call site). Reads the
 * optional `INSIGHTS_MAX_TOKENS` env var:
 *
 *  - unset / non-numeric → 2500 (the old hard-coded 1500 truncated real
 *    briefings on verbose models — the JSON was cut mid-string and the
 *    user saw a generic invalid-JSON 422),
 *  - numeric but out of range → clamped into [500, 8000] so a typo can
 *    neither starve the payload nor hand a runaway budget to the provider.
 *
 * Parsed once per distinct raw value (memoised), same posture as
 * `resolveInsightsRateLimit()` next to the route.
 */
export function resolveInsightsMaxTokens(): number {
  const raw = process.env.INSIGHTS_MAX_TOKENS;
  if (insightsMaxTokensMemo && insightsMaxTokensMemo.raw === raw) {
    return insightsMaxTokensMemo.value;
  }
  let value = INSIGHTS_MAX_TOKENS_DEFAULT;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      value = Math.min(
        INSIGHTS_MAX_TOKENS_MAX,
        Math.max(INSIGHTS_MAX_TOKENS_MIN, parsed),
      );
    }
  }
  insightsMaxTokensMemo = { raw, value };
  return value;
}
