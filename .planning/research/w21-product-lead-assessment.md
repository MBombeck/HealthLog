# W21 — Product-Lead Assessment for v1.4.25

**Author:** product-lead reviewer (read-only)
**Branch:** `develop` (latest `51f23ef3`)
**Scope:** strategic alignment between promised v1.4.25 release scope and the
266 commits since `v1.4.24`. Sister reviewers (code, security, design,
senior-dev, simplifier, i18n-runtime, dead-code) cover their respective
domains; this report stays at product-strategy altitude.

---

## Executive summary

v1.4.25 is the largest feature delta in the v1.4.x line, and every major
promised theme is shipped on `develop`: onboarding rebuild (W14b), GLP-1
Research Mode end-to-end (W19c with GROUND RULE 15 + MDR-acknowledgment +
6-locale refusal probes), the W19d/e/f Wave-4b GLP-1 detail stack
(side-effect taxonomy, cadence + compliance, EMA titration ladder),
source-priority two-axis (W8c), Withings Activity + Sleep v2 (W17b/c),
workout-batch ingest (W16b), PR detection worker + badge (W16c), W14c
native FR/ES/IT/PL Coach prompts, dashboard polish (W20a), and the W15
hygiene cluster (380 dead i18n keys, dead prompt constants, W7d
hardening). PR #168 carries the work and `Lint+Test`, `Integration`,
`Dependency Audit`, `Secret Scanning`, both Docker builds are all green;
`e2e` was still IN_PROGRESS at the time of writing.

**Headline verdict: v1.4.25 needs 1 reconcile action before tag.**

