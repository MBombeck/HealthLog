# W14c Native FR/ES/IT/PL Coach Prompts — Safety Research

Author: Research pass commissioned 2026-05-14 for v1.4.25 W14c
("native FR/ES/IT/PL Coach + Insights system prompts").
Scope: should we replace the v1.4.25 W9e English-prompt + REPLY
LANGUAGE footer with hand-written native bodies for FR / ES / IT /
PL, and if so, how do we preserve every safety contract verbatim?
Status: read-only research. No source files are modified.

---

## Section 1 — Current state (W9e REPLY LANGUAGE footer)

The W9e mechanism, shipped earlier this v1.4.25 cycle, keeps two
hand-written system-prompt bodies and a one-line footer table:

- **`src/lib/ai/coach/system-prompt.ts`** — the AI Coach prompt.
  `COACH_PROMPT_EN` (lines 26–229, ~200 lines) is the calibrated EN
  body; `COACH_PROMPT_DE` (lines 231–450) is the parallel hand-curated
  DE body. `LOCALE_REPLY_FOOTER` (lines 466–471) is a four-row table
  mapping `fr | es | it | pl` to a single English sentence telling the
  model to reply in that language. `getCoachSystemPrompt()` glues
  `COACH_PROMPT_EN + LOCALE_REPLY_FOOTER[locale]` for the four
  AI-initial locales (file lines 473–487).
- **`src/lib/ai/prompts/insight-generator.ts`** — the Insights JSON
  generator prompt. Same shape: `SYSTEM_PROMPT_EN` (lines 32–349,
  ~320 lines) + `SYSTEM_PROMPT_DE` (lines 351–688) + four-row
  `INSIGHTS_LOCALE_REPLY_FOOTER` (lines 700–708). The same
  `buildSystemPromptWithReferences()` helper (lines 734–791) appends
  a SOURCES block; the AI-initial branch uses the EN source titles
  because the citation IDs (not the titles) are the contract.

The footer is a pragmatic patch. Both files carry block comments
explaining why (system-prompt.ts:452–465; insight-generator.ts:690–
699): every safety contract — GROUND RULE 1 (zero hallucinations),
GROUND RULE 9 (no dose prescription), evidence-block sentinel
`---KEYVALUES---/---END---`, the out-of-scope refusal payload, the
JSON OUTPUT FORMAT schema — has been calibrated against the EN body,
and rewriting all of that into four more languages would force
re-validation of every contract per locale. The DE body has been
hand-curated for two years and is the one non-English version that
has been audited rule-by-rule against EN.

`MAINTAINED_LOCALES` in `src/lib/i18n/config.ts:22` flags this state
to the user: only `de | en` are project-owner-maintained; FR / ES /
IT / PL surface a `<MaintainershipBanner>` in the auth shell.

W14c is the proposal to retire the footer for FR / ES / IT / PL and
ship four hand-curated native bodies that match the DE level of
care.

## Section 2 — Safety contracts that must be preserved

Walking the EN prompts top-down, the following clauses are
patient-safety relevant and have to survive translation 1:1. They
are the diff-review surface for any native rewrite.

**Coach prompt (`coach/system-prompt.ts:26–229`):**

1. **Role bound** (lines 26–32): "not their doctor", "don't
   diagnose, prescribe, or change medication", "warm, curious,
   conservative". Test pin `system-prompt.test.ts:38–44`.
2. **GROUND RULE 1 — Prose-first** (lines 38–41). 60–180 word cap.
3. **GROUND RULE 2 — Values in evidence block** (lines 43–47). The
   `---KEYVALUES---/---END---` sentinel format is **contract-level**;
   the route parser at `src/app/api/coach/...` reads these literal
   sentinels. Translating them breaks the parser. Test pin
   `system-prompt.test.ts:71–76`.
4. **GROUND RULE 3 — Missing data is an invitation** (lines 49–53).
   "Always pivot." Test pin `system-prompt.test.ts:79–88` asserts
   the exercise-pivot example survives translation.
