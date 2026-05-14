# Phase W5b — v1.4.25 token-leak fix report

**Marc directive 2026-05-14**: raw `Metric Pressure_Sys` token leak
reported on the Einschätzungen / Recommendations surface. The v1.4.22
`stripChartTokens()` fix only caught the canonical `metric:<TYPE>`
colon form; the leak pattern Marc saw was a capitalised "Metric"
prefix followed by an enum identifier with PascalCase + underscore
(`Pressure_Sys`).

## Diagnosis

`grep -rn stripChartTokens src/` showed two render-side users only —
`RecommendationCard` (top-line rec text) and `InsightAdvisorCard`
(summary, primaryRecommendation, finding label + guideline). Every
other AI-prose surface bypassed the stripper:

- `DailyBriefing` — paragraph + key-finding rows
- `WeeklyReport` — summary, going-well, worth-watching, tips, data
  quality
- `TrendAnnotation` — observational sentence
- `RecommendationCard` — rationale rows (dataWindow, comparedTo,
  deviation) inside the expanded RationaleCard
- `InsightsCardPreview` — dashboard mini-card rec text
- Coach `message-thread` — assistant bubble content

Even if the stripper had caught the `Metric Pressure_Sys` pattern,
those surfaces would have stayed leaky because they never ran AI
text through the stripper at all.

## Regex diff

```diff
- const STRIP_TOKEN_REGEX = /metric:[A-Za-z0-9_]+/g;
- const PARSE_TOKEN_REGEX = /metric:[A-Z_]+/g;
+ const STRIP_TOKEN_REGEX = /metric:[A-Za-z0-9_]+/g;
+ const PARSE_TOKEN_REGEX = /metric:[A-Z_]+/g;
+
+ const METRIC_WORD_REGEX = /\bMetric\s+[A-Za-z][A-Za-z0-9_]*\b/g;
+
+ const ORPHAN_ENUMS = [
+   "BLOOD_PRESSURE_SYS",
+   "BLOOD_PRESSURE_DIA",
+   "PULSE_BPM",
+   "MOOD_SCORE",
+   "MEDICATION_COMPLIANCE_PCT",
+   "HEART_RATE_VARIABILITY",
+   "RESTING_HEART_RATE",
+   "ACTIVE_ENERGY_BURNED",
+   "FLIGHTS_CLIMBED",
+   "WALKING_RUNNING_DISTANCE",
+   "VO2_MAX",
+   "BODY_TEMPERATURE",
+   "SLEEP_DURATION",
+ ] as const;
+ const ORPHAN_ENUM_REGEX = new RegExp(
+   `\\b(?:${ORPHAN_ENUMS.join("|")})\\b`,
+   "g",
+ );
```

`stripChartTokens()` body:

```diff
- return text
-   .replace(STRIP_TOKEN_REGEX, "")
-   .replace(/\s{2,}/g, " ")
-   .trim();
+ return text
+   .replace(STRIP_TOKEN_REGEX, "")
+   .replace(METRIC_WORD_REGEX, "")
+   .replace(ORPHAN_ENUM_REGEX, "")
+   .replace(/\s+([.,;:!?])/g, "$1")
+   .replace(/\s{2,}/g, " ")
+   .trim();
```

The orphan-enum list is fixed (not `[A-Z_]+`) so legitimate single
capitalised words like `WEIGHT` / `MOOD` stay legible in normal
prose — only suffixed enum identifiers get cleaved. Lowercase
"metric" inside legitimate English prose ("Each metric tells part
of the story") is also untouched. German "Metrik" is safe by virtue
of the anchored "Metric" + whitespace + identifier pattern.

## Surfaces audited

| Surface                                   | Path                                 | Before   | After                                       |
| ----------------------------------------- | ------------------------------------ | -------- | ------------------------------------------- |
| InsightAdvisorCard summary                | `insight-advisor-card.tsx:594`       | stripped | stripped (no change)                        |
| InsightAdvisorCard primaryRec             | `insight-advisor-card.tsx:573`       | stripped | stripped (no change)                        |
| InsightAdvisorCard finding.label          | `insight-advisor-card.tsx:154,622`   | stripped | stripped (no change)                        |
| InsightAdvisorCard finding.guideline      | `insight-advisor-card.tsx:159,631`   | stripped | stripped (no change)                        |
| RecommendationCard rec text               | `recommendation-card.tsx:338`        | stripped | stripped (no change)                        |
| RecommendationCard rationale rows         | `recommendation-card.tsx:209-220`    | **raw**  | **stripped**                                |
| DailyBriefing paragraph                   | `daily-briefing.tsx:233`             | **raw**  | **stripped**                                |
| DailyBriefing finding.headline            | `daily-briefing.tsx:148`             | **raw**  | **stripped**                                |
| DailyBriefing finding.detail              | `daily-briefing.tsx:152`             | **raw**  | **stripped**                                |
| WeeklyReport summary                      | `weekly-report-view.tsx:194`         | **raw**  | **stripped**                                |
| WeeklyReport goingWell/worthWatching/tips | `weekly-report-view.tsx:205/217/229` | **raw**  | **stripped (via `.map(stripChartTokens)`)** |
| WeeklyReport dataQualityNotes             | `weekly-report-view.tsx:242`         | **raw**  | **stripped**                                |
| TrendAnnotation annotation                | `trend-annotation.tsx:78`            | **raw**  | **stripped**                                |
| InsightsCardPreview rec text              | `insights-card.tsx:104`              | **raw**  | **stripped**                                |
| Coach assistant bubble content            | `message-thread.tsx:334`             | **raw**  | **stripped**                                |

Surfaces explicitly left raw:

- **Coach user bubbles** (`message-thread.tsx:272`) — user-typed
  content, not AI-emitted.
- **Coach evidence-block key/value rows** (`message-thread.tsx:377-388`)
  — constrained by prompt to short labels like "avg30 systolic" + a
  pre-formatted value. GROUND RULE 8 enforces that.
- **CorrelationCard interpretation** — server-generated from
  `correlations.ts`, deterministic strings, no AI surface.

## Before / after (illustrative — render output for a leaky model

reply)

