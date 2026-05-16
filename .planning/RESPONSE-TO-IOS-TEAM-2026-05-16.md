---
file: .planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md
purpose: Direct response to the iOS team's coordination doc at /Users/marc/Projects/healthlog-iOS/HealthLogIOS/.planning/v05x-marathon/RESPONSE-TO-SERVER-TEAM.md
created: 2026-05-16
from: server contributor + automation
re: RESPONSE-TO-SERVER-TEAM.md — ten requests R1-R10, two strategic pivots, calendar realignment
---

# Response to iOS team — 2026-05-16

Read your response in full. The Apple Foundation Models pivot, the
standalone-first commitment for v0.6.0, and the longer iOS calendar
all land cleanly with the v1.4.x continuous-patch model. Every R1-R10
answered below, plus the strategic-pivot implications for the web
roadmap.

## 1. Acknowledgements

- v0.5.0-rc.1 candidate at `54b644c` noted. The merged feat-branches
  (Group 0 felt-UX, Group 1 theme-parallel, Group 2 theme-chart-chain)
  confirm iOS-side ships rich functional work on the v0.5.x track
  independent of web-side releases — exactly the architecture this
  patch run is designed for.
- 732 Swift Testing `@Test` annotations on `main` is a strong
  baseline. Server-side runs ~4 000 Vitest cases; the two test
  surfaces stay independent.
- iOS-additive-only adherence confirmed in both directions.

## 2. Strategic-pivot absorption

### Apple Foundation Models on-device — the v1.5 narrative changes

Closes the Apple Guideline 5.1.2(i) blocker on the iOS side without
requiring a server-routed consent flow for Daily Briefing + Trend
Observations + Photo-of-Med. Confirmed: server-side will not block
v1.5.0 tag on a native Coach SSE drawer. The server's
`GET /api/insights/chat` SSE endpoint stays live, indefinitely,
for: (a) future iOS re-evaluation post-MDR Class-IIa pre-review,
(b) any other client that calls it (PWA mobile users today, native
Android in a hypothetical future), (c) fallback when on-device
generation refuses for any iOS device that loses Apple Foundation
Models eligibility.

Server-side will update §5b of the contributor brief per R6.

### Standalone-first commitment (v0.6.0)

The web side already treats the server as "API server that some
clients pair with"; the iOS-local-first commitment changes nothing
on the server's expectations. Server-side `SyncMode` foundation
ships in v1.4.30 as planned. Conflict-resolution policy locked
in R9 below.

### Calendar realignment

v0.5.x is 2-3 months from 2026-05-16; v0.6 is +3-4 months;
v1.5.0 marker aligns with the iOS App Store launch at ~2026-11
to ~2026-12. Web-side patch cadence stays unchanged: v1.4.30 → 31
→ 32 → 33 ship in the next 1-3 weeks per the current strategic
plan. **The web-freeze window between v1.4.33 and v1.5.0 is now
several months long instead of one Apple-review buffer.** That
opens room for additional v1.4.x patches before the freeze if value
shows up (e.g. R2 Apple Health XML import — see below).

## 3. Direct answers to R1 - R10

### R1 — `GET /api/measurement-categories` HTTP endpoint — YES, slots into v1.4.30

ANSWER: yes. Server-side will expose the categorisation map at
`GET /api/measurement-categories`. Response shape:

```json
{
  "data": {
    "version": 1,
    "categories": [
      { "id": "vitals", "labelKey": "categories.vitals", "order": 0 },
      { "id": "body",   "labelKey": "categories.body",   "order": 1 },
      ...
    ],
    "assignments": {
      "BP_SYSTOLIC": "vitals",
      "BP_DIASTOLIC": "vitals",
      "PULSE": "vitals",
      "WEIGHT": "body",
      ...
    }
  }
}
```

- Public-read with auth (any logged-in user can fetch).
- `Cache-Control: max-age=600` (10 min cache per app launch).
- Versioned (`version: 1`) so clients can detect breaking changes
  if they ever happen — not planned.
- iOS reads on app launch, caches in `MeasurementType+Category.swift`
  helper. Refresh on every cold start.
- Hard-coded mirror in iOS as a fallback if the network call fails
  (offline-first).

Server will add this endpoint inside the v1.4.30 patch alongside
the `src/lib/measurements/categories.ts` map. ~50 LOC + a Vitest +
a documented response shape in `03-api-contracts.md`.

### R2 — Apple Health XML import — slated for v1.4.34

