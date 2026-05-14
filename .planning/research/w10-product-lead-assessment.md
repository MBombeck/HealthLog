# v1.4.25 — Product-Lead Strategic Assessment

Author: Product-Lead (W10 multi-agent QA leg)
Date: 2026-05-14
Status: read-only strategic memo. Same shape as
`phase-W6-v1423-product-lead-review.md` — the v1.4.25 update of
the foundation-release / iOS-readiness pair. Audience: Marc-three-
weeks-from-now and the parallel Claude session that will own the
iOS Swift app. The question this memo answers: **did v1.4.25 land
a tree where v1.5 is "five days of iOS Swift work against locked
contracts" and not "two more weeks of server schema churn while
the iOS app waits"?**

---

## A. State of the app after v1.4.24 → v1.4.25

The v1.4.20/v1.4.22/v1.4.23 three-beat pattern — loud → polish →
foundation — collapsed into a single release this time. 134
commits over six days. **v1.4.25 is loud, polish, and foundation
at once.** It ships GLP-1 as a first-class therapy class (W4d),
polishes every UX surface that had carried regressions or rough
edges (W3 / W5 / W6 / W8), widens the foundation under v1.5
another half-step (W7 per-user-timezone, W8c source-priority
two-axis, W8d Apple Health server-prep wave for Workouts /
PersonalRecords / VO2 / Audio / Daylight, W9e four AI-initial
locales), and ships the Health Score provenance UI (W8e) that
the v1.4.20 score has wanted since launch.

The release also pulls in **every cheap-win that had been sitting
in the v1.4.26 backlog**. Marc's directive 2026-05-14 to vorziehen
the cheap Withings work landed as W5c (legacy meastypes 12 / 35 /
71 / 123, BP+temp webhook subscription dropping BP latency from
~1h to seconds) and W5d (full coverage of meastypes 5 / 8 / 76 /
91 / 155 / 170, seven new MeasurementType enum values, OAuth scope
upgrade to `user.activity` with reconnect banner). The Activity-
sync routine itself stays parked at v1.4.26 because it carries a
user-impact OAuth-reconnect dance that warrants a dedicated
rollout window.

**Test count progression: 2223 → 2627 unit (+404), ~140 → 174
integration.** The biggest single delta in any v1.4.x cycle —
larger than v1.4.20's 100-test bump and v1.4.23's 114-test bump
combined. Three drivers: W4d shipped 60+ tests on GLP-1, W8c
shipped 22 unit + 4 integration tests on the two-axis source
picker, and W8d shipped 29 tests on the Apple Health server-prep
wave. Every wave came with its own quality-gate evidence in its
phase report.

**PROMPT_VERSION ratchet: 4.24.0 → 4.25.0.** Two new numbered
ground rules — GROUND RULE 9 ("no GLP-1 dose prescription, ever")
on the Coach prompt and GROUND RULE 14 (matching constraint on
the insight generator). One-step bump because the persona didn't
move, only the GLP-1 safety contract widened.

**Quality gates at the moment of this memo:** typecheck clean,
lint clean, `pnpm test` 2627 passed / 1 skipped / 0 failed across
294 test files, `npx prisma validate` clean, migrations 0043
through 0054 applied. The pre-existing 16-failure coach-snapshot
enum-drift block from the parallel-agent merge resolution at
`98f7d11` is gone — the suite is fully back in sync with the live
enum.

**Tech-debt named in v1.4.23 memo:** the Insights "9-surface
orchestrator" item is substantially resolved in W4 (mother page
is now overview-only; metric depth lives on seven new sub-pages —
the v1.5 P5 plan needs an update). OpenAPI registry coverage gap
still carries; the v1.4.23 §A.6 promise to flip the drift-gate to
hard-fail in v1.4.24 slipped — flipping it is now v1.4.26 work.
Coolify auto-deploy still needs the maintainer toggle (host-side
SSH-retag fallback verified in W11b). Pearson incomplete-beta
replacement still queued.

