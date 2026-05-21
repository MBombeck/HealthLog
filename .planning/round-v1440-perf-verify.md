# v1.4.40 — Post-deploy perf verification

Live deploy: **2026-05-21T12:55:02Z**. Squash-merge commit on `main`:
`1114cf7e`. Docker workflow `26221332323` succeeded on both
`linux/amd64` and `linux/arm64`. Coolify deploy fired both via the
workflow's auto-trigger step and via the explicit MCP deploy
(idempotent, converged to the same state).

Migration `0074_v1440_consent_receipts` applied cleanly at boot.

## Unauthenticated probe (orchestrator side)

```bash
$ curl -s https://healthlog.bombeck.io/api/version
{"data":{"version":"1.4.40", ...},"error":null}
```

Confirmed live at 12:55 UTC.

## What this release was supposed to fix

The empirical trace + the architecture-QA quadrology pointed at one
empirical root cause and three architectural Criticals:

| # | Root cause | Wave | Expected delta |
| --- | --- | --- | --- |
| 1 | Prisma pool starvation on `/api/analytics` thick (≥8 of 10 default slots held for 6.5 s) | W-POOL | Wave-C chart-tile first-paint **+7.3 s → +1.6 s** |
| 2 | 6 insights routes unbounded `MoodEntry.findMany` | W-INSIGHTS | 5-10 s cold-mount estimate (3 routes done in-band, 3 deferred with documented reasons) |
| 3 | `Measurement.deletedAt` half-wired → tombstoned rows surface | W-DELETED + W-INFRA T1 | iOS soft-delete now correct end-to-end |
| 4 | WMY rollup buckets write-only → 3× write amplification | W-WMY-WIRE | `avg30LastYear` populated (was null), slope90 via MONTH-tier |

## What gets verified by Marc's first authenticated session

The wide-event annotates emit per-surface `path: "rollup" | "live"`.
The slim/thick LRU caches stay warm for 60 s after the first hit. The
dashboard tile-strip + chart row should now paint progressively — per
W-RSC's per-tile `<Suspense>` boundaries — instead of in one burst.

Coolify log grep targets:
- `path:"rollup"` on `/api/analytics`, `/api/dashboard/summary`,
  `/api/mood/analytics`, `/api/medications/intake?scope=compliance`,
  `/api/insights/{targets,comprehensive,generate}`
- `meta.dashboard.sub_*_ms` annotates (W-F observability)
- `meta.analytics.bp_aggregate.live_since` (W-SINCE annotates)

## iOS PB30 enablement verification

The iOS team's SERVER-BACKLOG asks for SB-3/4/5/6/7/10. Surfaces live:

- **SB-3** Privacy Policy at `https://healthlog.bombeck.io/privacy` — bilingual paired-on-one-page. App-Store-Connect URL field gets this. POLICY_VERSION = 1.4.40.
- **SB-4** AASA file at `https://healthlog.bombeck.io/.well-known/apple-app-site-association` — strict `application/json`, contains `S8WDX4W5KX.dev.healthlog.app` + `applinks` + `webcredentials`.
- **SB-5** APNs `interruption-level: time-sensitive` for `MEDICATION_REMINDER` payloads ONLY. **AP-2 prerequisite**: the `.p8` APNs auth key must be installed in Coolify env (`APNS_KEY` + `APNS_KEY_ID` + `APNS_TEAM_ID` + `APNS_BUNDLE_ID`) before SB-5 has any observable effect. Until then the server skips the APNs send entirely (`loadApnsConfig()` returns null).
- **SB-6** `GET /api/notifications/status` returning per-category `lastDeliveredAt` map. MOOD_REMINDER populated from `MoodReminderDispatch`; other categories return `null` until per-category ledgers ship (v1.4.41 follow-up).
- **SB-7** `/api/auth/registration-status` 4-branch behavior pinned in `auth-registration-status.test.ts`. The hint endpoint mentioned in the iOS brief (`/api/auth/check-user`) is out-of-scope for v1.4.40; flagged for v1.4.41.
- **SB-10** `POST /api/consent/ai` + `GET /api/consent/ai/latest` + `DELETE /api/consent/ai/latest`. Append-only invariant verified. 64 KB Buffer-byte cap (security M1 reconcile fix).

## Operator action required for SB-5

```bash
# On apps01:
$ docker exec -it healthlog_app sh
$ # Then set the four env vars via Coolify UI:
$ #   APNS_KEY      = <contents of M9WAFLNC2U.p8>
$ #   APNS_KEY_ID   = M9WAFLNC2U
$ #   APNS_TEAM_ID  = S8WDX4W5KX
$ #   APNS_BUNDLE_ID = dev.healthlog.app
$ #   APNS_PRODUCTION = true (when ready for prod APNs)
$ # Save + redeploy the app.
```

After install: send a test medication-reminder push from the admin
console; iOS should receive `apns-priority: 10` +
`interruption-level: time-sensitive` and bypass Focus mode.

## Carry-overs to v1.4.41 (deferred clean)

Documented in `project_v1440_marathon_outcome.md` memory + the 6 QA
finding files. Highest-impact items:

- W-DELETED-2 sweep for export/admin/doctor-report/gamification readers
- W-INSIGHTS-2 for cards/glp1-timeline/gamification (needs per-user-tz bucketing first)
- `src/types/` DTO promotion + prompt-directory unification (org-audit recs #2 + #3)
- Full RSC migration of `app/page.tsx` (Suspense boundaries shipped as prerequisite)
- ESLint custom rule for `queryKeys` factory enforcement (test-guard substitutes for now)
- `/api/auth/check-user` SB-7 follow-up

## Marathon retrospective

Cross-agent commit-attribution drift recurred a 4th time (across
v1.4.37 / v1.4.38 / v1.4.39 / v1.4.40). The marathon's parallel-waves
pattern is sound; the shared-tree pattern is the failure mode.
Per-agent `git worktree` isolation is now a hard rule for any
release-marathon with 3+ parallel implementation agents
(`feedback_marathon_worktree_isolation.md` in both memory locations).
