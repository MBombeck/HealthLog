# v1.7.0 — Senior/Staff review (architecture + migration safety)

Scope: `git diff main..release/v1.7.0`. READ-ONLY. Branch `release/v1.7.0`.

## Summary counts

- Critical: 0
- High: 1
- Medium: 2
- Low: 3
- Info / verified-clean: 8

## High

### H1 — Detail-page compliance NOT flipped onto the canonical engine (stale path; reintroduces the v1.6.0-fixed divergence)

`src/app/api/medications/[id]/cadence/route.ts:98-114`

The v1.7.0 SB-SCHED-2 "Option B delegation" added an optional `engineCtx`
parameter to `expandScheduleSlots` / `buildCadenceTimeline` /
`computeNextDose` so compliance reads route through the canonical recurrence
engine (`occurrencesBetween`) for RRULE / rolling / cyclic / one-shot / PRN
schedules. The **dashboard/intake** path was wired (`src/lib/analytics/compliance.ts:404-436`
builds and threads `engineCtx`). But the **medication detail page** route
calls all three helpers with `userTz` only and no `engineCtx`:

```
const timeline = buildCadenceTimeline(med.schedules, events, asOf, windowDays, anchor, userTz);
const chips    = complianceChips(med.schedules, events, asOf, windowDays, anchor, userTz);
const next     = computeNextDose(med.schedules, asOf, 14, anchor, userTz);
```

Worse, `complianceChips` (`src/lib/medications/scheduling/compliance.ts:129`)
and `missedDoses` (`src/lib/medications/scheduling/cadence.ts:487`) have **no
`engineCtx` parameter at all** — they cannot delegate even if the route wanted
to. So on the detail page:

- An `rrule = "FREQ=WEEKLY;BYDAY=MO"` schedule still expands daily-every-day
  via the legacy weekday walker (`daysOfWeek = null` reads as "every day") —
  the exact long-standing bug SB-SCHED-2 set out to kill, and the same
  dashboard/intake divergence v1.6.0's today-tile read-flip closed
  (`project_v160_outcome.md`).
- A **PRN** schedule, which the engine short-circuits to zero expected slots
  (`recurrence.ts:148`), still expands as a real cadence on the detail page —
  so the detail-page chips count expected doses / "missed" for an as-needed med.
- A **CYCLIC** schedule ignores its off-weeks on the detail page.

The dashboard tile and the detail page will disagree again for exactly the
schedule classes this release introduced.

Fix: add an optional `engineCtx?: CadenceEngineContext` param to
`complianceChips` and `missedDoses` (thread it straight into the
`buildCadenceTimeline` calls they already make), then in the cadence route
build the context once from `med` (`startsOn`, `endsOn`, `oneShot`,
`createdAt`, latest non-skipped intake, `userTz`) and pass it to all three
helpers — mirroring `analytics/compliance.ts:404-414`.

## Medium

### M1 — Sync delta feed has no supporting index for its keyset order (per-user full sort under a 120/min drain)

`src/app/api/sync/changes/route.ts:143-163`, `prisma/schema.prisma:624-629`

`/api/sync/changes` keyset-walks `prisma.measurement.findMany` filtered on
`userId` with `orderBy: [{ updatedAt: "asc" }, { id: "asc" }]`. The
`Measurement` model's only relevant indexes are `(userId, type, measuredAt)`
and `(externalId)` — neither supports `(userId, updatedAt, id)` ordering.
Postgres will filter by `userId` then sort the user's entire measurement set
in memory on every page. For a heavy Apple-Health tenant (hundreds of
thousands of rows) that is a full per-user sort per page, and the route allows
120 pulls/min/user. Given HealthLog's recurring shared-Prisma-pool starvation
history, a multi-device offline-sync drain is a realistic pool-pressure
source. The query is otherwise well-bounded (`take: limit+1`, cap 500,
rate-limited), so this is purely the missing index.