**Two new tech-debt items added in v1.4.25:** 414 dead i18n keys
in `messages/en.json` (W10 research surfaced this; W7e race-
deferred the cleanup behind W9e's locale-bundle work); and the
W9e Coach + insight system-prompts in FR / ES / IT / PL ride the
EN body with a REPLY LANGUAGE footer — works well, preserves the
safety contract verbatim, but native bodies in each language want
doing for v1.4.26 polish.

---

## B. Is v1.4.25 release-ready?

**Yes.** Each of the five orchestrator checks:

1. **All implementation waves committed.** W7c/d/e (W7e shipped
   5 of 10 Cat-A dead-code items; the rest race-deferred). W8
   (icon-heading parity, Coach-Feedback layout-shift, mobile WCAG
   2.5.5 touch-target sweep). W8c (two-axis source priority,
   `deviceType` column on Measurement). W8d (audio-exposure +
   time-in-daylight enum values, Workout + WorkoutRoute +
   PersonalRecord schemas — *more* than the brief asked for).
   W8e (Health Score provenance accordion across all six locales).
   W9e (FR/ES/IT/PL with MaintainershipBanner). W9f folded into
   W8d.1. All ten waves landed.

2. **All quality gates green.** Typecheck, lint, 2627 unit /
   174 integration, prisma validate, openapi:check. The 16
   pre-existing coach-snapshot failures resolved cleanly.

3. **Demo + production deploy paths intact.** W11b verified
   v1.4.24 on the demo host with GHCR-pinned compose; v1.4.25
   redeploy is the W12 wave (only the image tag needs the bump
   from `1.4.24` to `1.4.25`). Host-side SSH-retag fallback
   documented and tested.

4. **Test count progression healthy.** +404 unit / +34
   integration — largest single-cycle delta in the v1.4.x line.
   No feature shipped test-naked.

5. **Translation coverage acceptable.** The MaintainershipBanner
   caveat is explicit and well-handled — FR/ES/IT/PL ship with
   common-vocab translations of ~30-40 % of strings plus full
   placeholder protection; the remainder falls through to EN and
   the banner advertises this with a link to the GitHub feedback
   template. The i18n integrity test (auto-discovers every
   locale; W9d) is green across all six.

**Concerning regressions: zero on shipped surfaces.** The seven
new MeasurementType enum values are strictly additive. The
two-axis source-priority schema (W8c) preserves W5e backward
compatibility — flat shapes still parse, nested merges over flat,
defaults backfill the rest. The PersonalRecord schema lands
without a detection worker (by design; the GET endpoint returns
empty until v1.4.26). The handoff's three known-open-risks (16
coach-snapshot failures, measurements-batch-delete dup-constraint,
W8b conflict-resolution verification) are all resolved per their
phase reports.

---

## C. iOS-readiness — locked-contract surface

The v1.4.23 memo §C said v1.5 P1 is now "a five-day iOS Swift
sprint against locked contracts". v1.4.25 widens that promise.
Every contract the iOS-Claude session might want to call against
is in code today, behind a versioned route, with at least one
test and at least one entry in the regenerated OpenAPI spec.

**Locked server contracts after v1.4.25:**

