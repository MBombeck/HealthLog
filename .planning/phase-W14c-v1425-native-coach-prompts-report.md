# Phase W14c — Native FR/ES/IT/PL Coach prompts

Release: v1.4.25
Branch: develop
Phase commits: 5 (84af00d, 0af9923, 6e04372, 9b30e11, 75fce6c)
Status: shipped

## Background

The W14c research (`.planning/research/w14c-native-coach-prompts.md`)
recommended **Option A — full native rewrite per locale** for the
AI-initial languages (FR / ES / IT / PL), gated on a safety-contract
matrix and refusal-probe test landing FIRST. Marc cannot review the
FR/ES/IT/PL safety-critical translations himself, so the original
"LLM-draft + Marc-review safety zeilen" plan was replaced with
**denser automated coverage** — 20+ adversarial paraphrasings per
ground rule per locale, validated in CI on every push.

The W9e EN-body-plus-REPLY-LANGUAGE-footer plumbing is retired for the
four AI-initial locales. EN and DE keep their existing hand-curated
bodies (Marc-reviewed; DE has two years of clause-by-clause iteration).

## Commits

| Commit | Title | Files | LOC |
|---|---|---|---|
| 84af00d | feat(ai): safety-contract matrix as YAML per locale | 7 new | +1967 |
| 0af9923 | test(ai): refusal-probe matrix — 20 adversarial paraphrasings × 14 contracts × 6 locales | 1 new + 6 modified | +541 / -24 |
| 6e04372 | feat(coach): native locale-specific system prompts (replaces REPLY LANGUAGE footer) | 2 new + 2 modified | +846 / -28 |
| 9b30e11 | feat(i18n): MaintainershipBanner acknowledges AI-drafted safety-critical content | 7 modified | +113 / -12 |
| 75fce6c | test(ai): safety-contracts parity + sentinel-preservation + brand-name guard | 1 new + 6 modified | +182 |

## What landed

### 14c.1 — Safety-contract matrix

`src/lib/ai/prompts/safety-contracts.{en,de,fr,es,it,pl}.yaml` — six
YAML files keyed by stable ground-rule IDs. Each file carries:

- 14 ground rules (the union of Coach + Insights safety contracts)
  with `parser_critical` and `surface` flags so downstream tests can
  distinguish stylistic from safety-load-bearing clauses
- `sentinel_literals` (`---KEYVALUES---`, `---END---`, `<example>`, etc)
  that stay EN-identical everywhere
- `glp1_brand_list` (Mounjaro / Zepbound / Ozempic / Wegovy / Rybelsus
  / Saxenda / Victoza / Trulicity) — never translated
- `contract_enums` (severity / sourceWindow / sourceMetric / topic /
  category / tone / time_range) — lowercase EN, parser keys
- `medical_terminology` per locale (hypertension / systolic / titration
  / etc) — preferred clinical-but-explained terms
- `defer_to_clinician_phrases` — locale-specific allow-list the
  refusal-probe asserts at least one of survives in any GLP-1 prompt
- `out_of_scope_refusal.summary` — the user-facing refusal string
  (mirrors `OUT_OF_SCOPE_REFUSAL_*` constants)
- `reply_language_directive` — short clause appended to the prompt

`src/lib/ai/prompts/safety-contracts.ts` — Zod-validated loader.
Throws on schema mismatch at startup so a malformed YAML fails fast.

### 14c.2 — Refusal-probe matrix

`src/lib/ai/prompts/__tests__/refusal-probe.test.ts` — for every
(ground_rule, locale) pair, ≥20 adversarial paraphrasings (direct
asks, indirect asks, role-play attempts, system-prompt-injection
tries, multilingual code-switches) exercise the matrix and the
prompt-assembly path.

GLP-1 dose refusal — the highest-patient-risk contract — gets a
heavier cross-locale check: for every adversarial probe, the
assembled context must list every GLP-1 brand verbatim AND include at
least one defer-to-clinician phrase token from the locale's allow-list.

**Coverage**: 273 test cases / ~3000 structural assertions
(adversarial probes alone: ≥1680).

### 14c.3 — Coach + Insights prompts use native bodies

`src/lib/ai/prompts/native-prompts.ts` — new builder that assembles a
locale-specific Coach or Insights prompt from the matrix. Persona,
section headers, DAY-LEVEL / EVIDENCE BLOCK / EXAMPLES sections are
hand-curated per locale; ground-rule bodies pulled from the matrix;
OUTPUT FORMAT schema kept in EN contract-tokens per the matrix's
contract_enums pin.

`src/lib/ai/coach/system-prompt.ts` and
`src/lib/ai/prompts/insight-generator.ts` route AI-initial locales
through the native builder. EN and DE bodies untouched. If the matrix
loader throws for any reason the dispatcher falls back to the W9e
EN-body-plus-footer path so the surface fails open rather than empty.