ANSWER: v1.4.34 (web-side, after the Tier-1 wave B + before the
web-freeze marker). Not v1.5.x; iOS calendar gives the web side
plenty of room to ship this before freeze.

Server-side:
- `POST /api/import/apple-health-export` accepting `multipart/form-data`
- Streaming XML parser (Node `sax-stream` or similar)
- Per-`MeasurementType` ingestion stats + duration in the response
- Idempotent UPSERT keyed on `externalId` so re-imports are no-ops
- Operator-side admin endpoint variant for support-staff-driven imports
- Async job model: large files (100 MB - 1 GB) need a background
  worker; the synchronous endpoint returns a job ID, iOS polls
  `GET /api/import/apple-health-export/{jobId}/status`
- Apple Health XML row types: HKQuantityTypeSample, HKCategoryTypeSample,
  HKWorkout, HKClinicalRecord (clinical out-of-scope per R-F T3
  defer). Map each to existing MeasurementType + Workout models.

Effort: L (~3-4 days). Slots into the v1.4.x freeze-marker patch
(v1.4.34) cleanly.

iOS-side: ship the placeholder "Apple Health Import — coming in
v1.4.34" in Settings now if you want the surface visible early.

### R3 — externalId shape lock — confirmed, lands in v1.4.30

ANSWER: confirmed locked in v1.4.30. The lock-line will appear at
`.planning/v15-ios-handoff/08-locked-contracts.md` once the v1.4.30
implementation agent (currently running, ETA hours from now)
commits it. Will cite the exact file:line in the v1.4.30 closure
report at `.planning/round-v1430-closure-report.md`.

The format is hard-fixed: `"stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>"`

- `<HKQuantityTypeIdentifier>` is the literal Apple identifier
  (e.g. `"HKQuantityTypeIdentifierStepCount"`), no trimming, no
  case-change
- `<YYYY-MM-DD>` is the calendar date in the user's TZ at the
  time the day-bucket closes (00:00:00 local of the following day),
  zero-padded
- The two `:` separators are part of the shape — no other delimiter
  variation

No alternate shape will be accepted server-side after the lock.
iOS can start sending this format the moment v1.4.30 deploys.

### R4 — v1.4.30 deploy date — within 24-48 hours of 2026-05-16

ANSWER: implementation agent is currently running; ship target is
within 24-48 hours from 2026-05-16 (so 2026-05-17 to 2026-05-18).
Server-team-side coordination drives the exact moment; this response
will be amended with the actual deploy timestamp once it lands.

For iOS-side Mood-redesign timing: the safe path is a one-cycle
dual-write (write both `note` and `tags["note:..."]`) only if the
iOS Mood-redesign TestFlight ships BEFORE the v1.4.30 deploy. If
the iOS branch ships after, single-write the `note` column directly.

Server-side back-fill collapses prior `tags["note:..."]` rows into
the new column in the v1.4.30 release — see commit 4 of the v1.4.30
plan. After v1.4.30 deploy: existing rows have `note` populated,
new writes go straight to `note`.

Recommended iOS sequence:
1. Wait for the v1.4.30 deploy announcement in `.planning/round-v1430-closure-report.md`
2. Cut the Mood-redesign TestFlight after that with single-write
3. No dual-write needed

### R5 — assistant.coach feature flag — gates BOTH server-routed AND on-device surfaces

ANSWER: yes. The operator-control philosophy is "operator can
disable assistant surfaces app-wide". `assistant.coach` and
`assistant.briefing` flags gate every assistant-driven surface on
every client, regardless of whether the LLM runs server-side or on
the device.

- Server-side: the relevant `/api/insights/*` endpoints return
  403 + `errorCode: "assistant.disabled.<surface>"` when the flag
  is off.
- iOS-side: when `GET /api/feature-flags` returns `assistant.coach: false`,
  iOS hides the Coach surfaces (whether they would have called the
  server SSE OR run on-device).
- iOS-side: when `assistant.briefing: false`, iOS hides the Daily
  Briefing card (whether it would have called the server OR generated
  on-device).
- iOS-side: when `assistant.enabled: false` (the master flag), ALL
  five sub-flags are effectively off — iOS hides every assistant
  surface, server returns 403 on every assistant endpoint.

iOS-side default to gate-both is correct. No client-server split
on flag semantics.

### R6 — Coach SSE decoupling from v1.5 plan — confirmed, brief update queued

ANSWER: confirmed. The contributor brief §5b "Coach SSE — the v1.5
differentiator" is being updated to:

> Coach SSE remains live as a server endpoint. iOS native server-Coach
> drawer is deferred pending MDR Class-IIa pre-review. v1.5.0 ships
> iOS with Apple Foundation Models on-device Daily Briefing + Trend
> Observations as the primary assistant surface. The server's
> `GET /api/insights/chat` SSE endpoint stays live for: PWA users on
> non-AFM-capable devices, future iOS reevaluation post-MDR, any other
> client that adopts the SSE protocol.

Will commit alongside this response.

### R7 — Source-priority editor divergence flag in v1.4.33 closure — committed

ANSWER: yes. The v1.4.33 closure report at
`.planning/round-v1433-closure-report.md` will include a dedicated
"Source-priority editor divergence" section that flags any
deviation from the locked `GET/PUT /api/auth/me/source-priority`
contract. If the web ships with strict contract-parity (target
shape), the section will read "no divergence; iOS can mirror the
shape 1:1". If anything diverges (new optional keys, new constraint
logic), each delta gets cited with file:line + suggested iOS-side
treatment (mirror vs ignore).

### R8 — APNs `.p8` paste status — pending operator (Marc) action

ANSWER: not yet pasted. The `.p8` file (`M9WAFLNC2U`) lives in
operator-side `~/Downloads`. Pasting it into the Coolify env-vars
is a ~1-hour operator action — required no server-side coordination
beyond what already exists.

Surfaced again in this response so it doesn't slip past the v1.5.0
calendar window. The push-notification infrastructure on the server
is in place (v1.4.23 work); the missing piece is the env var.

Will track operator-side completion and flag the deploy in a future
closure report.

### R9 — SyncMode conflict resolution policy — LWW by `updatedAt`, server-wins on tie

ANSWER: hard-spec follows. Will be added to
`.planning/v15-ios-handoff/08-locked-contracts.md` in v1.4.30
alongside the daily-stats `externalId` lock.

**Conflict-resolution policy under `SyncMode = paired`:**

1. **Bulk-backfill (first-pair):** iOS pushes a backlog via
   `POST /api/mood-entries/bulk` / `POST /api/medications/intake/bulk`.
   Server UPSERTs every entry keyed on `externalId` (or
   `clientId` if no `externalId` exists). Server's existing
   uniqueness constraints handle dedup; LWW is not invoked.

2. **Steady-state bidirectional sync:** every `Measurement` /
   `MoodEntry` / `MedicationIntakeLog` row carries:
   - `updatedAt DateTime` (server-set on every write)
   - `syncVersion Int @default(1)` (server-incremented on every
     write)
   - `deletedAt DateTime?` (soft-delete, never hard-delete)

3. **Write conflict:**
   - iOS sends `PATCH /api/<entity>/{id}` with optimistic-lock
     header `If-Match: <syncVersion>`
   - If server's `syncVersion` matches: accept, increment, return
     200 + new `syncVersion`
   - If server's `syncVersion` is newer: REJECT with 409 + return
     the canonical row payload (`{ data: <row>, errorCode: "sync.conflict" }`)
   - iOS-side resolution on 409:
     - Default policy: **LWW by `updatedAt`** — whoever has the
       newer `updatedAt` wins. If iOS local copy is newer, iOS
       sends a fresh PATCH with the server's new `syncVersion`.
       If server's copy is newer, iOS adopts the server payload
       and discards the local edit.
     - Edge case (tie on `updatedAt` to the millisecond):
       **server-wins**. iOS adopts the server payload.
     - User-visible: optional small toast "synced with cloud
       version — your changes were discarded" if iOS adopts the
       server payload over a local edit. iOS-side UX call.

4. **Delete conflict:**
   - Soft-delete only via `PATCH /api/<entity>/{id}` with
     `deletedAt = now()`. Hard-delete blocked.
   - If iOS PATCHes a soft-delete on a row the server has
     subsequently edited: server returns 409 + canonical row.
     iOS treats this as "server says this row was edited after
     your delete intent — abort delete, prompt user to confirm".
   - If iOS PATCHes an edit on a row the server has
     soft-deleted: server returns 410 Gone. iOS adopts the
     server's soft-delete state (or surfaces "this row was
     deleted on another device — discard your edit?").

5. **Sync-state envelope:**
   - `GET /api/sync/state` returns:
     ```json
     {
       "data": {
         "syncVersion": <user-level current high-water-mark>,
         "lastSyncedAt": "<ISO 8601>",
         "perEntity": {
           "Measurement": <high-water syncVersion>,
           "MoodEntry": <high-water>,
           "MedicationIntakeLog": <high-water>
         }
       }
     }
     ```
   - iOS uses `perEntity` to decide which `?since=syncVersion=N`
     reads to fire after a reconnect.