1. **HK identifier mapping** — `apple-health-mapping.ts` is now 12
   mapped quantity types (W8d.2 added audio-exposure + headphone +
   time-in-daylight on top of v1.4.23 W2's nine). The
   `HK_QUANTITY_TYPE_DEFERRED` set documents iOS-17/18 long-tail
   identifiers with planned-release windows inline.
2. **Batch-ingest endpoint** — `POST /api/measurements/batch` now
   accepts the W8c-added optional `deviceType` field (canonical
   values `watch | band | ring | phone | scale | other |
   unknown`). Per-entry status reporting unchanged.
3. **Source-priority Two-Axis** — `User.sourcePriorityJson`
   accepts both W5e flat and W8c nested shapes;
   `pickCanonicalSource()` walks source then device-type ladders
   with single-axis legacy-NULL fallback. GET-side contract
   unchanged; iOS does not expose the priority editor in v1.5.
4. **OpenAPI 3.1 spec** — regenerates byte-stable from
   `src/lib/openapi/routes.ts`. v1.4.25 expanded the registry to
   cover `AppleHealthBatchEntry.deviceType` and the personal-
   records GET route. **Drift gate still warn-only** — the
   v1.4.26 hard-flip remains the v1.4.23-named follow-up.
5. **APNs scaffolding** — unchanged since v1.4.23 W3. Provider
   singleton per gateway, JWT auto-rotation, permanent-failure
   cleanup, dispatcher cascade with `channelPriority()`, cross-
   user-hijack guard.
6. **Deletion-sync endpoint** — `DELETE /api/measurements/by-
external-ids` shipped in W4b. Accepts HKSample UUID list; honours
   HealthKit deletions.
7. **Workout / WorkoutRoute schema** — Migration 0053 + the
   `validations/workout.ts` Zod boundary. 20-member sport-type
   string-union, GeoJSON LineString in JSONB. **Ingest endpoint
   itself is v1.4.26 scope** — iOS can serialise against the
   locked shape but cannot POST workouts until v1.4.26.
8. **PersonalRecord schema** — Migration 0054 + direction helper
   + `GET /api/personal-records`. **Detection worker is v1.4.26
   scope** — table returns empty until then.
9. **GROUND RULE 9 dose-refusal in Coach prompts** —
   PROMPT_VERSION 4.25.0 carries the refusal in both EN and DE
   bodies; FR/ES/IT/PL ride the EN body via the REPLY LANGUAGE
   footer, so the safety contract reaches every shipped locale.

**Does anything an iOS-Claude session would request in v1.5
require a server-side schema change?** No, as far as the v1.4.23
+ v1.4.25 cross-reference can tell. Nine of the v1.4.23 §C's 13
iOS DTO questions are resolved in current schema (Q1 source
rename, Q2 externalId, Q3 sleepStage, Q4 no-pre-conversion,
Q5 park-for-retry, Q6 APNs hex-join, Q7 sandbox-vs-production,
Q12 X-Device-Id, Q13 401-after-delete bounce); the remaining four
(Q8 token-rotation cadence, Q9 multi-device cascade, Q10
collapseId shape, Q11 device-list channel rendering) are all
iOS-side UX decisions, not server-side schema decisions.

**One open server-side gap that the iOS session might surface,
not requiring schema change:** the Workout/PR ingest endpoints
(deferred to v1.4.26). If the iOS team wants to ship workout
sync before v1.4.26, the endpoint can be added without a schema
migration — table + Zod boundary are already there.

**Cross-reference with `phase-W6-v1423-product-lead-review.md`:**
the §C plan is intact. P1 unchanged. P2 unchanged scope-wise (5
days) with a sharpening: W8c's `deviceType` field means P2's
`HealthKitService.swift` can tag each ingested sample with the
HKDevice.model translation. P3 unchanged. P4 unchanged. P5's
Insights page split that v1.4.23 noted as "blocked on Apple
Health DATA, not Apple Health SCHEMA" is **partially delivered
ahead of schedule** — W4 split the mother page into 7 sub-pages.
P5's remaining work is the Vitals tile row + HRV / sleep
correlations + sleep-debt panel.

---

## D. What did NOT get done that the user expected?

Cross-referenced against `.planning/v1425-handoff.md`. Six waves
promised: W8, W9e, W10, W11, W12, W13.

**Delivered as promised:** W8, W8b conflict-cleanup verification,
W9e (with W9f hot-fix addendum), W10 dead-code research (the
actual cleanup landed in W7e with 5 Cat-A items, remaining 5 plus
the 414 i18n keys deferred to v1.4.26 per the W7e phase-report
epitaph), W11b demo redeploy of v1.4.24 (v1.4.25 redeploy is the
W12 wave that happens after Marc tags). W11, W12, W13 are post-tag
waves and intentionally not yet executed.

**Delivered with scope-cut and explicit deferral:**
- W7e Cat-A items 6-10 (BASE_SYSTEM_PROMPT, INSIGHTS_SYSTEM_PROMPT,
  two `@deprecated` markers, the `targets/route.ts:807` comment).
  Race-deferred because of W9e's parallel locale-bundle edits.
- 414 dead i18n keys — deferred to v1.4.26 for the same reason.
- Hand-review of FR / ES / IT / PL prose — explicitly deferred.
- Native FR / ES / IT / PL Coach system-prompt bodies — deferred.

**Not done by design:**
- Onboarding rebuild — Marc-promoted from v1.5 to v1.4.26.
- Withings Activity sync routine — parked at v1.4.26 because of
  user-impact OAuth-reconnect rollout.
- PersonalRecord detection worker — explicit v1.4.26 scope.

**Research-not-implemented inventory:** of the 12 files in
`.planning/research/`, the four iOS strategic files
(`apple-health-ecosystem-scan`, `apple-health-sync-deep-dive`,
`open-wearables-comparison`, `withings-plus-comparison`) are v1.5
strategic input; the remaining eight all map to a v1.4.25 wave
that implemented them. No research file went unread.

---

## E. What got more done than expected?

Marc's directive that "alle v1.4.26-cheap-wins in v1.4.25
vorgezogen" was honoured beyond the original promise. Beyond the
W5c/W5d Withings work named above:

- **W6c doctor-report toggles** — per-section UI, mood default
  OFF + server filter, hide-when-empty, Migration 0045. Was a
  v1.4.24 "nice to have"; landed clean.
- **W7 + W7b per-user timezone Option B** — ten surfaces touched
  including the MoodEntry.tz column (Migration 0044). Was on the
  "v1.4.25 or v1.5" decision tree; landed entirely in v1.4.25.
- **W7d dev-server-repair** — Tailwind v4 color-mix parser crash
  (`782731a`) and force-static private-field crash (`15d9183`).
  Neither was on any backlog; both would have stolen time on the
  v1.5 iOS-Claude session if left to fester.
- **W7e dead-code cleanup** — five Cat-A items dropped, each
  removing dead-weight from surfaces the v1.5 iOS contract
  references.
- **W8d AH-server-prep wave** — three brand-new schema tables
  (Workout, WorkoutRoute, PersonalRecord) plus a VO2-max
  dashboard tile. None on the original handoff §2 list. This is
  the wave that does the most to widen the iOS contract surface
  beyond what v1.4.23 froze, and the wave most likely invisible
  to a casual user (table exists but no worker; VO2 tile opt-in).

v1.4.25 is materially larger than v1.4.23 by every measure
(commit count, test count, schema-migration count, new-endpoint
count) AND honours its strategic role. The doubled-up shape held
without compromising quality gates.

---

## F. iOS-readiness rating: 9 / 10

v1.4.23 was a 7/10 — foundation contracts shipped, but warn-only
OpenAPI gate and a hand-wavy "iOS-Claude session will discover
what's missing" trust gap. v1.4.25 closes the gap on every
dimension v1.4.23 §C asked for:

- **Schema** — Workout + WorkoutRoute + PersonalRecord land
  before iOS needs them; `deviceType` column lands so iOS can
  ship HKDevice.model tags from day zero; source-priority honours
  both source AND device-type axes.
- **Contracts** — batch endpoint learned `deviceType`;
  `/api/personal-records` exists; deletion-sync endpoint exists.
- **AI safety** — PROMPT_VERSION 4.25.0 with GROUND RULE 9
  reaches every shipped locale.
- **Polish** — every surface the iOS app will mirror (Insights
  sub-pages, Dashboard tiles, Coach drawer, Health Score with
  provenance, Targets redesign) is in its post-polish shape.

The single point off perfect is the **OpenAPI drift gate still
warn-only**. v1.4.23 §A.6 said "flip to hard-fail in v1.4.24";
v1.4.25 did not. The iOS DTO codegen needs hard-fail to be
confident a route signature change can't silently land. v1.4.26
must flip this gate. Otherwise the first DTO regen that breaks
the iOS build will be a downstream surprise.

A 10/10 would have required either the OpenAPI hard-flip landing
in v1.4.25 or the Workout/PR ingest endpoints not being deferred.
Both are well-reasoned scope cuts — neither blocks v1.5 P1
(login + dashboard + widget); both block v1.5 P2-onwards.

---

## G. Biggest pre-tag risk (one sentence)

The OpenAPI drift gate is still warn-only, so a route signature
change between v1.4.25 tag and the first iOS DTO codegen against
the spec lands clean today and only surfaces when the iOS build
breaks downstream.

---

## H. v1.4.26 backlog priority

Re-ordered by strategic value (highest first):

1. **Onboarding rebuild** (Marc-promoted from v1.5). v1.4.25 is
   the last release where new users see the v1.4.20-era
   onboarding that doesn't reflect the v1.4.21-onward feature
   surface. The iOS launch multiplies onboarding traffic.
   Sized M-L.

2. **OpenAPI drift-gate hard-fail flip + registry coverage
   completion.** Strategic blocker for iOS DTO codegen
   confidence. The 5468 → 880 coverage gap closes in parallel;
   the gate flips the moment coverage exceeds the legacy
   surface. Sized M.

3. **Withings Activity sync routine.** OAuth scope upgrade
   shipped in W5d with the reconnect banner; the sync wave
   itself is a small follow-up but needs a user-impact rollout
   plan because the reconnect banner must reach every Withings
   user before sync writes new rows. Sized S-M.

4. **PersonalRecord detection worker.** Schema landed in W8d;
   the worker (sweep-on-insert + nightly cron) is the smallest
   thing that turns the table from "empty for everyone" into a
   real product feature. Sized M.

5. **Workout ingest endpoint** (`POST /api/measurements/batch?kind=workout`).
   Unblocks iOS workout sync without requiring a v1.5 schema
   migration. Sized S (Zod boundary + table already in code).

6. **Native FR / ES / IT / PL Coach + insight system-prompts.**
   v1.4.25 ships these locales riding the EN body with a REPLY
   LANGUAGE footer; native bodies let each safety rule speak in
   its target voice. Sized M per locale.

7. **Dead-code cleanup completion** — W7e race-deferred 5 Cat-A
   items + the 414 dead i18n keys (top-200 batch). Pure hygiene.
   Sized S.

**Additional carry-overs worth pulling forward (lower priority):**
Pearson incomplete-beta replacement (v1.4.23 carryover; auto-
discovery surfaces in v1.5/v1.6 will want the rigorous statistic).
VO2 max chart row to match the W8d tile. Sentinel parser
observability for HealthKit envelopes (extend the W5 H1
`SentinelParseResult.malformedEntries[]` pattern before P3
PROMPT_VERSION 5.0.0 emits HealthKit envelopes).

---

## I. Candid one-liner

v1.4.25 wrote the comma between the v1.4.x line and v1.5 — every
iOS contract is locked in code, every deferred item has an
epitaph, every test passed, the 414 dead i18n keys are a hygiene
chore and not a release blocker, and the only honest pre-tag
risk is the OpenAPI drift gate Marc already named in the v1.4.23
memo and chose to defer one more release. **Tag it.**