**Before**:

```
Your Metric Pressure_Sys is sitting at 138 this week, with
BLOOD_PRESSURE_SYS holding steady. Your MOOD_SCORE trended brighter.
```

**After**:

```
Your is sitting at 138 this week, with holding steady. Your
trended brighter.
```

(The double-space collapse + punctuation-clinging fix ensures
"holding steady. Your trended brighter." instead of " , "
fragments. The prompt-side GROUND RULE 13 makes sure the model
emits the natural-language reference instead, which is what the
user actually wants to see.)

## Prompt-side reinforcement

`PROMPT_VERSION` ratcheted **4.23.0 → 4.24.0**. Truly new rule —
neither the insight-generator nor the Coach prompt previously
mentioned these enum identifiers in any form. Confirmed via
`grep -n "BLOOD_PRESSURE\|Pressure_Sys\|enum\|raw metric\|metric
name\|never mention" src/lib/ai/prompts/insight-generator.ts
src/lib/ai/coach/system-prompt.ts` → no hits.

### Insight-generator (EN + DE) — GROUND RULE 13

Lists every banned identifier verbatim (incl. v1.4.23 Apple Health
surface), enumerates the user-facing fields the ban applies to
(summary, recommendations[].text, findings, dailyBriefing,
trendAnnotations._, weeklyReport._, storyboardAnnotations), and
carves out the contract-level identifier slots
(`metricSource.type`, `sourceMetric`, trendAnnotations keys) so the
JSON contract stays intact. Documents natural-language references
to use instead ("your systolic", "your weight", …).

### Coach system-prompt (EN + DE) — GROUND RULE 8

Mirror rule with the same banned list, the same prose-only
carve-out, and an extra clarification that evidence-block labels
stay human ("avg30 systolic", not "BLOOD_PRESSURE_SYS_AVG_30") while
the window slot keeps its documented vocabulary
(last7days / last30days / last90days / allTime).

## Test count delta

| Bucket                                             | Before                                  | After | Δ                       |
| -------------------------------------------------- | --------------------------------------- | ----- | ----------------------- |
| `src/lib/insights/__tests__/chart-tokens.test.ts`  | 17                                      | 31    | +14                     |
| `src/lib/ai/__tests__/coach-prompt-v423.test.ts`   | 7                                       | 9     | +2                      |
| `src/lib/ai/coach/__tests__/system-prompt.test.ts` | (same count, 2 assertions added inline) |       | +0 files, +2 assertions |
| **Suite total**                                    | 2333                                    | 2347  | +14                     |

(The 2 inline assertions on the existing rule-list expectations don't
add new `it()` blocks, only `expect()` lines inside existing tests.)

All 2347 tests pass (`pnpm test`).
Typecheck clean on every file I touched (`pnpm typecheck` errors are
in `login-overview-section.tsx` + `timezone-per-user.test.ts` — both
from parallel agent work, not my changes).
Lint clean on every file I touched (`pnpm lint` warnings are in
`charts/health-chart.tsx` + `login-overview-section.tsx`, also
parallel agent work).

## Commits (all on `develop`, no push)

1. `5deed3f` — fix(insights): stripChartTokens covers capitalised
   Metric + orphan enum patterns + Apple Health additives
2. `a19768c` — feat(insights): plumb stripChartTokens through every
   AI-prose surface
3. `feeff38` — feat(coach-prompt): GROUND RULE 13 (insights) + 8
   (coach) — no internal metric enum names in prose