Fix: add `@@index([userId, updatedAt, id])` to `Measurement` and ship the
matching additive `CREATE INDEX` migration (0096). Additive, non-blocking with
`CREATE INDEX CONCURRENTLY` if desired, but a plain `CREATE INDEX` is also fine
at this table size in the maintenance window.

### M2 — Dashboard snapshot 60 s cache TTL is shorter than the 120 s client refetch interval (every scheduled refetch is a guaranteed cache miss)

`src/lib/queries/use-dashboard-snapshot.ts:47-51`, `src/app/api/dashboard/snapshot/route.ts:73-78`, `src/lib/cache/server-cache.ts:210-213`

`caches.analytics` TTL is `60_000` ms; the snapshot hook's
`refetchInterval` is `120_000` ms. Because 120 s > 60 s, the cached snapshot
has always expired by the time the client's interval fires, so every auto-
refresh is a cache MISS that runs the full `buildDashboardSnapshot`
(coverage probe + 4-way `Promise.all` incl. the thick `extras` reads on warm
tenants). This is not a cross-user stampede (the cache is per-user and the
builder fan-out is bounded — see Info I8), but the 60 s TTL is **not**
protective for the 120 s cadence as the route comment implies; it is the
opposite — the interval never benefits from the cache. The cost is one full
builder run per open tab per 120 s.

Fix (cheap, no behaviour change): either lengthen the analytics snapshot TTL
to >= 120 s for the `dashboard-snapshot` key (a per-key TTL, or a dedicated
cache bucket), or document that the 120 s refetch is intentionally a fresh
read and drop the "60 s cache is protective" framing. Functionally correct
today; flagged as a perf-intent mismatch, not a bug.

## Low

### L1 — `invalidate.ts` comment overstates the cron call site

`src/lib/cache/invalidate.ts:120-123`

The `invalidateUserInsights` doc says it is "Called from the
`/api/insights/generate` POST and the `insight-pregenerate` cron". The cron
(`src/lib/jobs/insight-pregenerate.ts`) never calls it directly — invalidation
happens inside `generateComprehensiveInsight` (`comprehensive-generate.ts:299`),
which both the route and the cron call. Behaviour is correct (the snapshot is
evicted on overnight regeneration); only the comment is imprecise. Tidy the
wording.

### L2 — KVNR decrypt is fail-soft (read paths) vs CLAUDE.md "fail closed everywhere"

`src/app/api/export/health-record/route.ts:90-99`, `src/app/api/user/profile/route.ts:46-54`

Both read paths `try { decrypt(...) } catch { = null }` so a key-rotation gap
omits the KVNR rather than 500ing the export/profile. This is a deliberate,
documented deviation from the encryption fail-closed rule and is defensible
for a read-only display/export surface (the WRITE path in
`profile-update.ts:123` correctly uses `encrypt()` fail-closed). Noting it so
the deviation is on record; no change required.

### L3 — `DEFAULT_COACH_PREFS` object omits `dataClusters` while the schema default leaves it `undefined`

`src/lib/validations/coach-prefs.ts:157-163`

`DEFAULT_COACH_PREFS` (the plain-object default) has no `dataClusters` key, so
it reads `undefined` — which is the intended back-compat sentinel and is
handled by `clusters.ts:127` (`undefined → DEFAULT_COACH_CLUSTERS`). Correct,
but a reader could mistake the omission for an oversight. Optional: add an
explicit `dataClusters: undefined` with a one-line comment.

## Info / verified clean