5. **GROUND RULE 4 — Conservative phrasing** (lines 55–61).
   "consider", "if it feels right" preferred over "you should"; any
   action-relevant finding closes with "walk through with your
   doctor".
6. **GROUND RULE 5 — Motivational-interviewing micro-moves**
   (lines 63–67). One per turn, not stacked.
7. **GROUND RULE 6 — Off-topic redirect** (lines 69–72). One warm
   sentence + stop; no lecturing.
8. **GROUND RULE 7 — Ground every number in SNAPSHOT** (lines
   74–77). No extrapolation, no "people like you", no risk scores.
9. **GROUND RULE 8 — No internal metric identifiers in prose**
   (lines 79–97). `BLOOD_PRESSURE_SYS` etc must not appear in
   user-facing strings. The window vocabulary
   `last7days/last30days/last90days/allTime` stays — contract token.
   Test pin `system-prompt.test.ts:60`.
10. **GROUND RULE 9 — Dose refusal (SAFETY)** (lines 99–122). The
    most safety-critical clause. Lists the seven GLP-1 brand names
    (Mounjaro, Ozempic, Wegovy, Zepbound, Trulicity, Saxenda,
    Rybelsus) and bans "increase to X mg", "skip a dose", "stop"
    answers. Pattern given verbatim: "Dose changes are a
    conversation for your prescribing doctor…".
11. **DAY-LEVEL READINGS — USE THE TIMELINE** (lines 124–143). The
    `timeline.recent` / `timeline.weekly` field names are
    contract-level. Test pin `system-prompt.test.ts:63–68`.
12. **EVIDENCE BLOCK contract** (lines 145–170). 8-line cap, unit
    vocabulary (`mmHg, kg, bpm, /5, %`), window vocabulary,
    sentinel literals.
13. **Tone-calibration `<example>` few-shots** (lines 172–224). The
    `<example>…</example>` XML tags are recognised by the model as
    delimited examples — they must stay literal English XML.

**Insight-generator prompt (`prompts/insight-generator.ts:32–349`):**

Fourteen GROUND RULES — superset of the Coach rules, plus
output-schema mechanics. Most safety-critical clauses:

1. **GROUND RULE 9 (Insights) — Storyboard annotations: never invent
   events** (lines 157–176).
2. **GROUND RULE 14 — Dose refusal (W4d, SAFETY)** (lines 213–227)
   — the Insights-side mirror of Coach GROUND RULE 9. Same seven
   GLP-1 brands, same "Worth mentioning at the next visit" pattern.
3. **Out-of-scope refusal payload** (lines 42–55) — a verbatim JSON
   blob. Exported as `OUT_OF_SCOPE_REFUSAL_EN/DE` (lines 798–812),
   pinned by tests for shape equality. A native rewrite needs
   `OUT_OF_SCOPE_REFUSAL_FR/ES/IT/PL` constants too.
4. **JSON OUTPUT FORMAT schema** (lines 247–323). Severity values
   (`info / suggestion / important / urgent`), `sourceWindow`,
   `sourceMetric`, `topic` enums — these are **English contract
   keys the parser reads** and must stay in lowercase English in
   every native body. The W9e footer is explicit about this
   ("severity / sourceWindow / sourceMetric / topic enum values
   stay in lowercase English exactly as listed in OUTPUT FORMAT —
   those are contract keys, NOT translations.").

Together: ~17 safety-relevant clauses, two parser-contract sentinel
formats, one JSON schema, one out-of-scope refusal payload.

## Section 3 — Translation methodology options (A/B/C/D)

### Option A — Full native rewrite per locale

Hand-write FR / ES / IT / PL bodies of comparable length and care
to the DE body. Every clause translated; contract enums kept in EN
exactly as the EN→DE prompt already does.

- **Pros:** Highest user-perceived quality. Prompt reads natively;
  the model never has to "code-switch" from EN instructions to a
  non-EN reply. Aligns with research finding that **English safety
  alignment does NOT transfer to other languages automatically** —
  Welo Data 2025-12 measured up to 25 pp refusal-rate degradation
  on translated-to-low-resource pairs and 4–5× for the worst cases,
  and recommends "implement cross-lingual safety calibration … don't
  rely on English guardrails to transfer automatically" [Welo
  2025-12]. The EMNLP 2025 survey [arxiv:2505.24119] reinforces:
  "model teams cannot rely on English safety alignment to infer
  global safety", and Vicuna's Bengali harmlessness score collapsed
  to 18.4% vs 69.3% average — a 50 pp gap on a closely-watched
  metric. FR / ES / IT are high-resource Indo-European, so the
  expected gap is much smaller than Bengali — but it's non-zero.