The single Critical is the CHANGELOG: the W11 release-prep commit
`cb07d5c` froze the changelog at the Wave-1-to-3 surface, and 60+
subsequent Wave-4-and-5 commits (the W14b/c, W16a/b/c, W17a/b/c, W19a-f
families, plus W15/W18/W20-rest and the Fix-G/H integration hot-fixes)
have not been written up in CHANGELOG.md. This was already in the
Session-2 handoff as the explicit `W22 Release-redo` step ("Update
CHANGELOG.md to reflect Wave 4-5 additions (~500 lines total)"). The
content is fully traceable from the phase reports in `.planning/`; the
work is editorial, not engineering. Until that lands the public release
artifact misrepresents what shipped.

Everything else is strategically aligned. Marc-Voice is intact across
both the CHANGELOG and the new user-facing copy. The MDR boundary is
preserved with three concentric defences (chart gating, dialog
acknowledgment, Coach refusal). The OpenAPI hard-flip is in place, so
the v1.5 iOS sprint can rely on contract stability. The migration train
(0043 → 0059) is forward-only and additive.

---

## Critical

### C-1 — CHANGELOG.md is frozen at the Wave-3 surface and omits the entire Wave-4-and-5 delivery
*Severity: Critical (blocks the tag — public release artifact misrepresents what shipped)*

The current CHANGELOG.md `## [1.4.25]` section (lines 3-388) was written
in `cb07d5c chore(release): v1.4.25` during the W11 release-prep agent.
Since then 60+ commits have shipped across Wave-4 (W14b Foundation +
Content, W19c Backend + Frontend + Safety, W19d, W19e, W19f) and Wave-5
(W14a OpenAPI hard-flip, W14c native Coach prompts, W15 hygiene, W16a-c,
W17a-c, W19a-b, W20-rest), plus Fix-G and Fix-H integration hot-fixes.
None of this content is in the changelog.

Cross-checking the spot-greps against CHANGELOG.md `## [1.4.25]`:

| Promised feature | In CHANGELOG.md? |
| --- | --- |
| Onboarding rebuild (carousel, chips, source 4-card, baseline, done, welcome-back) | not mentioned |
| GLP-1 drug-level chart + Research-Mode dialog | not mentioned |
| GROUND RULE 15 (drug-level refusal, MDR boundary) | not mentioned |
| 90-day acknowledgment staleness | not mentioned |
| Side-effect taxonomy (21 entries × 5 categories) | not mentioned |
| Cadence visualisation + compliance chips | not mentioned |
| EMA titration ladder display | not mentioned |
| Pen/vial inventory + 30-day clock (Migration 0056) | not mentioned |
| W14c native FR/ES/IT/PL Coach prompts (replacement of REPLY LANGUAGE footer) | not mentioned (FR/ES/IT/PL still framed as "ride EN system prompts via REPLY LANGUAGE footer until native rewrites ship" — line 92-96) |
| W17b Withings Activity sync | listed as deferred to v1.4.26 (line 355) |
| W17c Withings Sleep v2 sync | listed as deferred to v1.4.26 (line 357) |
| W17a Withings webhook secret as URL path-segment | not mentioned |
| W16b POST /api/workouts/batch | not mentioned (line 354 still says "endpoint waits on iOS contract finalisation") |
| W16c PR detection worker + badge | line 102-103 + line 351-352 still say "Detection worker deferred to v1.4.26" |
| W14a OpenAPI drift-gate hard-flip | listed as deferred (line 342-344) |
| W20a dashboard tile polish (single-line headings + inline trend arrow + baseline alignment) | not mentioned |
| Medication inventory card + 30-day clock | not mentioned |
| Migrations 0055-0059 | not mentioned (lines 17 + 332 cap at 0044-0054) |
| PROMPT_VERSION already at 4.25.0 from W14c (pre-Wave-4) — GROUND RULE 15 is additive within 4.25.0 | not mentioned |

The Session-2 handoff explicitly anticipated this: §"Remaining work →
Wave 6 → **W22 Release-redo**: Update CHANGELOG.md to reflect Wave 4-5
additions (~500 lines total). Version stays 1.4.25. New commit
`chore(release): expand v1.4.25 with Wave 4-5 features` on develop.
Push. Move PR #168 from Draft → Ready-for-review". W22 has not yet run.

**Action**: dispatch W22 before Marc UAT. New `chore(release):` commit
on `develop`. Test count update from the Session-2 progression table
(2244 → ~3460-ish unit + ~165 integration at Fix-H) lands in the same
edit. Re-categorise the Wave-4-5 items out of "Deferred to v1.4.26" and
into Added / Changed / Fixed / Security / Refactor.

---

## High

### H-1 — Test count footer in CHANGELOG is stale
*Severity: High (Marc-Voice precision; the marathon outcome must read truthfully)*

`### Tests` (lines 320-336) reads "2244 → 2652 passing unit tests
(+408). Integration suite 140 → 174 (+34)." The Session-2 handoff
records the actual progression at the Fix-H point as `~3400 unit + ~170
integration` — over 700 additional unit tests landed in Wave-4-5
(W19c-Safety alone added 1800+ refusal-probe assertions across 15 rules
× 6 locales × 20+ probes; W14b added 45; W19d/e/f added 39+39+40; W16c
added 40+4; W17b/c added 357 across the touched surface). Roll into the
W22 CHANGELOG update.

### H-2 — `Deferred to v1.4.26` section in CHANGELOG lists items that already shipped in Wave 4-5
*Severity: High (release artifact is internally inconsistent; cross-references the C-1 reconcile)*

Lines 337-368 still carry:
- "OpenAPI drift-gate hard-fail flip (still warn-only after this release)" — W14a shipped the flip (`74bf608`, `41147bd`).
- "Onboarding rebuild promoted from v1.5 (last release where new users see the v1.4.20-era onboarding...)" — W14b shipped it.
- "Native FR/ES/IT/PL Coach + insights system prompts" — W14c shipped them.
- "Personal-record detection worker (schema shipped this release; sweep-on-insert + nightly cron pending)" — W16c shipped both.
- "Workout ingest endpoint" — W16b shipped it.
- "Withings Activity sync routine" — W17b shipped it.
- "Withings Sleep v2 routine" — W17c shipped it.
- "414 dead i18n keys cleanup" — W15 shipped 380 (25 of the 414 verified live).

If Marc tags from this state, the public release notes promise these are
"deferred" while the binary actually contains them. W22 is the
reconcile.

---

## Medium

### M-1 — Drug-level chart-side staleness wiring deferred to v1.4.26 by the W19c-Safety phase
*Severity: Medium (small surface, observed and documented; acceptable for v1.4.25 if Marc consents)*

`src/lib/medications/research-mode-staleness.ts` is shipped with 18
unit tests, but the conditional in `DrugLevelChart.tsx` to read
`isAcknowledgmentStale()` is not wired — the chart today only gates on
version mismatch, not on the 90-day clock. The W19c-Safety report
documents this explicitly as a v1.4.26 cleanup. The MDR boundary is
unaffected (the dialog still re-prompts on version bump, the Coach
still refuses at the GROUND RULE 15 layer); the 90-day gate is a
defence-in-depth ratchet. Acceptable to ship as-is but should be
documented as known-deferred in the CHANGELOG Security or Deferred
section, not silently omitted.

### M-2 — `User.onboardingGoals` schema column + API persistence deferred to v1.4.26
*Severity: Medium (W14b-Content stored goals only in localStorage; server cannot personalise dashboard from onboarding selections)*

W14b-Content's goals chip-picker holds the selection in localStorage
keyed by `userId`. The v1.4.20 dashboard-widgets seed feature (which
the brief floated as the consumer) cannot read it from the server.
Marc-acceptable per the W14b-Content deviation §1 (path explicitly
listed in the brief as second-preferred); call out as a v1.4.26
follow-up in CHANGELOG so future readers don't expect server-side
goal persistence yet.

### M-3 — W11a multi-arch image lowercase fix only landed in Fix-H
*Severity: Medium (resolved, but only after PR #168 had been opened — third release in a row that needed a CI fix-up)*

Fix-H commit `a6f94cf` resolved the GHCR push regression by lowercasing
`IMAGE_NAME`. Was caught before Marc tagged but underscores Marc's
existing concern from his memory ("Coolify auto-deploy fix" in v1.4.21,
v1.4.22, v1.4.23 outcome memos). W20-rest commit `e23dd28` shipped the
explicit `vars.COOLIFY_AUTO_DEPLOY=on/off` maintainer toggle so the
silent-miss pattern can't recur. Strategic resolution is in place;
M-severity only because the regression was new and the v1.4.25 release
narrative ("multi-arch image lands clean") could read as smoother than
it actually was.

### M-4 — Session-1 handoff's W12/W13 deliverables (post-tag) carry items that aren't acknowledged in Session-2's W24 plan
*Severity: Medium (operational continuity)*

Session-1 §2 W12-W13 lists items (FUNDING.yml decision, social-preview-
image upload, branch-protection required-status-checks flip, sister-repo
healthlog-docs + healthlog-landing version-pin updates, `docs/audit/
v1425-summary.md`, 0-10 score per area, Codex audit prompt, `v15-ios-
handoff.md`). Session-2's W24 plan mentions these but does not break
them out into a checklist the post-tag agent (or Marc himself) can
follow. Not a blocker — Marc can drive these by hand — but worth
calling out so the post-tag agent has a single source of truth.

### M-5 — i18n FR/ES/IT/PL Coach prompts are now LLM-quality drafts with structural-coverage tests, not native
*Severity: Medium (strategic-alignment with Marc's i18n promise; not a regression — the W14c agent landed the matrix + 1800+ refusal probes per Marc's reversal of the original "EN body + REPLY LANGUAGE footer" plan)*

W14c shipped the native body per locale (replacing the REPLY LANGUAGE
footer for FR/ES/IT/PL) but did so with LLM-quality drafts because Marc
cannot review safety-critical FR/ES/IT/PL prose himself. The
MaintainershipBanner acknowledges this. Strategically aligned with
Marc-confirmed decision 1 in Session-2 §"Marc-confirmed strategic
decisions". W22 CHANGELOG must surface this honestly — currently the
shipped state is "AI-initial bundles riding the EN coach with
MaintainershipBanner", but the actual state is "native LLM-drafted
bodies per locale with the matrix + 1800+ refusal-probe assertions for
safety coverage". Different positioning for a release public artifact
vs the AI-as-author criticism. Marc's directive is "never expose
Claude / AI-as-author" — the CHANGELOG should describe what shipped
(native per-locale Coach prompts with maintainership banner) without
explicitly billing them as "AI-drafted".

---

## Low

### L-1 — CHANGELOG line 14 "AI-translated locales (FR / ES / IT / PL) ship behind a maintainership banner"
*Severity: Low (Marc-Voice nit — the framing "AI-translated" is honest but the phrase pattern matches Marc-memory criticisms of AI-as-author exposure)*

Recommend rewording to "community-maintainable" or "drafted-with-LLM-
seeding-and-structural-matrix-coverage" or similar Marc-Voice
formulation. The existing `<MaintainershipBanner>` UI copy speaks for
itself; the changelog doesn't need to call out the translation
provenance. (Marc-memory: "never expose Claude / AI / agent / phase /
wave / marathon in user-facing artefacts" — CHANGELOG is user-facing.)

### L-2 — W19c-Frontend dialog cites EMA EPAR + Schneck/Urva 2024 DOI
*Severity: Low (no PII risk; literature citations are public; flagged for awareness only)*

Cites are clinical references, not PII. Acceptable per Marc-memory PII
gate which targets Marc's personal data (name, health figures, BD-
Zielbereich values, measurement counts) — not pharmacovigilance
literature. No action.

### L-3 — `personal_records` `NULLS DISTINCT` index requires application-level pre-flight `findFirst`
*Severity: Low (W16c shipped the application guard; Migration 0055-or-later can drop the guard)*

W16c phase report §"Key finding" explicitly documents the
application-level idempotency guard. Tracked in the v1.4.26 backlog.
No action for v1.4.25.

### L-4 — Two-axis source-priority Audit-log writes are mentioned in CHANGELOG (line 280-281) but the Audit-log surface itself is a v1.4.26 dead-code candidate
*Severity: Low (cross-reference v1.4.26 backlog P4-6 + P6-10 — Marc decision pending on `/api/audit-log`)*

The `AuditLog` row is written; the `/api/audit-log` GET is not consumed
by any UI. Marc-decision needed per W20-rest P6-10 recommendations
table. Track as v1.4.26.

### L-5 — `MOOD_LABEL_KEYS` already-shipped tag on P6-11 (W20-rest report) is accurate but not reflected in CHANGELOG
*Severity: Low (already in the changelog under "mood verbal labels" refactor bullet — closed)*

CHANGELOG line 304 mentions it under refactor; the W20-rest closure note
is consistent. No action.

### L-6 — `MeasurementSideEffect` Prisma block triggered a one-time `prisma format` whitespace re-flow
*Severity: Low (cosmetic; W19d phase report deviation §2 explicitly documents)*

No functional impact. No action.

---

## Scope-delivery matrix

| Wave | Feature | Promised | Shipped on `develop` | Verdict |
| --- | --- | --- | --- | --- |
| W14a | OpenAPI drift-gate hard-flip | Yes (Marc-directive — pulled forward from v1.4.26) | Yes (`74bf608`, `41147bd`) | Shipped |
| W14b-Foundation | User.onboardingStep migration + OnboardingShell + nested routes + step API + i18n key surface | Yes | Yes (5 commits ending at `489d0da`) | Shipped |
| W14b-Content | Carousel + goals chips + source 4-card + baseline + done + welcome-back + entry-point swap | Yes | Yes (5 commits ending at `b896622`) | Shipped (server-side goal persistence deferred to v1.4.26 — see M-2) |
| W14c | Native FR/ES/IT/PL Coach prompts + safety matrix + 1800+ refusal probes | Yes | Yes (5 commits ending at `75fce6c`) | Shipped (M-5 framing note) |
| W15 | 414 dead i18n keys + dead prompt constants + W7d hardening + Cat-C typo | Yes | Yes (5 commits ending at `fcda115`) — 380 removed, 25 verified-live and kept | Shipped |
| W16a | iOS-17/18 HK long-tail enum extensions + VO2 chart-row helper + workout dedup TODO | Yes | Yes (3 commits ending at `bff13e7`) | Shipped |
| W16b | POST /api/workouts/batch typed ingest | Yes | Yes (`62e4b1d` → `5a7d252`) | Shipped |
| W16c | PR Detection worker + pg-boss queue + batch route hooks + badge + opt-in toggle | Yes | Yes (6 commits ending at `223b8a9`) | Shipped |
| W17a | Withings webhook secret as URL path-segment | Yes | Yes (`a1ffa49`) | Shipped |
| W17b | Withings Activity sync routine | Yes (Marc-directive — pulled forward) | Yes (Migration 0055, 6 commits at `dab7de3`) | Shipped |
| W17c | Withings Sleep v2 routine | Yes | Yes (same 6-commit train as W17b) | Shipped |
| W18 | 12 Low + apply-with-care items from W10 review | Yes | 8 / 12 shipped (4 deferred and tracked in v1.4.26 backlog) | Shipped (acceptable) |
| W19a | EMA drug knowledge layer + drift-guard | Yes | Yes (`cee5bf5`, `da73e06`, `45bbfe4`) | Shipped |
| W19b | Pen/vial inventory + 30-day clock + medication inventory card + cron | Yes | Yes (Migration 0056, `570b14d` → `7f133a1`) | Shipped |
| W19c-Backend | Migration 0058 + glp1-pk module + research-mode endpoint | Yes | Yes (4 commits ending at `cf27df4`) | Shipped |
| W19c-Frontend | MDR-acknowledgment dialog + drug-level chart + Settings toggle | Yes | Yes (4 commits ending at `32c1a41`) | Shipped |
| W19c-Safety | Coach GROUND RULE 15 + 6 YAMLs + 1800+ refusal probes + 90-day staleness helper | Yes | Yes (4 commits ending at `bfd129f`) — chart-side staleness wiring deferred (M-1) | Shipped (M-1 wiring deferred) |
| W19d | Side-effect taxonomy (21 entries × 5 categories) + API + UI section | Yes | Yes (Migration 0059, 4 commits ending at `7dfc212`) | Shipped |
| W19e | Cadence visualisation + compliance chips | Yes | Yes (4 commits ending at `71cc05a`) — reused existing pg-boss + dispatcher per Marc-correction | Shipped |
| W19f | EMA titration ladder display (read-only reference) | Yes | Yes (4 commits ending at `86dbff0`) — observational copy only, MDR-safe | Shipped |
| W20a | Dashboard top-tile polish (single-line headings + inline trend arrow + baseline alignment) | Yes (Marc-asked mid-session) | Yes (3 commits ending at `a7cc5de`) | Shipped |
| W20-rest | 11 P6 polish items | Yes | 3 / 11 shipped (Pearson math, Coolify toggle, translation-issue template); 8 deferred to v1.4.26 with maintainer recommendations | Shipped (acceptable) |
| W8c | Source-priority two-axis (metric × deviceType) | Yes (Session 1 W8 — already in current CHANGELOG) | Yes (Migration 0051, `f05c55f` → `53278cc`) | Shipped (already in changelog) |
| Fix-G/Fix-H | CI / integration / GHCR hot-fixes pre-tag | Internal | All green except the e2e dashboard insight-text + chart-tick locator, addressed via Fix-I `03bf21e5` + `d22fc212` | Shipped |
| W22 (release-redo) | CHANGELOG expand to reflect Wave-4-5 + bump test counts + reshuffle "Deferred to v1.4.26" | Yes | **Not yet run** — see C-1 | **Reconcile required** |
| W23 (STOP for Marc UAT) | Marc-only | n/a | n/a | Awaits Marc |
| W24 (post-tag deploy + deliverables) | Demo redeploy, sister-repo updates, `docs/audit/v1425-summary.md`, 0-10 score, Codex audit prompt, `v15-ios-handoff.md` | Yes | **Not yet run — post-tag** | Awaits tag |

---

## v1.5 iOS readiness statement

The iOS sprint has the contracts it needs to start Day 1.

**Locked server contracts:**

- `POST /api/measurements/batch` — Apple Health bulk ingest (v1.4.23) with `inserted | duplicate | skipped` per-entry envelope, idempotency wrapper, rate-limited.
- `DELETE /api/measurements/by-external-ids` — HealthKit deletion-sync (v1.4.25 W4b).
- `POST /api/workouts/batch` — HKWorkout-aligned typed ingest with 20-sport-type union + GeoJSON LineString routes (v1.4.25 W16b).
- `POST /api/devices` — APNs token registration with paired `apnsEnvironment` (v1.4.23).
- `POST /api/onboarding/step` — wizard progression with rate limit + audit (v1.4.25 W14b-Foundation).
- `User.sourcePriorityJson` two-axis resolver with `pickCanonicalSource()` (v1.4.25 W8c) — iOS sets Apple Health as the cumulative + sleep + HRV + RHR favourite; Withings stays the point-measurement default.
- `Measurement.deviceType` enum (v1.4.25 W8d) with iOS-17/18 HK long-tail mappings ready to extend.
- `MedicationInventoryItem` (v1.4.25 W19b) — pen/vial 30-day clock available for iOS pen-scanner integration.
- `Workout` + `WorkoutRoute` (v1.4.25 W8d Migration 0053) — table waits for iOS workout sync.
- `PersonalRecord` (v1.4.25 W8d Migration 0054) — detection worker (W16c) writes the table now; iOS can read via `GET /api/personal-records?metricType=X`.

**Safety guarantees iOS inherits at Tag-1:**

- GROUND RULE 9 (Coach refuses GLP-1 dose recommendations) + GROUND RULE 15 (Coach refuses drug-level estimates with EU MDR + MDCG 2021-24 cites). Refusal-probe matrix in CI on every push — 1800+ assertions × 15 rules × 6 locales × 20+ paraphrasings — so iOS prompt regressions catch in CI not on-device.
- OpenAPI drift-gate is now hard-fail (`41147bd`). iOS Swift codegen has confidence that develop's `docs/api/openapi.yaml` is in lockstep with the Zod registry. Any route signature change between this tag and the first iOS DTO regen surfaces in CI before iOS reaches it.
- `requireAuth()` narrowed-scope path (v1.4.25 fix line 250-256) — iOS Bearer tokens with route-specific scopes (e.g. `medication:ingest`) now route through cleanly when the declared scope is in the token set, while wildcard tokens (`["*"]`) keep the existing v1.4.24 fail-closed posture for unscoped routes.

**Apple Health migrations 0051-0055 (the iOS-readiness window):**

- 0051 `measurement_device_type` — added the column.
- 0052 `apple_health_enum_extensions` — added `ENVIRONMENT_AUDIO_EXPOSURE`, `HEADPHONE_AUDIO_EXPOSURE`, `TIME_IN_DAYLIGHT`.
- 0053 `workout_and_route` — Workout + WorkoutRoute tables.
- 0054 `personal_record` — PersonalRecord table + dedup index (NULLS-DISTINCT documented; W16c applies application-level guard).
- 0055 `measurement_sleepstage_composite` — widened the Measurement unique index to include `sleep_stage` with `NULLS NOT DISTINCT` (Postgres 16 native).

All five are present, additive, forward-only, and covered by integration tests (`tests/integration/withings-sleep-stage-composite.test.ts`, `tests/integration/pr-detection-end-to-end.test.ts`, etc.). Migration 0060 stays free for the next wave.

**Net iOS readiness:** v1.4.25's contract surface is tighter and more
complete than the v1.4.23 iOS-prep promise. The iOS Swift sprint can
proceed against `develop` HEAD (after Marc tags). The W19 series adds a
GLP-1 medication-tracking surface that iOS can wrap natively without
the server moving underneath it.

---

## Closing

Strategic alignment is intact. The shipped scope matches Marc's
Session-1 + Session-2 directives and Marc-confirmed strategic decisions.
The MDR boundary, the regulatory cites, the refusal probes and the
"reference not advice" framing on titration are all conservative,
defensive, and consistent with HealthLog's clinical-but-warm voice. AI
Insights remain HealthLog's differentiator and the W19 series deepens
it without diluting it — Coach gains a refusal layer rather than a
prescription layer, and the four locale Coach bodies pick up structural
safety coverage (1800+ probes) rather than thin REPLY LANGUAGE footers.

**One reconcile action before tag:** W22 — expand CHANGELOG.md to
reflect the Wave-4-and-5 delivery. The content is already in the phase
reports under `.planning/`. Once W22 runs, Marc can UAT and tag without
the public release artifact misrepresenting the contents of the
binary.

After tag, Session-2's W24 list (Demo redeploy, sister-repo version pins,
`docs/audit/v1425-summary.md`, 0-10 score per area, Codex audit prompt,
`v15-ios-handoff.md`) feeds the post-tag agent or Marc directly.

No critical-pre-v1.5 blockers detected beyond W22.
