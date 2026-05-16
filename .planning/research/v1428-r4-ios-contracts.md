---
file: .planning/research/v1428-r4-ios-contracts.md
purpose: R4 iOS-contract verification — every API + DTO + Prisma field reachable from the iOS client, checked against the v1.4.28 diff
created: 2026-05-16
contributor: R4 iOS-contract
---

# R4 iOS-contract review — v1.4.28

## Scope

Read-only review of every commit on `develop` since the `v1.4.27` tag,
filtered to the API + Prisma + Zod surface the iOS native client at
`/Users/marc/Projects/healthlog-iOS/` consumes. Cross-references
against the locked-contracts pack at `.planning/v15-ios-handoff/`
(03-api-contracts, 04-data-model, 08-locked-contracts).

The v1.4.28 R1.4 inventory pre-product (`v1428-r1-ios-contracts.md`)
was not on disk at review time — this reviewer enumerated the iOS-
consumed surface directly from the Swift sources and the v1.5 handoff
pack.

`git diff v1.4.27..HEAD --stat -- src/app/api/ prisma/ src/lib/validations/`
returns seven entries across six files; the iOS-facing slice is small.
No `prisma/schema.prisma` diff, no enum diff, no migration.

---

## Severity-grouped findings

### Critical (iOS contract breaking — release-blocker)

None.

### High

None.

### Medium

**M-1 — `/api/measurements` aggregate branch returns a divergent row
shape.** The diff at `src/app/api/measurements/route.ts` introduces a
server-side bucket path that fires when the caller supplies BOTH
`from` AND `to` AND the requested `aggregate` grain is `daily` or
`weekly` (or the window is wide enough that `pickAggregateGrain` picks
one). In that branch the response row carries
`{ type, value, measuredAt, count }` — no `id`, no `userId`, no
`source`, no `glucoseContext`, no `externalId`, no `createdAt`, no
`updatedAt`. The iOS `MeasurementWireDTO` codes the omitted fields as
optional, so the decoder would not crash, but the rows would be
unidentifiable and an attempt to `delete(id:)` or `update(id:,patch:)`
afterwards would target an empty string.

**Net iOS exposure: zero.** `MeasurementsRepository.recent(limit:)`
calls `/api/measurements` with `("limit", String(limit))` only — no
`from`, no `to`. iOS lands in the unchanged raw branch and reads
`{ measurements, meta: { total, limit, offset } }` byte-stable against
v1.4.27. The aggregate branch is a web-only path (used by
`recharts`-backed dashboard tiles).

Flagged Medium rather than Low because the divergent shape under one
endpoint is a future-proofing risk — if iOS ever adopts `from`/`to`
range queries via `/api/measurements` (instead of the dedicated
`/api/measurements/series`), the implementer will likely assume one
schema. Recommend the server team document the branched shape in
`docs/api/openapi.yaml` and add a Zod-strict response schema entry.

### Low

**L-1 — `aggregate` query param is undocumented in
`03-api-contracts.md` § Measurements.** The handoff pack reads
`listMeasurementsSchema` with the v1.4.25 shape (no `aggregate` key,
`limit` cap at 500). v1.4.28 lifts `limit` to 5000 when a windowed
read is in play and adds `aggregate: "raw"|"daily"|"weekly"`. Both are
additive (optional, default-preserving), so no iOS code path breaks,
but the contract pack should be re-tagged at v1.4.28 once the release
ships. No release-blocker.

**L-2 — `PATCH /api/measurements/[id]` adds 409 `errorCode:
"measurement.duplicate_timestamp"`.** Additive. iOS error-envelope
table already maps 409 to "Refresh state and retry once" — the new
`errorCode` slot is an opt-in detail that iOS reads via the existing
`error.meta.errorCode` pathway. Surface a localised toast in a future
iOS release; no blocker today.

**L-3 — `aggregate` enum naming uses the lowercase token convention
already locked by GROUND RULE 11 (severity enums) but the iOS Swift
side has no consumer yet.** Mention only.

---

## Endpoint-by-endpoint verification