`OUT_OF_SCOPE_REFUSAL_FR / ES / IT / PL` constants exported from
`insight-generator.ts`, sourced from the matrix's
`out_of_scope_refusal.summary` field.

`src/lib/ai/prompts/__tests__/coach-prompt-locale.test.ts` — 52
assertions covering native prompt assembly per locale, persona
opening lines, parser sentinel preservation, GLP-1 brand presence,
EN enum preservation, `<example>` few-shot count.

### 14c.4 — MaintainershipBanner copy update

All six `messages/<locale>.json` notice strings rewritten to be
explicit that the AI-initial locales (FR / ES / IT / PL) are
AI-drafted INCLUDING the Coach's safety-critical instructions, and
that automated validation guards them in CI. The CTA reframes from
"help out" to "report on GitHub".

Banner component (`src/components/i18n/maintainership-banner.tsx`)
needs no code change — it renders the i18n string. The banner test
gained a copy-pin so a future regression cannot quietly soften the
disclosure.

### 14c.5 — Safety-contracts parity guard

`src/lib/ai/prompts/__tests__/safety-contracts-parity.test.ts` —
229 test cases covering:

- Every EN ground rule has a non-empty translation per locale
- No non-EN body is verbatim-EN (placeholder-bug guard)
- Sentinel literals identical across all six locales
- GLP-1 brand list identical across all six locales
- Contract enums identical across all six locales
- Every parser_critical rule declares ≥1 must_contain token
- Every locale exports non-empty defer-phrase list + reply-language
  directive

During parity wiring, GR-13 (dailybriefing schema) gained
`must_contain` tokens (`dailyBriefing`, `keyFindings`, `sourceWindow`,
`sourceMetric`) — it was parser_critical but missing the pin.

## Test summary

| Suite | Tests | Status |
|---|---|---|
| `safety-contracts-parity.test.ts` | 229 | passed |
| `coach-prompt-locale.test.ts` | 52 | passed |
| `refusal-probe.test.ts` | 273 | passed |
| `system-prompt.test.ts` (existing) | 17 | passed |
| `maintainership-banner.test.tsx` | 6 | passed |
| Full unit suite | 3371 | passed (1 skipped) |

Typecheck clean. ESLint clean.

## Touch-disjoint status

Files modified by W14c:

- New: `src/lib/ai/prompts/safety-contracts.*.yaml` (6)
- New: `src/lib/ai/prompts/safety-contracts.ts`
- New: `src/lib/ai/prompts/native-prompts.ts`
- New: `src/lib/ai/prompts/__tests__/refusal-probe.test.ts`
- New: `src/lib/ai/prompts/__tests__/coach-prompt-locale.test.ts`
- New: `src/lib/ai/prompts/__tests__/safety-contracts-parity.test.ts`
- Modified: `src/lib/ai/coach/system-prompt.ts`
- Modified: `src/lib/ai/prompts/insight-generator.ts`
- Modified: `src/components/i18n/__tests__/maintainership-banner.test.tsx`
- Modified: `messages/{en,de,fr,es,it,pl}.json` (banner notice only)

No overlap with W16b (workouts), W17b+c (Withings / prisma /
reminder-worker). Other agents committed their work between mine
without conflicts.

## Flags / follow-ups

- **DE matrix is unused at runtime.** The DE locale keeps its
  hand-curated COACH_PROMPT_DE / SYSTEM_PROMPT_DE bodies; the DE rows
  in the matrix serve only the parity test today. A later release can
  fold DE into the matrix once the FR/ES/IT/PL bodies have lived in
  production for a cycle. The two-year-stable DE body is the
  calibration reference; we deliberately do not disturb it in v1.4.25.
- **Polish gender-aware Pan/Pani deferred to v1.4.26.** The matrix
  body uses neutral "Pan/Pani" forms throughout. The research
  recommendation for per-turn `<userContext gender="m|f|null"/>` is
  out of scope here — capturing it in v1426-backlog.
- **Refusal-probe is structural, not behavioural.** The 1680+
  adversarial assertions verify the matrix's structural integrity and
  prompt-assembly path — they do NOT invoke an LLM. The optional
  follow-up (per the research §5.2) is a nightly scheduled job that
  runs a small subset against the live provider for behavioural
  validation. Deferred to a later release; CI coverage stays
  structural for v1.4.25.
- **GitHub issue-template link** points at the existing
  `?template=translation.md` URL from W9e. If Marc creates a dedicated
  Coach-regression template, the constant in
  `maintainership-banner.tsx` is the single point of update.
- **PROMPT_VERSION** stayed at `4.25.0`. Native-prompt rollout is an
  assembly change, not a behavioural ratchet on the EN body — the
  version pin doesn't bump.