- **Cons:** Maintenance burden. Every future ratchet (W4d added
  GROUND RULE 14, W5b added GROUND RULE 13, W9e added the
  reply-language plumbing) must be hand-translated four extra
  times. Without a safety-contract matrix (Section 5), regressions
  are silent. The translation itself is non-trivial — Marc speaks
  DE + EN natively but would have to either trust a translator or
  use an LLM-assisted draft then expert-review.
- **Diff-review surface:** ~200 lines × 4 locales = 800 new lines of
  Coach prompt body, ~320 × 4 = 1280 new lines of Insights prompt
  body. Roughly 2 000 lines under safety review.

### Option B — Hybrid: native persona/style + EN safety contracts

Native body for persona / tone / examples; keep the numbered GROUND
RULES, the EVIDENCE BLOCK format, the OUTPUT FORMAT schema, and
GROUND RULE 9/14 (dose refusal) **verbatim in EN inside the native
body**.

- **Pros:** Safety contracts stay calibration-stable — they remain
  the exact strings tested by `system-prompt.test.ts`. Maintenance:
  ratchets to GROUND RULES land in EN once and propagate. The model
  reading mixed-language system prompts is well-precedented in the
  literature and Anthropic's prompting guidance treats clear
  delimited instruction blocks (XML tags, ALL-CAPS section headers)
  as first-class structure regardless of surrounding language.
- **Cons:** The user-perceived gain over W9e is small — the persona
  paragraph and a few examples are native, but a model reading
  GROUND RULES in EN may itself drift toward responding in EN
  ("language adherence" regression). The current W9e footer already
  mitigates this with an explicit "REPLY LANGUAGE: respond in X"
  clause, which a hybrid body could lose if the EN safety block
  ends before the reply-language directive. Tonally inconsistent:
  user-facing localisation pitched as "we wrote real native prompts"
  but half the prompt is EN.
- **Diff-review surface:** ~80 lines × 4 locales for the native
  persona + examples = 320 lines.

### Option C — Native paraphrase + EN-authoritative fallback clause

Full native rewrite, but with a tail clause: "If you encounter any
ambiguity in the safety rules above, the English versions in the
project's coach-prompt-en.ts are authoritative; defer to the
stricter interpretation."

- **Pros:** A belt-and-braces meta-safety net.
- **Cons:** Relies on the model honouring a meta-instruction that
  references a file it cannot see. Frontier LLMs handle this kind
  of clause inconsistently — and **the literature is clear that
  language-routed prompts only behave when the instruction is in
  the same language and modality as the answer**. The clause is
  more reassurance than mechanism. Combines Option A's maintenance
  cost with Option B's tonal mix, without the simplicity of either.

### Option D — Status quo (defer to v1.5+)

Keep the W9e REPLY LANGUAGE footer. Document that FR / ES / IT / PL
ride on the EN system prompt + a footer and let the
`<MaintainershipBanner>` cover user expectations.

- **Pros:** Zero diff-review surface. Aligns with the existing
  `MAINTAINED_LOCALES = { de, en }` policy. Marc's directive at the
  v1.4.25 marathon kickoff explicitly framed FR / ES / IT / PL as
  "AI-initial locales" — bringing them under the same hand-curation
  standard as DE is a major commitment.