| Endpoint | v1.4.28 diff | iOS consumer | Wire-shape impact |
|---|---|---|---|
| `PATCH /api/measurements/[id]` | + 409 path on Prisma `P2002` | `MeasurementsRepository.update(id:patch:)` returns `MeasurementWireDTO` | 200 happy path unchanged — same `apiSuccess(measurement)`. 422 unchanged. New 409 is additive with `errorCode`; iOS treats any 409 as retriable per the error table. **No break.** |
| `GET /api/measurements` | + optional `aggregate` query param, + raised `limit` cap from 500 → 5000, + server-side bucket branch when `from && to && grain !== "raw"` | `MeasurementsRepository.recent(limit:)` calls with `limit` only (no `from`/`to`) | Raw branch byte-stable. Aggregate branch never reachable from iOS at v1.4.28. **No break.** (See M-1 for future-proofing.) |
| `GET /api/measurements/[id]` | untouched in v1.4.28 | — | n/a |
| `GET /api/measurements/series` | untouched | `MeasurementsRepository.series(kind:days:)` | n/a |
| `POST /api/measurements` | untouched | `MeasurementsRepository.create` | n/a |
| `POST /api/measurements/batch` | untouched | `MeasurementBatchUploader` | n/a |
| `DELETE /api/measurements/by-external-ids` | untouched | `MeasurementsRepository.deleteByExternalIDs` | n/a |
| `POST /api/medications/[id]/intake` (FB-E1 NEEDS-MIGRATION) | endpoint + `intakeSchema` untouched; only the web `<IntakeHistoryList>` mount retired | `MedicationsRepository.recordIntake(medicationID:body:)` | **Byte-stable.** iOS continues to POST + GET the paginated history per `PaginatedIntakeEnvelope`. Endpoint stays live. |
| `GET /api/medications/[id]/glp1` (FB-E2 NEEDS-MIGRATION) | endpoint untouched; only the web `<InventorySection>` mount retired | `MedicationsRepository.glp1Details(medicationID:)` returns `Glp1DetailsDTO` with `inventory: Glp1InventoryDTO?` | **Byte-stable.** `Glp1InventoryDTO` slot on the GET response is unaffected — the chore commits removed only web mounts under `src/app/medications/...`. iOS still reads `pensRemaining`, `dosesRemaining`, `weeksOfSupply`, `lowStock`. |
| `POST /api/medications/[id]/glp1` | untouched | n/a (iOS does not POST today) | n/a |
| `POST /api/insights/generate` (FB-J2 NEEDS-MIGRATION) | comment-only diff (GROUND RULE renumber: 14 → 13 in source comments; the `weeklyReport`-block-mention comment retired). No behaviour change | `DashboardRepository.regenerateInsights()` POSTs here for the hero strip 24h SWR refresh | **Byte-stable.** Endpoint stays live. iOS's `AIInsightResponse` decoder is unaffected (the iOS model never referenced `weeklyReport`). |
| `GET /api/insights/cards` | untouched | iOS reads via the comprehensive payload | n/a |
| `GET /api/insights/comprehensive` | untouched | `DashboardRepository.comprehensive(window:)` decodes `ComprehensiveDigest` | n/a |
| `POST /api/insights/chat` (Coach SSE) | untouched | iOS Coach repository | n/a |
| `GET /api/dashboard/glp1` | **route file deleted (203 LoC)** | grep confirms zero iOS callers — `DashboardRepository.swift` calls `/api/dashboard/summary` + `/api/dashboard/widgets` only | **No break.** Endpoint was server-rendered for the web tile only. |
| `GET /api/dashboard/summary` | untouched | `DashboardRepository.summary()` | n/a |
| `GET/PUT /api/dashboard/widgets` | untouched | `DashboardRepository.widgets()` / `saveWidgets` | n/a |
| `POST /api/internal/web-vitals` | **new route** | n/a — internal beacon, no auth, web-only client | additive, no iOS reach |
| `GET /api/analytics` | untouched in iOS scope (the `summaries` sub-page type shim under `src/types/analytics.ts` is web-internal) | iOS reads `data.healthScore` from this payload | n/a |
| `POST /api/auth/*`, `GET /api/auth/me/*` | untouched | iOS auth + profile flows | n/a |
| `POST /api/workouts/batch`, `POST /api/workouts/*` | untouched | iOS `WorkoutsBatchUploader` | n/a |
| `GET /api/notifications/*`, devices, APNs | untouched | iOS push enrolment | n/a |
| `GET /api/personal-records` | untouched | iOS personal-records reader | n/a |
| `GET /api/withings/*` | untouched | iOS opens connect URL in SFSafariViewController | n/a |
| `GET /api/version`, `GET /api/health` | untouched | iOS Settings → diagnostics | n/a |

---

## Prisma + Zod diff verification

### Prisma

```
$ git diff v1.4.27..HEAD --stat -- prisma/
(no output)
```

No schema diff. No migration. No column add, rename, drop, type change.
Every Prisma field the iOS client reads — `Measurement.{ id, userId,
type, value, measuredAt, notes, source, glucoseContext, externalId,
createdAt, updatedAt }`, `Medication.{ id, name, dose, treatmentClass,
dosesPerUnit, category, active, notificationsEnabled, schedules,
lastTakenAt, todayEventCount }`, `MedicationIntake.{ id, medicationId,
scheduledAt, scheduledFor, takenAt, status, snoozedUntil, skipped,
injectionSite }`, `MedicationInventoryItem.{ dosesTotal, printedExpiry,
purchasedAt, markAsFirstUseAt, markAsUsedUp, notes }`, `User.{ id,
username, email, role, heightCm, dateOfBirth, gender, timezone,
glucoseUnit, sourcePriorityJson, researchModeAcknowledgedVersion,
onboardingCompletedAt, onboardingTourCompleted, lastReportPracticeName,
insightsPrivacyMode }`, `Workout.{ id, source, externalId, sportType,
startedAt, endedAt, ...batch fields }`, `PersonalRecord.{ id,
metricType, direction, value, unit, achievedAt, previousBest }`,
`AuditLog.action` — is byte-stable.