- **I1 — Migrations 0091-0095 are all additive + defaulted.** 0091 two `BOOLEAN NOT NULL DEFAULT false` + one nullable TEXT; 0092 new enum + `NOT NULL DEFAULT 'SCHEDULED'` + two nullable INT; 0093 three nullable TEXT (no default); 0094 nullable TEXT `IF NOT EXISTS`; 0095 `TEXT NOT NULL DEFAULT ''` + index re-key. No NOT-NULL-without-default on existing rows. No data loss.
- **I2 — Exactly one 0093.** `ls prisma/migrations | grep 009` shows 0091-0095 single-numbered; the renumbered collision left only `0093_v170_profile_identity_fields`.
- **I3 — schema.prisma matches migration SQL** for every new column/enum/index. The 0095 `DROP INDEX "telegram_reminder_messages_medication_id_schedule_id_date_phase_key"` matches the name created in `0015_add_reminder_phase_tracking`; the new unique index name matches the schema's `map:`. Prisma compound-key accessor `medicationId_scheduleId_date_phase_timeOfDay` is field-derived (not map-derived) so the telegram upsert (`senders/telegram.ts`) is correct.
- **I4 — All three new queues registered + scheduled/enqueue-bound + handler-bound.** `INSIGHT_PREGENERATE_QUEUE`: allQueues (1978) + schedule `30 4 * * *` (2070) + `boss.work` (2225). `MEASUREMENT_TOMBSTONE_CLEANUP_QUEUE`: allQueues (1983) + schedule `40 3 * * *` (2073) + `boss.work` (2206). `MEAN_CONSOLIDATION_QUEUE`: allQueues (1957) + `boss.work` (2323) + boot-discovery enqueue (2527) — intentionally enqueue-driven (mirrors STEP_CONSOLIDATION), not cron-scheduled. No "scheduled-but-not-created" no-op.
- **I5 — Cron times do not collide destructively.** New crons `30 4 * * *` and `40 3 * * *` occupy unique slots. The two pre-existing shared slots (`0 * * * *`, `*/15 * * * *`) are on distinct queues; pg-boss runs them independently.
- **I6 — Cache invalidation complete.** Measurement/mood/medication writes all `caches.analytics.deleteByPrefix(\`${userId}|\`)`, which covers the `${userId}|dashboard-snapshot` key. Widget writes (`dashboard/widgets`, `chart-overlay-prefs`) and insight writes (`insights/generate` + the generator) call the explicit `invalidateUserDashboardSnapshot` / `invalidateUserInsights` because they don't touch the analytics bucket. All call sites verified.
- **I7 — `daysOfWeek` column kept.** `schema.prisma:974` still has `daysOfWeek String?`; no migration drops `days_of_week`. The legacy walker remains the byte-stable path for plain weekday schedules.
- **I8 — Snapshot `Promise.all` is bounded; sync feed is bounded.** Builder runs a coverage probe then a fixed 4-element `Promise.all` (the expensive `extras` gated behind `warm`) — not the historic 15-way per-type fan-out. Sync feed is a single keyset query, `take: limit+1`, cap 500, rate-limited 120/min/user. No new unbounded fan-out (pool concern is the missing index, M1, not the query shape).
- **FHIR builder** (`src/lib/fhir/build-bundle.ts`) is a pure function — consumes the same `DoctorReportData` from `collectDoctorReportData` the PDF uses (identical-numbers property holds by construction), `now` is an injectable param, no prisma/fetch/random. XML narrative is `escapeXml`-escaped plain text (no markdown lib).
- **Backwards-compat verified.** `coachPrefsJson.dataClusters` undefined → `DEFAULT_COACH_CLUSTERS` (clusters.ts:127). `unitPreference` null → `DEFAULT_UNIT_PREFERENCE = "metric"` (display-transform.ts:32). New medication/schedule fields all defaulted (false / 'SCHEDULED' / null). KVNR validated mod-10 (validations/kvnr.ts via auth.ts:49-60), encrypted field-by-field on write, never mass-assigned, never in the audit row (`hasInsuranceNumber` boolean only).
- **No TODO/FIXME/dead branch in the diff.** The only matches in added non-test lines are i18n "Todos" (Spanish), the `toDoctorReportPrefs` identifier, and an injectable `console.log` default logger sink in the consolidation helpers (consistent with the existing step-consolidation pattern; SWC strips it in prod, the worker passes `workerLog`).