iOS-side: this is enough to ship the v0.6.0 standalone-first track
with bidirectional sync. The LWW-by-updatedAt + server-wins-on-tie
default matches Apple convention. If iOS wants richer merge
semantics later (per-field LWW or three-way merge), that's a
v1.6 conversation.

Status: hard-spec confirmed by this response. Server-side codifies
it in `08-locked-contracts.md` in the v1.4.30 commit alongside the
externalId lock.

### R10 — Enum-add accepts pre-display — confirmed

ANSWER: yes. Once v1.4.30 ships the Prisma enum extension +
the Zod validator update, the server accepts
`POST /api/measurements` with `type=WALKING_STEADINESS` or
`type=AUDIO_EXPOSURE_EVENT` immediately. The web-side display
landing in v1.4.33 is independent — the rows persist in the DB
from the moment v1.4.30 deploys; the web just doesn't render
them until v1.4.33.

iOS can start ingesting these types in the same TestFlight build
that adopts the daily-stats `externalId` shape (note:
`WALKING_STEADINESS` is NOT in `CUMULATIVE_HK_TYPES` — it's
per-sample like other vitals; `AUDIO_EXPOSURE_EVENT` is also
per-sample / event-shaped, not cumulative).

No build-flag gate is required iOS-side.

## 4. New v1.4.x patches added per this response

The web roadmap (`.planning/v15-strategic-plan.md`) is being updated
with two new patches:

- **v1.4.34 — Apple Health XML import + web freeze marker**.
  Replaces the original v1.4.33 freeze-marker. The freeze marker
  now lands at v1.4.34, after the XML import endpoint ships. iOS
  can plan against this for the "existing-user-with-history join"
  flow.
- Misc smaller patches (v1.4.30.x hotfix-style) if any of R1-R10
  surface a small gap before freeze.

Calendar still leaves multi-month room before iOS launches; the web
side will not pile on more features without a clear use case.

## 5. iOS-side notes back

- The two new MeasurementType enums (`WALKING_STEADINESS`,
  `AUDIO_EXPOSURE_EVENT`) are NOT cumulative — they're per-sample
  or event-shaped. They do not flow through the daily-stats
  `externalId` path. Send them as raw per-sample rows like other
  vitals.

- iOS-side §6 mentions iOS uses real `APIClient` with stub
  `URLSession` per the v0.2.0 audit lesson. Server-side mirror:
  v1.4.29's real-Postgres integration-test container fixture is
  the same discipline. Both sides honour "don't mock the boundary
  you're testing".

- The Apple Foundation Models pivot is a strong direction. Server-side
  has no equivalent — no on-device runtime — so the server's
  assistant-driven surfaces stay LLM-provider-routed (Anthropic /
  OpenAI / etc. via the existing provider abstraction). iOS users
  on AFM-capable devices get the on-device path; everyone else
  (PWA mobile, non-AFM iOS devices, web desktop) gets the server
  path. Both paths gate on the `assistant.*` feature flags
  consistently (see R5).

## 6. Open items back to iOS

No counter-questions. Every R1-R10 answered above. Will refresh this
response if v1.4.30 deploy surfaces additional cross-coordination items.

The next checkpoint is the `.planning/round-v1430-closure-report.md`
once v1.4.30 ships — that report carries:
- exact deploy timestamp on both hosts (answers R4 with precision)
- the cited line in `08-locked-contracts.md` confirming the
  `externalId` shape lock (answers R3 with precision)
- the cited line in `08-locked-contracts.md` confirming the
  conflict-resolution policy (answers R9 with precision)
- the `/api/measurement-categories` endpoint URL + response shape
  (answers R1 with precision)

## 7. Closing

The iOS-side strategic direction (Apple Foundation Models on-device
+ standalone-first + extended calendar) is the right call for the
product identity and the regulatory posture. Web side adapts: keep
shipping additive surfaces, hold the freeze marker until iOS-side
actually needs it, and the v1.5.0 tag stays the "iOS native client
live on the App Store" marker as originally framed.

iOS-side autopilot stays on Apple Foundation Models / standalone-first
work; server-side autopilot stays on the v1.4.30 → v1.4.34 patch run.
Coordination via these two response docs + the per-patch closure
reports is sufficient.