### Zod

```
$ git diff v1.4.27..HEAD --stat -- src/lib/validations/
src/lib/validations/measurement.ts  | 10 +-
```

Single file. Two additive lines:

1. `limit` cap raised `500` → `5000` on `listMeasurementsSchema`. The
   cap is a server-side max; the iOS client passes `limit=50` or
   `limit=400` and is unaffected.
2. New optional `aggregate: z.enum(["raw","daily","weekly"]).optional()`
   on `listMeasurementsSchema`. Optional + no `.default()` — clients
   omitting it (every iOS path today) preserve the v1.4.27 behaviour.

Both modifications are strictly additive on the request side. The
response shape is also byte-stable in the iOS-reachable branch (raw).

No diff to `auth.ts`, `medication.ts`, `coach-prefs.ts`,
`source-priority.ts`, `workout.ts`, `notifications.ts`,
`recommendation-feedback.ts`, `backup.ts`, `doctor-report-prefs.ts`,
`onboarding.ts`. Every locked iOS-facing Zod schema is byte-stable.

---

## NEEDS-MIGRATION items per kickoff prompt

| ID | Endpoint stays live? | Wire shape stays byte-stable? | Web mount retired? | Verdict |
|---|---|---|---|---|
| FB-E1 — `GET /api/medications/[id]/intake` | yes | yes | yes (`<IntakeHistoryList>` removed in `8c81af10`) | **Safe.** iOS continues to read the paginated envelope. |
| FB-E2 — `GET /api/medications/[id]/glp1` | yes | yes (`Glp1InventoryDTO` slot preserved on the response) | yes (`<InventorySection>` removed in `8c8d6dc2`) | **Safe.** |
| FB-J2 — `POST /api/insights/generate` | yes | yes (comment-only diff) | n/a (the web "Insights aktualisieren" affordance was retired as part of FB-J1 in `52edf85f`; the route itself still serves the hero strip + iOS Daily Briefing) | **Safe.** |

---

## Cross-checks

- **Locked GROUND RULES 1-15** (`08-locked-contracts.md` § 1) — all
  safety-contract YAML files untouched in the v1.4.28 diff
  (`git diff v1.4.27..HEAD --stat -- src/lib/ai/prompts/ | grep safety-contracts`
  is empty). PROMPT_VERSION sentinel: not regressed.
- **Batch endpoint contracts** (`08-locked-contracts.md` § 2) —
  `/api/measurements/batch` + `/api/workouts/batch` untouched. The
  500-row cap, 60/min rate limit, idempotency window all unchanged.
- **OpenAPI 3.1 hard-flip** (`08-locked-contracts.md` § 3) — the new
  `aggregate` query param + the lifted `limit` cap are not yet
  reflected in `docs/api/openapi.yaml`. Recommend the release closure
  step run `pnpm openapi:check` and absorb the regenerated YAML into
  the same commit as the route change (CI's hard-fail gate on
  `openapi-drift` will catch the omission anyway).
- **Source-priority two-axis** (§ 4) — `sourcePriorityJson` column
  name untouched. `pickCanonicalSource()` path untouched.
- **RESEARCH_MODE_DISCLAIMER_VERSION byte-compare** (§ 6) — the
  constant in `src/lib/medications/glp1-pk.ts` is untouched; the
  research-mode acknowledgment endpoint is untouched.
- **Withings webhook path-segment secret** (§ 8) — untouched.
- **Refusal-probe matrix** (§ 7) — six YAML files untouched.

---

## Summary — go/no-go for the iOS contract

**GO.** No iOS-breaking change lands in the v1.4.28 diff against
v1.4.27. Every endpoint the iOS native client reads or writes is
either untouched or strictly additive (new optional query param, new
optional 409 path, new optional `errorCode` slot). The retired
`/api/dashboard/glp1` route has zero iOS callers (confirmed by grep
across `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/`). The
deleted `weeklyReport` schema slot has zero iOS references. The
divergent shape under the new aggregate-branch on `/api/measurements`
is unreachable from any iOS code path today.

Two follow-ups for the release pipeline, neither a blocker:

1. **OpenAPI regen.** `pnpm openapi:check` should ship the new
   `aggregate` enum + raised `limit` bound into `docs/api/openapi.yaml`
   in the same commit, or the iOS Swift codegen consumer drifts.
2. **Handoff pack version bump.** The v1.5 handoff pack reads
   `version_anchor: v1.4.25` on every locked-contract page; the new
   `aggregate` + `limit` + duplicate-timestamp 409 should be folded
   into a v1.4.28 retag of `03-api-contracts.md` § Measurements
   (additive paragraph, not a rewrite).

iOS contract conformance: **clean**.

---

## Tally

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 (future-proofing only — aggregate-branch divergent shape) |
| Low | 3 (handoff-pack retag, 409 errorCode opt-in, aggregate enum doc) |
| **Total** | **4** |

iOS-breaking change: **no.** Release verdict: **go.**