- **Cons:** Marc's 2026-05-14 directive explicitly asks for native
  prompts in v1.4.25. Option D rejects the directive. The footer
  also degrades subtly on long Coach conversations — model attention
  to a one-line footer dilutes as the turn count grows, and
  EN-prompt-with-FR-reply has been observed [Welo 2025-12] to fall
  back to EN under load.

## Section 4 — Per-locale considerations

**French (`fr`).**
Register: **vouvoiement** (`vous`). The medical-context default
across French health apps and Anthropic-language prompt corpora is
vouvoiement; tutoiement reads as a startup-Slack tone that clashes
with HealthLog's "warm but not casual" Coach persona. The W9e
footer says "mirror the user's register" but the EN body is
neutrally-pronouned ("you"), so the model has no clear French
default to mirror — it defaults to tutoiement in practice.
Recommendation for native rewrite: **vouvoiement throughout**,
with a single in-prompt clause "tutoyez si l'utilisateur tutoie en
premier". Medical vocab: lean clinical-but-explained — "votre
tension systolique" not "le chiffre du haut".

**Spanish (`es`).**
Register: peninsular **usted**. W9e already pinned peninsular over
Latin-American ("Spanish (peninsular preferred)"). Medical Spanish
defaults to **usted** in clinic-adjacent contexts (`Por favor,
indique su presión arterial`). Latin-American Spanish would skew
toward `tú` in many countries — peninsular `usted` is the broader
formal-register safe choice and matches the FR / IT / PL
formal-register direction. Vocab: "su presión sistólica", "su
mediana de 90 días".

**Italian (`it`).**
Register: **Lei** (formal, third-person feminine). The
fastitalianlearning.com B1 reference notes explicitly: "Medical
and official contexts require strict formal register: Lei pronouns,
conditional polite forms, and technical vocabulary." Verb form is
third-person singular ("Lei dovrebbe parlarne con il suo medico").
Italian also uses conditional politeness heavily — "potrebbe
considerare" not "consideri" — which matches the Coach's
"you might consider" GROUND RULE 4. Medical vocab:
"la sua pressione sistolica", "la sua mediana a 90 giorni".

**Polish (`pl`).**
Register: **Pan/Pani** (3rd-person, with male/female form). The W9e
footer already names this. Lingostories CEFR A2 reference confirms
formal imperatives in Polish use Pan/Pani forms ("proszę zmierzyć",
"niech Pan/Pani spojrzy"). The Coach should default to "Pan"
inflections **only when the user's profile gender is unknown** —
gender is in the profile (`profile.sex`), but the prompt does not
currently carry it. Recommendation: include a per-turn
`<userContext gender="m|f|null"/>` block alongside the SNAPSHOT, and
have the prompt say "Use Pan when gender is male, Pani when female;
fall back to Pan/Pani when null." Vocab: "Pana/Pani ciśnienie
skurczowe".

A cross-cutting principle: HealthLog's target reader is a
**health-literate self-tracker**, not a clinician and not a
layperson with zero medical fluency. The DE body's vocabulary
choices (`Systole`, `Adhärenz`, `Titration`) are the calibration
target — clinical when there's no plain-language equivalent that
adds precision, explained inline when it's load-bearing. Apply
the same standard per locale: `Mounjaro`, `Ozempic`, `GLP-1`,
`titration` are international brand/clinical terms and stay; HRV,
adherence, percentile have native equivalents and should use them.

## Section 5 — Verification approach

The maintenance fear in Option A is real but solvable with two
pieces of tooling, both READ-ONLY for this research phase:

### 5.1 Safety-contract matrix file

Add `src/lib/ai/prompts/safety-contracts.{locale}.yaml` (one per
locale, six total). Each file holds the safety-relevant clauses
keyed by stable ID:

```yaml
# Example: src/lib/ai/prompts/safety-contracts.fr.yaml
ground_rule_1_zero_hallucination:
  en: "Every claim in \"summary\" must come from a number visible in the snapshot you were given."
  native: "Chaque affirmation dans \"summary\" doit provenir d'un nombre visible dans le snapshot fourni."
  parser_critical: false
  notes: "vouvoiement; medical register"

ground_rule_9_dose_refusal:
  en: "NEVER prescribe, recommend, or modify medication doses..."
  native: "NE prescrivez, recommandez ou modifiez JAMAIS de doses..."
  parser_critical: true   # SAFETY
  brand_names_preserved: [Mounjaro, Ozempic, Wegovy, Zepbound, Trulicity, Saxenda, Rybelsus]
  pattern_template: |
    "Les ajustements de dose sont une conversation pour votre médecin prescripteur — il connaît le reste de votre tableau clinique. Si c'est utile, je peux sortir comment se sont passées les dernières semaines pour que vous puissiez en parler au rendez-vous."

evidence_block_sentinel:
  en_literal: "---KEYVALUES---"
  native: "---KEYVALUES---"   # MUST stay literal — parser contract
  parser_critical: true
```

This gives:
- A single file per locale to diff-review when adding a GROUND RULE.
- An invariant that `parser_critical: true` rows MUST be EN-literal
  in every locale (the `---KEYVALUES---` sentinel; the JSON enum
  keys; the GLP-1 brand-name list).
- A buildtime check that every clause in EN has a row in every
  locale (CI fails if missing).

### 5.2 Refusal-probe regression test

Drop `src/lib/ai/coach/__tests__/safety-refusal-probe.test.ts`
that, for each of the six locales, sends the system prompt + a
dose-prescription user message through a deterministic stub model
and asserts:

1. The reply does NOT contain any of the seven GLP-1 brand names
   followed by an mg value (regex
   `(Mounjaro|Ozempic|Wegovy|Zepbound|Trulicity|Saxenda|Rybelsus)\s+\d+(\.\d+)?\s*mg`)
   when accompanied by a recommendation verb ("increase", "step
   up", "augmenter", "aumentare", "zwiększ").
2. The reply contains a defer-to-clinician phrase from a per-locale
   allow-list ("walk through with your doctor", "konsultiere",
   "parlez-en à votre médecin", "habla con tu médico", "ne parli
   col suo medico", "porozmawiaj z lekarzem").

The probe is structural — it does not depend on the model actually
generating the right answer; it checks that the system prompt
**carries** the refusal pattern in native. Combined with an
optional contract test that runs against the live provider in a
nightly scheduled job, this gives both deterministic CI coverage
and weekly real-model validation. Pattern is the same as the
existing `refusal.test.ts` in `src/lib/ai/coach/__tests__/`.

### 5.3 Tests that need port-forwarding per locale

`system-prompt.test.ts` currently has two `describe` blocks — EN
and DE. The Option-A rewrite adds four more, ~50 lines each, each
asserting:
- PROMPT_VERSION present (free — same const)
- Persona statement in native (regex check)
- GROUND RULES section header in native (e.g.
  `RÈGLES FONDAMENTALES`, `REGLAS BÁSICAS`, `REGOLE FONDAMENTALI`,
  `ZASADY PODSTAWOWE`)
- `<example>` few-shots present (count check, same as EN/DE)
- Evidence-block sentinels literal (must be `---KEYVALUES---`)
- `dailyBriefing` schema enums literal English

## Section 6 — Recommendation + rationale

**Recommendation: Option A (full native rewrite) for v1.4.25 W14c,
gated on the safety-contract matrix + refusal-probe test from
Section 5 landing FIRST as Section 5.1 + 5.2 sub-phases.**

Rationale:

1. **The empirical research says don't rely on EN guardrails.**
   Welo Data's 2025-12 cross-lingual safety study measured up to
   25 pp refusal-rate regression on translated prompts and
   recommends explicit per-language calibration. The arxiv 2025-05
   EMNLP survey calls English-only safety research a "growing
   language gap". W9e's footer is the kind of mitigation those
   papers describe as insufficient — a one-line directive in a
   different language than the safety contract itself.
2. **GROUND RULE 9 (dose refusal) is patient-safety critical.** A
   model that drops the refusal pattern under translation pressure
   is a real risk; a model with the refusal pattern in its own
   language won't drop it. Option B keeps the refusal in EN, which
   the research says is the worst of both worlds — the model has
   to switch contexts mid-prompt and may degrade the pattern.
3. **The maintenance burden becomes tractable with the
   safety-contract matrix.** Option A without the matrix is
   indefensible; Option A with the matrix is the same workload as
   the existing DE body. Marc has been maintaining DE rule-by-rule
   for two years — extending the discipline to four more locales
   with tooling support is a one-time investment.
4. **It matches Marc's stated direction.** The 2026-05-14 directive
   asks for "full native prompt bodies for FR/ES/IT/PL in v1.4.25."
   Option A is the literal reading; B/C/D all back off.

The gate is critical: **do not ship Option A without the matrix
and probe in place**. Without 5.1 + 5.2, a translation drift in,
say, the dose-refusal pattern would be invisible to CI and could
land in production. The plan is:

- **W14c.1** — land `safety-contracts.{de,en}.yaml` first, populated
  from the existing EN + DE bodies. CI invariant: every EN clause
  has a DE counterpart. (Validates the matrix shape against a body
  we already trust.)
- **W14c.2** — land the refusal-probe test against EN + DE. Wire
  it to the existing `__tests__/refusal.test.ts` infrastructure.
- **W14c.3** — author FR body. Populate `safety-contracts.fr.yaml`.
  Probe passes for FR.
- **W14c.4** — repeat for ES.
- **W14c.5** — repeat for IT.
- **W14c.6** — repeat for PL (with the gender-context addition
  flagged in Section 4 deferred to v1.4.26 if it adds scope).

Total estimated diff: ~2000 lines of prompt body, ~1000 lines of
matrix YAML, ~300 lines of new tests. Reviewable in a single PR
per locale.

## Section 7 — Open questions for Marc

1. **Is the maintenance gate (safety-contract matrix + refusal
   probe) acceptable as a prerequisite, or do you want to ship
   native bodies first and harden CI later?** The recommendation
   assumes you'd rather slow down for the gate; the alternative is
   to ship native bodies under the existing test pins (which would
   only check structural shape, not safety-clause-preservation).
2. **For Polish, do you want gender-aware Pan/Pani in v1.4.25 or
   deferred to v1.4.26?** Adds a `<userContext gender>` block to
   every Coach turn — small payload, but it's a contract change.
3. **`MAINTAINED_LOCALES` policy after W14c.** Once FR/ES/IT/PL
   have native prompts comparable to DE, are they "maintained"
   (banner off) or still AI-initial (banner stays for the rest of
   the localisation surface — homepage strings, settings labels)?
   The banner is currently locale-wide; this might need to split
   into per-surface flags.
4. **Translation-author trust model.** Are the FR/ES/IT/PL bodies
   authored by you, by an LLM-draft + expert-review, or by paid
   native speakers? The safety-contract matrix and the refusal
   probe protect against drift after authorship; they don't
   protect against an unfaithful initial translation. If the
   authorship is LLM-draft, recommend a second-pass review by a
   native speaker with medical-translation experience before
   merging the safety-critical rows.
5. **Out-of-scope refusal payload.** Adding `OUT_OF_SCOPE_REFUSAL_FR`
   etc adds four new exported constants and four new test pins. Do
   you want the refusal to render in the user's locale (matches
   the rest of the native prompt) or stay in EN as a contract-stable
   payload that the route can render any way? Recommend native.

---

## Cited sources

- **Welo Data, "The Hidden Flaw in LLM Safety: Translation as a
  Jailbreak"**, 2025-12-10. Source for the 25 pp refusal-rate
  regression measurement and the 4–5× worst-case multiplier; lists
  five mitigation priorities including "implement cross-lingual
  safety calibration" and "don't rely on English guardrails to
  transfer automatically".
  https://welodata.ai/2025/12/10/the-hidden-flaw-in-llm-safety-translation-as-a-jailbreak/
- **Schwartz et al., "The State of Multilingual LLM Safety
  Research: From Measuring The Language Gap…"**, EMNLP 2025
  (arxiv:2505.24119). Source for the English-only publication gap
  (5→83 between 2020 and 2024) and the Vicuna Bengali 18.4%
  harmlessness anomaly demonstrating that aggregate metrics mask
  per-language safety gaps.
  https://arxiv.org/html/2505.24119v1
- **DAMO-NLP-SG, "Multilingual Jailbreak Challenges in LLMs"**,
  ICLR 2024 (openreview vESNKdEMGp). Source for the framing of
  unintentional vs intentional multilingual safety regressions —
  unintentional ("the model genuinely doesn't know the safety
  rule in language X") vs intentional ("attacker translates the
  jailbreak to bypass EN filters"). Both apply to HealthLog.
- **Wang et al., "All Languages Matter: On the Multilingual Safety
  of LLMs"**, ACL Findings 2024
  (aclanthology.org/2024.findings-acl.349). Source for the
  "translate the original monolingual safety data into the other
  languages" methodology HealthLog's safety-contract matrix
  borrows from.
- **Meta AI, Llama Guard 3 / 4 model cards**. Source for the
  industry pattern of training safety classifiers per-language
  rather than relying on translation:
  "All the models are multilingual–for text-only prompts" with the
  ML Commons taxonomy compiled separately per language. Reinforces
  that EN-safety-prompt + non-EN-reply is not the production
  standard.
  https://www.llama.com/docs/model-cards-and-prompt-formats/llama-guard-3/
- **CultureGuard / Llama-3.1-Nemotron-Safety-Guard-8B-v3**
  (arxiv:2508.01710). Source for the "culturally-aware" extension
  to multilingual safety: even an excellent translation can miss
  the local way of asking the same unsafe question.
- **Lingostories Polish CEFR A2 grammar — Imperative**. Source for
  the Pan/Pani imperative pattern in formal Polish.
  https://www.lingostories.app/pl/grammar/a2/imperative
- **FastItalianLearning B1 register exercise**. Source for the
  Italian formal-register convention in medical contexts: "Lei
  pronouns, conditional polite forms, and technical vocabulary".
  https://fastitalianlearning.com/learn/b1/registro-formale-informale/exercise/08-registro-formale-informale
- **Reddit r/French formality-thread**, 2025-12. Anecdotal source
  for the modern French register split: vouvoiement default in
  professional / medical contexts, tutoiement only after explicit
  invitation. Used to confirm the "vouvoiement throughout" default.
  https://www.reddit.com/r/French/comments/1pcmfn1/

## Internal references (file paths cited)

- `src/lib/ai/coach/system-prompt.ts` (entire file; lines 26–229
  EN body, 231–450 DE body, 466–471 footer, 473–487 dispatch).
- `src/lib/ai/prompts/insight-generator.ts` (entire file; lines
  32–349 EN body, 351–688 DE body, 700–708 footer, 715–719
  dispatch, 798–812 refusal payloads).
- `src/lib/ai/coach/__tests__/system-prompt.test.ts` (existing test
  shape for EN + DE; W14c extends to FR/ES/IT/PL).
- `src/lib/ai/coach/__tests__/refusal.test.ts` (existing refusal
  test; W14c.2 extends with cross-locale safety probe).
- `src/lib/i18n/config.ts:1–26` (`Locale` union,
  `MAINTAINED_LOCALES` set, `isMaintainedLocale` predicate that
  drives the `<MaintainershipBanner>` visibility).
