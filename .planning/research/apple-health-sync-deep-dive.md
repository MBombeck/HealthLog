# Apple Health sync — v1.5 iOS client deep dive

Status: research memo, written 2026-05-11 against the v1.4.23 server
contracts on `develop`. Not a plan; the implementer (P2 iOS sprint)
should treat this as recommendations grounded in Apple's documentation
and the v1.4.23 schema. Marc-style voice; English; HealthLog-specific
file-path callouts.

Scope: the seven questions in the briefing. Server foundation already
shipped per `.planning/phase-W2-v1423-report.md` and
`.planning/phase-W3-v1423-report.md`; iOS scaffold at
`~/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Services/`.

---

## 1. Observer-query + anchored-query mechanics on iOS

### The canonical incremental-sync pattern

HealthKit's incremental-sync story is a two-query dance. `HKObserverQuery`
is the wake-up: HealthKit calls its update handler when a sample of the
requested type is saved or deleted, and on app cold-start its handler
fires once with the backlog accumulated while the app was suspended.
`HKAnchoredObjectQuery` is the actual transport: given a `HKQueryAnchor`
opaque cursor, it returns every sample written after that anchor plus a
fresh anchor representing "now" — and, crucially, the list of
`HKDeletedObject` entries for samples that have been removed since the
last anchor.
([HKAnchoredObjectQuery — developer.apple.com](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery),
[HealthKit changes observing — topolog.dev](https://dmtopolog.com/healthkit-changes-observing/))

The current iOS scaffold at
`/Users/marc/Projects/healthlog-iOS/HealthLogIOS/HealthLog/Services/HealthKitService.swift`
lines 154-191 already implements the canonical structure:
`HKObserverQuery` wraps an `HKAnchoredObjectQuery`, persists the new
anchor in the results handler, and calls `completion.handler()` from
inside the anchored-query callback so HealthKit stops re-firing the
observer. That call-once contract on the observer-completion handler is
load-bearing — if the observer's update handler doesn't call its
completion block, HealthKit gradually backs off the wake-up cadence and
eventually stops calling the observer at all. The current scaffold gets
this right.

### Persisting and restoring the anchor

`HKQueryAnchor` conforms to `NSSecureCoding`, so the on-disk shape is
`NSKeyedArchiver.archivedData(withRootObject:requiringSecureCoding:true)`
and `NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from:)`
on read. This is the path the scaffold already uses
(`HealthKitService.swift:227, 231`).

### Anchor storage: UserDefaults, not Keychain

The current scaffold writes to `UserDefaults` and documents the reason
inline (lines 218-221): anchors are opaque pointers into the HK sample
stream, not PII, and Keychain writes from a background-app-refresh
callback incur SecItem operations that hit the secure-enclave path.
**That decision is correct.** Three reinforcing reasons:

1. **No PII.** A `HKQueryAnchor` is an internal HK rowid offset. Even if
   an attacker extracted the file they would get neither sample values
   nor identifiers; they need HealthKit authorization to do anything
   with it.
2. **Background-callback latency.** Apple gives observer-query wake-ups
   a sub-30-second budget (see §5). Keychain writes are cheap but not
   free; UserDefaults' plist write is faster and never blocks on the
   secure enclave.
3. **Per-app-group access from extensions.** If P2's later work moves
   the sync coordinator into a `BGTaskScheduler` extension or shares
   anchors with a Watch companion, `UserDefaults(suiteName:)` on a
   shared App Group is the natural shape; Keychain access-group
   sharing is also possible but more ceremony.

**Don't store anchors in iCloud / NSUbiquitousKeyValueStore.** Two
iCloud-paired devices each have their own HealthKit store (samples can
sync via iCloud Health, but the rowid space is per-device). Sharing an
anchor across devices would either skip samples on one device or
re-emit them on the other.

### Partition key: per-type per-user, never just per-type

The anchor namespace must include both the HK identifier _and_ the
authenticated HealthLog `userId`. The scaffold currently keys by
`Self.anchorDefaultsKeyPrefix + typeID` only (line 225) — that is
**a latent bug** if the iPhone is ever signed in as a different
HealthLog user (Marc on one device, family member on another iPhone
sharing the same install? unlikely today; logout-then-login same device
to the same account? happens every TestFlight build). Make the key
shape `hl.healthkit.anchor.<userId>.<typeIdentifier>`, and clear all
anchors keyed by `userId` on logout. The HealthKit authorization
persists across logout (it's per-app, not per-account) so the
authorization prompt won't re-fire; the anchor reset just means the
next sync replays the full window allowed by the read scope.

**Apple is explicit that anchors are per-`HKSampleType`** — see Apple's
"HKAnchoredObjectQuery" reference: "An anchored object query returns an
anchor value that corresponds to the last sample or deleted object
received by that query." One anchor per `(user, type)` is the only
shape that doesn't corrupt the stream.

### Practical recommendation for `HealthKitService.swift`

```swift
// Replace the existing two-arg signature with three args:
private func anchorKey(userId: String, typeID: String) -> String {
    "hl.healthkit.anchor.\(userId).\(typeID)"
}
private func loadAnchor(userId: String, typeID: String) -> HKQueryAnchor? { ... }
private func saveAnchor(_ anchor: HKQueryAnchor, userId: String, typeID: String) { ... }

// On logout, prune everything for the user:
func clearAnchors(for userId: String) {
    let prefix = "hl.healthkit.anchor.\(userId)."
    for key in defaults.dictionaryRepresentation().keys
        where key.hasPrefix(prefix) {
        defaults.removeObject(forKey: key)
    }
}
```

`userId` should be plumbed through from `AuthStore` (see
`Stores/AuthStore.swift`) into `HealthKitService.startBackgroundDeliveries`
— the actor already has access to `keychain`, which is the right place to
fetch `userId`.

---

## 2. Anti-double-data strategy

Apple's HealthKit aggregates samples written by every source that has
authorization: iPhone (motion coprocessor), Apple Watch, third-party
apps (AutoSleep, Strava, MyFitnessPal, Withings Health Mate, etc.).
Steps are the canonical worst case — both Watch and iPhone emit step
samples for the same walking interval, and naively summing
`HKSampleQuery` results inflates the daily total by 30-80% depending on
the user's wear pattern.
([Step Data Duplication Issue — Apple Developer Forums](https://developer.apple.com/forums/thread/759709))

### Layer 1: server-side `(user_id, type, source, external_id)` dedup

### (already shipped)

The composite unique index from migration
`0036_apple_health_measurement_types` (see
`prisma/schema.prisma:298`) deduplicates **identical HKSample.uuid**
across retries, multi-device cloud sync (same sample arriving from two
iCloud-paired iPhones via HealthKit cloud), and partial-batch retries.
That's the right floor — any iOS app posting the same `HKSample.uuid`
twice gets a `duplicate` per-entry status.

**But UUID-dedup alone does NOT solve the steps problem.** When the
iPhone and Apple Watch both record steps for the same minute, they
write _two distinct HKSample objects_ with _two distinct UUIDs_. They
are not duplicates from HealthKit's POV; they are sibling samples from
different sources. Server dedup cannot collapse them because the inputs
genuinely differ.

### Layer 2: client-side source-aware sampling (iOS must do this)

The right surface is **on the iOS side, before posting to
`/api/measurements/batch`**. Apple's official recommendation is
[`HKStatisticsCollectionQuery`](https://developer.apple.com/documentation/healthkit/hkstatisticscollectionquery)
for cumulative quantity types — it applies the same merge algorithm
Apple's Health.app uses, which prefers Apple Watch samples when the
Watch was on the wrist and falls back to iPhone samples for unworn
intervals.
([Beyond counting steps — WWDC20](https://developer.apple.com/videos/play/wwdc2020/10656/),
[Step duplication — Apple Developer Forums](https://developer.apple.com/forums/thread/759709))

Concretely, for the four cumulative types in v1.4.23's
`apple-health-mapping.ts` (steps, active energy, flights, distance):

- Don't post raw `HKQuantitySample` rows from
  `HKAnchoredObjectQuery`. Use the anchored query as a _trigger_: when
  it fires, ask HK "what's the merged daily total for the affected
  days?" via `HKStatisticsCollectionQuery` with `intervalComponents`
  of one day and `options: .cumulativeSum`. Post one row per
  affected day with `externalId = "stats:<typeIdentifier>:<dayISO>"`.
  Updating "yesterday's steps" then naturally `duplicate`-collapses
  on the existing index.
- The `aggregation` hint already encoded in
  `src/lib/measurements/apple-health-mapping.ts:25-30` matches this
  story: `sum` for cumulative metrics, `latest`/`mean` for spot
  metrics. We were planning to do the aggregation on the server; for
  cumulative metrics it's correct to do it on the client where
  Apple's merge algorithm has access to the cross-source context the
  server never sees.

For spot metrics (BP, HR, BG, weight, SpO2, HRV, resting HR, VO2 max,
body temp, sleep stages), Apple's UUID-per-sample model is correct as-is
— two BP readings 10 seconds apart are two real measurements, and
sibling samples from different cuffs deserve to land as two distinct
rows. The server-side unique index handles the rare case of the same
sample arriving twice (cloud-sync replay).

### Layer 3: server-side prefer-source heuristic — NO

The briefing asks whether we should prefer iPhone-over-Watch (or vice
versa) on the server. **Don't.** Three reasons:

1. **The server doesn't know which device the user was wearing.** Apple
   Watch is preferred when worn; iPhone is preferred when the Watch is
   off-wrist. Only HealthKit on the iPhone has the cross-source visibility
   needed to decide. Re-implementing the heuristic server-side means
   guessing at Apple's merge logic, which is a moving target.
2. **It would break the spot-metric story.** A weight reading from a
   Withings scale and a weight reading from a Renpho scale on the same
   day are both legitimate; a "prefer one source" rule would silently
   drop one.
3. **Withings comparison.** Withings' own API returns per-device-grouped
   samples with `attrib` codes indicating manual/auto/device, and lets
   the API consumer decide which to surface. They do not server-side
   prefer one device over another.
   ([Withings public API guide](https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/public-health-data-api-overview/))

The decision-locus is the iOS client, and the right primitive is
`HKStatisticsCollectionQuery` for cumulative types. The server stays
honest about what was posted.

### Layer 4: iOS-self-write loop guard (already shipped on iOS side)

The scaffold at
`HealthKitService.swift:200-207` already filters out samples HealthLog
itself wrote by checking `sourceRevision.source.bundleIdentifier` and
the `HKMetadataKeyExternalUUID` tag. Keep this. It stops a write-back
loop where HealthLog reads "Withings posted a BP reading via the iOS
app" → posts to server → server returns the same row → some future
write-path drops it into HealthKit again → observer-query sees a new
sample → server post → infinite loop. The tag check is the canonical
defence.

### Summary

| Layer                                              | Where            | Solves                                              |
| -------------------------------------------------- | ---------------- | --------------------------------------------------- |
| UUID dedup                                         | Server (shipped) | retries, cloud-sync replay, two-device same-account |
| `HKStatisticsCollectionQuery` for cumulative types | iOS, P2 work     | iPhone+Watch steps double-count                     |
| Spot-metric UUID-per-sample                        | iOS, default     | two cuffs / two scales are real                     |
| Source-bundle filter                               | iOS (shipped)    | self-write loop                                     |

Server-side: nothing else needed. The contract holds.

---

## 3. Deletion sync

This is HealthKit's nastiest corner. The headline: `HKAnchoredObjectQuery`
_does_ return deleted samples via its `deletedObjects:
[HKDeletedObject]` parameter alongside the new-samples list — but only
when the anchor moves. If a user opens Health.app on their iPhone,
deletes yesterday's BP reading, and nothing else writes a new BP sample
for the next two weeks, **the observer-query never fires** because no
new sample triggered the wake-up. The deletion sits invisible.
([Synchronizing HealthKit data — Girotto, Medium](https://medium.com/@guilhermegirotto/synchronizing-healthkit-data-bca411a7a15c),
[Apple Developer Forums #22012](https://developer.apple.com/forums/thread/22012))

Worse: Apple documents `HKDeletedObject` instances as "may disappear from
HealthKit after an unspecified period". A user deleting a six-month-old
sample after the tombstone window has closed will never surface to the
anchored query.

### The two workarounds, and which to ship

**Option A — Periodic full-window reconciliation.** On a cadence
(daily, or on each app foreground), run an unanchored `HKSampleQuery`
across a fixed lookback window (Apple's docs use 30 days for sleep,
which is the practical horizon for HealthKit anchor freshness), and
_also_ fetch the server's measurements for the same window. Compute
the set difference — rows on the server tagged
`source = APPLE_HEALTH` that aren't in HealthKit's current window — and
ask the server to soft-delete them. **This is the right primary
mechanism for v1.5 P2.** The cadence can be once per app foreground
plus a daily background fetch.

**Option B — Server-side soft-delete tombstones.** Adds a
`deletedAt: DateTime?` column to `Measurement`, plus a new
`DELETE /api/measurements?ids=...` endpoint. We don't need to ship this
in P2 if Option A covers the case — but the tombstone column is cheap
to add later if Marc later decides hard-deletes are wrong (audit/PDF
export use cases want history). Recommend: don't pre-ship the column;
let P2 use hard-delete via a new route, revisit if the doctor-PDF flow
wants to surface "originally-recorded, later corrected" annotations.

**Concrete iOS-side shape for Option A (P2 work):**

```swift
// In SyncCoordinator.swift (new file in P2):
func reconcileDeletions(for type: HKQuantityType, userId: String) async throws {
    let window = DateInterval(start: Date().addingTimeInterval(-30 * 86400),
                              end: Date())
    // 1. Read every Apple-Health-sourced row from the server.
    let serverRows = try await api.getMeasurements(
        from: window.start, to: window.end,
        type: mapToServerType(type), source: .appleHealth)
    let serverUUIDs = Set(serverRows.compactMap(\.externalId))
    // 2. Read every HealthKit sample in the window (unanchored).
    let hkSamples = try await healthKit.fetchSamples(type, in: window)
    let hkUUIDs = Set(hkSamples.map { $0.uuid.uuidString })
    // 3. Difference = deleted on iPhone but still on server.
    let stale = serverUUIDs.subtracting(hkUUIDs)
    if !stale.isEmpty {
        try await api.deleteMeasurements(externalIds: Array(stale))
    }
}
```

**Server-side work needed for Option A:**

- A new `DELETE /api/measurements/by-external-ids` route accepting up
  to 500 externalId strings + a `source` constraint (the iOS client only
  deletes things it owns); soft-deletes or hard-deletes per Marc's
  decision. The route should mirror the batch-ingest idempotency
  contract — `Idempotency-Key` header, `withIdempotency()` wrapper.
- File path the implementer should create:
  `src/app/api/measurements/by-external-ids/route.ts`.

**Cadence recommendation.** Run reconciliation once per `applicationDidBecomeActive`
on the iOS side AND once per day via `BGTaskScheduler` (the same task that
runs the regular sync), gated to one reconcile per 24h per type. Skip
the reconcile pass for cumulative types where we're posting daily-stat
rows — there, "deletion" doesn't really apply because tomorrow's roll-up
overwrites yesterday's value via the same composite key.

---

## 4. Apple Watch handoff considerations

Server-side: **nothing changes**. The Apple Watch and iPhone share the
same HealthKit store via iCloud Health (when the user has Health-app
sync turned on; default-on since iOS 16). When the iPhone's anchored
query runs, it sees Watch-originated samples with
`sourceRevision.source.name = "Apple Watch"` already merged in. The iOS
app posts as a single client; the server has no idea whether the
underlying sample came from the iPhone's M-coprocessor or the Watch's
sensors.

**Contract risk: ZERO.** The `MeasurementSource` enum's `APPLE_HEALTH`
value subsumes both. We do not need a separate `APPLE_WATCH` source. If
some future analytics surface (insights "you sleep better when wearing
the Watch") wants per-device attribution, the right place to land that
is a new `externalSourceVersion`-derived chip on the iOS side — the
column already exists (migration `0036`, `prisma/schema.prisma:281`) —
and the iOS client can populate it with `sourceRevision.productType`
(e.g. `"Watch7,1"`). The server doesn't need to know what those strings
mean.

**One nuance the iOS implementer should keep in mind:** a Watch-only
sample lands in HealthKit on the iPhone via Watch sync, which has its
own latency (typically 30 seconds to 5 minutes when the Watch is
unlocked). The iOS observer-query will fire when the Watch sync lands,
not when the Watch recorded the sample. Sample `startDate` is the
correct timestamp to use; do not derive the wall-clock from `receivedAt`
in the anchored-query callback.

A standalone Watch app (one that posts to the server without an iPhone
present) is **out of scope for v1.5 P2** — `URLSession` on watchOS is
constrained, and Apple's WatchConnectivity / batch-upload paths add
ceremony. Punt to v1.6+.

---

## 5. Background sync — what Apple actually allows

### Wake-up trigger budget

`HKObserverQuery` with `enableBackgroundDelivery(for:frequency:)` is
**not** a guaranteed real-time pipe. Apple documents the frequency
parameter as advisory: "iOS may defer the scheduled time based on
factors like CPU usage, battery usage, connectivity, and Low Power
Mode". In practice:

- `.immediate` frequency (used for BP, BG, HR, SpO2 per the iOS
  scaffold's `preferredFrequency()`) gets the wake-up promptly when the
  device is unlocked / on Wi-Fi / not in Low Power Mode. Sleeping
  iPhone in a bag at 4% battery: the wake-up gets deferred until the
  device wakes up for its own reasons.
- `.hourly` frequency (used for steps, weight, sleep per the same
  helper) batches wake-ups; you can expect somewhere between one wake
  per hour and one wake per several hours depending on system state.
  ([HKObserverQuery — developer.apple.com](https://developer.apple.com/documentation/healthkit/hkobserverquery),
  [enableBackgroundDelivery — developer.apple.com](<https://developer.apple.com/documentation/HealthKit/HKHealthStore/enableBackgroundDelivery(for:frequency:withCompletion:)>))

### Execution budget once awake

Apple does not publish a hard number. Empirical reports from developers
peg the observer-query wake budget at **~15-30 seconds** before iOS
terminates the process; on watchOS it is closer to 15 seconds and
shares budget with `WKApplicationRefreshBackgroundTask` and
`WCSession` traffic.
([WatchOS HealthKit HKObserverQuery — Apple Developer Forums](https://developer.apple.com/forums/thread/781261),
[Challenges with HKObserverQuery — Medium](https://medium.com/@shemona/challenges-with-hkobserverquery-and-background-app-refresh-for-healthkit-data-handling-8f84a4617499))

### How many entries can we post per wake-up?

This depends almost entirely on network conditions, not the batch size.
A typical TLS round-trip to a modest Coolify-hosted server over Wi-Fi
is ~150-400 ms; LTE is ~250-700 ms; bad cell coverage is multiple
seconds and Apple can kill the process while the request is still
in-flight. The 500-entry ceiling in
`src/app/api/measurements/batch/route.ts:39` is fine for the _server_
but the iOS client should think in terms of **time** not entries.

**Practical recommendation for the iOS coordinator:**

1. Set a 12-second wall-clock budget per observer wake-up (half of the
   minimum credible Apple budget — leaves headroom for the anchor save
   and the audit-log SHA derivation).
2. Drain the anchored query into a local outbox (the iOS scaffold
   already has `OutboxQueue.swift` and `OutboxReplayService.swift`).
3. Post one batch of up to 500 entries; if the response lands inside
   the budget, post another; if the wall-clock runs out, advance the
   anchor only past what the server confirmed (`inserted` +
   `duplicate`), and let the next wake-up resume.
4. Schedule a follow-up `BGTaskScheduler` task with identifier
   `dev.healthlog.sync.drain` for any outbox tail. `BGProcessingTask`
   gets a much longer budget (minutes, on charger preferred) and is
   the right surface to flush a multi-day backlog after a long offline
   window.

### Is 500 entries a reasonable daily ceiling?

For a typical user, yes — easily. Quantifying:

- Step samples on a Watch wearer: ~50-200 per day (one sample per
  minute of activity, batched by Apple).
- Heart rate: ~100-300 per day (auto-readings every 5-10 min, more
  during workouts).
- Sleep stages: ~5-20 per night.
- BP / weight / glucose: 1-5 per day each.
- HRV / resting HR / VO2 max: 1-2 per day.

Daily steady-state: well under 500 entries. **The risk zone is the
initial sync** when the user authorises HealthLog after years of
HealthKit history — a heavy Watch user can have 50k-200k samples
accrued. The cumulative-types-as-daily-stats trick (§2) cuts the
biggest categories down to one row per day, but spot HR samples can
still hit 100k+. The iOS app needs an explicit "initial sync window"
default (recommend: 30 days; the Settings tab can offer 90/365/all-time
later) plus a long-running `BGProcessingTask` for backfill, NOT a
sequence of observer-query wakes. The 500-entry ceiling is wrong for
backfill; do it via a foreground spinner or a single long
`BGProcessingTask` and call the batch endpoint repeatedly.

---

## 6. The 13 iOS DTO open questions — server-blockers vs iOS-only

Reading `.planning/phase-W4-v1423-report.md:137-199`, the consolidated
list. Routing:

### Server-side blockers (must be settled before iOS posts)

These have a server contract that already has _one_ answer wired in
v1.4.23; the iOS side must match exactly or it will get 422/409
responses.

- **Q1 — `HEALTHKIT` → `APPLE_HEALTH` rename.** Server is locked
  (`prisma/schema.prisma:243`). iOS DTO at
  `Models/MeasurementDTO.swift:60` still ships `HEALTHKIT`. Server-side
  blocker in that an iOS post with `source: "HEALTHKIT"` fails Zod
  parse with no useful diagnostic; the rename is one line in iOS but
  must happen before P2's first network call.
- **Q4 — Pre-conversion vs post-conversion.** Server expects Apple's
  native units (see
  `src/lib/measurements/apple-health-mapping.ts:103, 222`). If the iOS
  app pre-multiplies SpO2 by 100, the server multiplies again and
  stores 9 700. Server-blocker: there's no way for the server to
  detect "this number is already in percent" — the contract has to
  match.
- **Q6 — APNs token wire format (hex-join, not `data.description`).**
  Server-side Zod regex rejects bracket-spaces with a 422 (see
  `phase-W3-v1423-report.md:150`). Blocker in the sense that the iOS
  serialiser bug surfaces as a hard failure at registration time, not
  a silent skip — but the iOS author must know to avoid it.
- **Q7 — `apnsEnvironment` value at first registration (sandbox/Debug
  vs production/Release).** Server requires the field paired with
  `apnsToken` and returns 422 if mismatched. The pairing is
  client-side but the values are server-blocking — sandbox-build with
  `production` env burns the prod gateway with a token that's invalid
  there and gets `BadDeviceToken` on first push.

### Mixed (server has a default; iOS just needs to agree)

- **Q2 — `externalId` = `HKSample.uuid.uuidString` verbatim.** Server
  treats `externalId` as opaque; this is purely an iOS-side discipline
  call. The blocker is only that two iOS devices syncing the same
  iCloud-paired sample with _different_ `externalId` schemes would
  bypass the dedup index. Not server-blocking but cross-device data
  hygiene depends on the choice.
- **Q3 — `sleepStage` codepoint domain.** Server accepts 0-20 (see
  `src/app/api/measurements/batch/route.ts:47`). iOS-16+ codepoints
  are 0-5. iOS-side decision: serialise the integer not the string
  label. Server is forgiving; the headroom is intentional.
- **Q5 — Unknown identifier behaviour.** Server returns
  `skipped`/`unmappable_identifier`. iOS-side policy choice: drop
  from sync cursor (clean cursor, no retry) vs park for retry (server
  mapping addition automatically backfills). **Recommend park-for-retry**
  — the cost is a few extra bytes per parked sample in the iOS outbox.
- **Q8 — Token rotation cadence.** v1.4.23 ships
  `DELETE /api/devices/[id]` (W4 F7); the iOS-side question is "when
  does the iOS app call it?". Recommendation: call on observed APNs
  rotation (the `didRegisterForRemoteNotificationsWithDeviceToken`
  callback fires with a fresh token), and only THEN POST the new
  token. Server-side fallback (rely on `Unregistered`) works but
  takes hours to converge.

### Purely iOS-side / UX decisions

- **Q9 — Multi-device cascade UX.** Two paired iPhones get two
  notifications today. UX call for the iOS Settings tab (P3); the
  server cascade fan-out already handles N>1 devices per user.
  Whether there's a primary-device toggle is purely an iOS UI
  decision; the server only needs the toggle if Marc decides "yes"
  (one-line addition to the channel-priority sort).
- **Q10 — `collapseId` shape.** Server uses `eventType` today
  (`src/lib/notifications/dispatcher.ts`). If P3 decides per-med
  collapse is wanted, the server change is one-line
  (`collapseId: \`${eventType}:${medicationId}\``); the _decision_ is
  iOS-side UX.
- **Q11 — Device-list channel rendering** (W4 NEW). Chips vs filter
  is iOS UI choice. Server returns the full `channels` array; iOS
  renders.
- **Q12 — `X-Device-Id` header.** Already implemented in the iOS
  `APIClient.swift` for `/api/auth/refresh`; just needs to be added
  to the `/api/auth/me/devices` request. Server returns
  `isCurrent: false` for everyone if missing; not a crash, just a
  feature regression on the iOS Settings tab.
- **Q13 — Refresh + device-deletion race.** iOS-side error handling
  pattern: route 401-after-DELETE-to-login. The server is already
  correct (returns 401 with `revoked`); the iOS error path is the
  question.

### Summary table

| #                         | Server-blocker | Mixed | iOS-only |
| ------------------------- | -------------- | ----- | -------- |
| Q1 rename                 | ✓              |       |          |
| Q2 externalId shape       |                | ✓     |          |
| Q3 sleepStage codepoints  |                | ✓     |          |
| Q4 unit pre-conversion    | ✓              |       |          |
| Q5 unknown identifiers    |                | ✓     |          |
| Q6 APNs hex format        | ✓              |       |          |
| Q7 apnsEnvironment        | ✓              |       |          |
| Q8 token rotation         |                | ✓     |          |
| Q9 multi-device cascade   |                |       | ✓        |
| Q10 collapseId shape      |                |       | ✓        |
| Q11 device-list rendering |                |       | ✓        |
| Q12 X-Device-Id header    |                |       | ✓        |
| Q13 refresh-after-delete  |                |       | ✓        |

**Four server-blockers, four mixed, five iOS-only.** The iOS author can
land Q9-Q13 in any order as the UX comes together. Q1, Q4, Q6, Q7 must
be solved before the first POST or the first push registration. Q2, Q3,
Q5, Q8 should be settled in writing before TestFlight so two-device
users don't get bad-data.

---

## 7. Google Fit / Health Connect headroom — schema decisions to lock now

The briefing is explicit that Google Fit / Health Connect is NOT
v1.5 scope, but: are there schema decisions that would box us out of a
v1.6+ adapter? Worth scrubbing now because once v1.5 ships, the contract
is harder to evolve.

**Google Fit (REST API) was sunsetted by Google in May 2024; new
integrations must use Health Connect** (the on-device-only Android
successor). So when we say "Google Fit adapter" we now mean **Health
Connect** for Android.
([Health Connect data type format — Android Developers](https://developer.android.com/health-and-fitness/health-connect/data-format),
[Users.dataSources — Google Fit](https://developers.google.com/fit/rest/v1/reference/users/dataSources))

### What's already safe

- **`MeasurementSource` enum.** Adding `HEALTH_CONNECT` (or
  `GOOGLE_FIT` if Marc wants the historically-recognisable name) is
  one ALTER TYPE in a migration; the enum is already designed for
  multi-source. No change needed in v1.5.
- **`externalId` as opaque string up to 120 chars** (Zod cap at
  `src/app/api/measurements/batch/route.ts:48`). Health Connect's IDs
  are UUIDs in practice, and Google Fit's dataStreamId path-style
  identifiers (e.g.
  `raw:com.google.step_count.delta:com.example.app:DataSource:account:android:Pixel 6`)
  are also well under 120 chars but longer than HealthKit UUIDs. Cap
  is fine. Note that Google Fit's IDs were path-shaped, not UUID-shaped
  — the Zod schema accepts both, which is correct.
- **Composite unique index `(user_id, type, source, external_id)`.**
  Per-source dedup means Health Connect and Apple Health can both
  have an `external_id = "12345"` and not collide. Right shape.
- **`MeasurementType` enum coverage.** Health Connect's quantity
  categories overlap heavily with what we mapped for HealthKit —
  Steps, BodyMass, BloodPressure (sys/dia as separate records, same
  as our split), HeartRate, RestingHeartRate, HRV, SleepSession,
  OxygenSaturation, BodyFat, BodyTemperature, ActiveCaloriesBurned,
  TotalCaloriesBurned, Distance, FloorsClimbed, Vo2Max. All map cleanly
  to existing `MeasurementType` values **except**:
  - **TotalCaloriesBurned** is distinct from ACTIVE_ENERGY_BURNED
    (which is HealthKit's name and our enum). HealthKit also exposes
    a `basalEnergyBurned` we didn't map. If P4+ wants total-energy
    analytics, the right pre-emptive move is to add a comment in the
    `MeasurementType` enum noting the gap; we don't need the new enum
    value yet.
  - **ExerciseSession / WorkoutSession** has no equivalent in our
    schema — we don't model workouts. Out of scope for v1.5 and v1.6;
    flag for v1.7+.

### What to harmonise NOW (before v1.5 freezes the iOS contract)

1. **The `externalSourceVersion` column.** Already shipped (migration
   `0036`); good. Health Connect records have a `metadata.dataOrigin.packageName`
   (the writing-app's Android package) and a `metadata.device` blob —
   parallel concept to HealthKit's `sourceRevision`. Keep storing the
   source-system's opaque version string here; Health Connect can land
   its packageName here in v1.6.
2. **Unit conversions.** The HealthKit-specific 0..1 fraction → percent
   conversions for SpO2 and BodyFat live in
   `src/lib/measurements/apple-health-mapping.ts:103, 222`. Health
   Connect's `OxygenSaturationRecord` already uses Percentage (0..100),
   so the eventual `health-connect-mapping.ts` will have identity
   conversions there. **Recommendation: do not move the conversion to
   the server's generic ingest path.** Keep it source-specific. The
   composability that gives us is: a future Health Connect adapter can
   skip the multiply, Withings continues skipping it, Apple Health
   multiplies. The current shape is already correct.
3. **Identifier mappings as a _table per source_, not a global table.**
   `apple-health-mapping.ts` is the right pattern. When Health Connect
   ships, the right shape is a sibling `health-connect-mapping.ts`
   keyed by Android record-class name (`StepsRecord`, etc.). DO NOT
   land a single global identifier map; the two systems have similar
   but non-identical semantics (e.g. Apple Health's `stepCount` is
   per-sample-instant; Health Connect's `StepsRecord` carries
   `startTime/endTime` and a count, so it's already aggregated
   server-side from sensor data). Per-source maps means the per-source
   semantics live alongside the identifier.
4. **Sleep-stage codepoint domain.** Apple uses 0-5 (iOS 16+); Health
   Connect uses string constants (`STAGE_TYPE_AWAKE`,
   `STAGE_TYPE_LIGHT`, `STAGE_TYPE_DEEP`, `STAGE_TYPE_REM`, etc.). The
   server accepts integers 0-20 today. **For Health Connect, the
   `health-connect-mapping.ts` should translate string → integer on
   the adapter boundary so the server's
   `SleepStage` enum stays the canonical representation.** This means
   v1.5's iOS-DTO numeric codepoint is the right wire shape — don't
   switch to strings.
5. **Aggregation hints.** The `aggregation` field in
   `AppleHealthMapping` (`sum | mean | latest | max | median`) is
   advisory metadata for downstream analytics. Health Connect's
   `StepsRecord` is already aggregated (start/end interval with a
   count), so the v1.6 adapter would post a single row per
   interval with `aggregation: "sum"`. Consistent.

### What NOT to do prematurely

- Don't add a `HEALTH_CONNECT` enum value to `MeasurementSource` in
  v1.5. ALTER TYPE is additive and free; landing it before there's
  a code path that writes it just adds dead branches.
- Don't generalise `apple-health-mapping.ts` into a multi-source
  router. Keep it Apple-specific; create a sibling when the time
  comes.
- Don't move unit conversion to a server-side "canonical unit"
  helper. The per-source convert function is exactly where it
  belongs.

### One existing schema risk worth flagging

The two-unique-indexes shape on `Measurement`:

```
@@unique([userId, type, measuredAt, source])     // legacy
@@unique([userId, type, source, externalId])     // v1.4.23
```

Means two Health Connect samples with the same `measuredAt` (a watch
sampling at exactly 09:31:00.000 twice in different sessions) would
collide on the legacy index even with distinct `externalId`. This is
the same constraint Apple Health works under and it has not bitten us
because Apple's UUIDs map 1:1 to distinct millisecond instants in
practice. Health Connect may emit two sensor records at the same wall
clock if two apps both write at once. **Recommendation: don't fix
this for v1.5; flag it as a v1.6 audit item before the Health Connect
adapter lands.** The legacy index is what the manual-UI "no duplicate
at the same wall-clock" guard depends on, so dropping it isn't free.

---

## Appendix — recommended P2 file layout

For the iOS author. Building on the existing scaffold at
`/Users/marc/Projects/healthlog-iOS/HealthLogIOS/HealthLog/`:

```
Services/
  HealthKitService.swift           # already 238 lines; add per-userId anchor keying
  SyncCoordinator.swift            # NEW — orchestrates anchored-query + batch POST + reconciliation
  HealthKitStatisticsService.swift # NEW — HKStatisticsCollectionQuery wrapper for cumulative types
Models/
  HealthKitSync.swift              # already 32 lines; add MetricKind ↔ HK type mapping table here
  MeasurementDTO.swift             # already 246 lines; ONE-LINE rename HEALTHKIT → APPLE_HEALTH
Repositories/
  HealthKitBatchUploader.swift     # NEW — talks to /api/measurements/batch, parses per-entry status
  HealthKitReconciler.swift        # NEW — implements the deletion-sync reconcile path (§3 Option A)
```

Server-side: **zero new files for the core sync.** ONE optional new
route if Marc chooses to ship deletion-sync as a server contract:

```
src/app/api/measurements/by-external-ids/route.ts   # DELETE — bulk delete by externalId
```

If we punt deletion-sync to v1.5.1 (acceptable; Marc only manually
deletes from Health.app rarely), even that new route can wait.

---

## Sources

Apple Developer Documentation:

- [HKAnchoredObjectQuery](https://developer.apple.com/documentation/healthkit/hkanchoredobjectquery)
- [HKObserverQuery](https://developer.apple.com/documentation/healthkit/hkobserverquery)
- [enableBackgroundDelivery(for:frequency:withCompletion:)](<https://developer.apple.com/documentation/HealthKit/HKHealthStore/enableBackgroundDelivery(for:frequency:withCompletion:)>)
- [com.apple.developer.healthkit.background-delivery entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.background-delivery)
- [HKStatisticsCollectionQuery](https://developer.apple.com/documentation/healthkit/hkstatisticscollectionquery)
- [HKSourceRevision](https://developer.apple.com/documentation/healthkit/hksourcerevision)
- [HKQuery.predicateForObjectsFromSourceRevisions](https://developer.apple.com/documentation/healthkit/hkquery/1614791-predicateforobjectsfromsourcerev?language=objc)
- [HKDeletedObject behaviour — Apple Developer Forums #22012](https://developer.apple.com/forums/thread/22012)
- [Step Data Duplication — Apple Developer Forums #759709](https://developer.apple.com/forums/thread/759709)
- [WatchOS observer-query budget — Apple Developer Forums #781261](https://developer.apple.com/forums/thread/781261)
- [Beyond counting steps — WWDC20 video](https://developer.apple.com/videos/play/wwdc2020/10656/)
- [Synchronize health data with HealthKit — WWDC20 video](https://developer.apple.com/videos/play/wwdc2020/10184/)

Third-party reference material:

- [HealthKit changes observing — topolog.dev](https://dmtopolog.com/healthkit-changes-observing/)
- [How to Use HKAnchoredObjectQuery — DevFright](https://www.devfright.com/how-to-use-healthkit-hkanchoredobjectquery/)
- [Synchronizing HealthKit data — Girotto, Medium](https://medium.com/@guilhermegirotto/synchronizing-healthkit-data-bca411a7a15c)
- [Challenges with HKObserverQuery and Background App Refresh — Puri, Medium](https://medium.com/@shemona/challenges-with-hkobserverquery-and-background-app-refresh-for-healthkit-data-handling-8f84a4617499)
- [Mastering HealthKit pitfalls — Barabash, Medium](https://medium.com/mobilepeople/mastering-healthkit-common-pitfalls-and-solutions-b4f46729f28e)
- [SpeziHealthKit anchored-query patterns](https://github.com/stanfordspezi/spezihealthkit)
- [Microsoft health-data-sync — README](https://github.com/microsoft/health-data-sync/blob/master/README.md)

Comparator platforms:

- [Withings Public API integration guide](https://developer.withings.com/developer-guide/v3/integration-guide/public-health-data-api/public-health-data-api-overview/)
- [Health Connect data type format — Android Developers](https://developer.android.com/health-and-fitness/health-connect/data-format)
- [Google Fit Users.dataSources (deprecated; reference for migration)](https://developers.google.com/fit/rest/v1/reference/users/dataSources)
