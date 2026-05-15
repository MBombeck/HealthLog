---
file: 22-standalone-and-server-pairing.md
purpose: Standalone usage option and optional server pairing for the HealthLog iOS client — three viable patterns, the recommended pattern, pairing + sync triggers, conflict policy, feature parity, server preps deferred to v1.4.28
when_to_read: After 06-ios-responsibilities.md and 13-state-management.md; before any iOS-side storage refactor, pairing surface, or sync-trigger work
prerequisites: 00-philosophy.md, 06-ios-responsibilities.md, 08-locked-contracts.md, 13-state-management.md
estimated_tokens: ~4700
version_anchor: v1.4.27 / develop @ 0f536913
status: research handoff — no server-side work in v1.4.27; server preps land in v1.4.28
---

## TL;DR

The iOS client today is server-first with a typed Outbox queue. The R1.5 research directive (v1.4.27) is to invert the default: SwiftData becomes the canonical store, the HealthLog server becomes an optional sync mirror, and pairing is a user-driven setting rather than an onboarding precondition. The user can install the app, enter data, watch charts, and import from HealthKit without ever creating a server account; pairing later is one Settings toggle and a single backfill upload. Conflict resolution lands on per-row last-writer-wins keyed by an Apple-style `syncIdentifier + syncVersion` pair. Server-derived surfaces (Health Score, Insights, Coach) remain server-only and degrade to a "pair to enable" placeholder in standalone mode. No server-side migration ships in v1.4.27; `syncVersion`, `deletedAt`, and `GET /api/sync/state` land in v1.4.28 once the iOS client emits the corresponding fields.

## STOP HERE if…

- You are looking for the existing Outbox + idempotency-key contract — read `06-ios-responsibilities.md` § Domain 4 and `13-state-management.md` § iOS analogues first.
- You are building the v1.4.27 server release — this file is reference only; no server change ships in v1.4.27 from this doc.
- You are building the first-pair backfill — start at § 3.3 and cross-reference `08-locked-contracts.md` § batch ingest contract.

## 1. The three patterns

Six comparable iOS health apps were surveyed in R1.5 (Apple Health, Withings Health Mate, Pillow, Bearable, AutoSleep, Heartwatch). They split into three architectural buckets, and HealthLog's iOS client can sit in any of them. Picking the bucket is the first decision; the rest of this file is downstream of that choice.

| Pattern | Storage of record | Server role | Account required | Effort | User impact |
|---|---|---|---|---|---|
| **A. Standalone-first + optional server pairing** | SwiftData on device | Optional mirror; gates server-derived surfaces only | No — pairing is a deliberate later action | Moderate–high | Matches the directive verbatim; ground-rule "no cloud lock-in" preserved |
| B. HealthKit-canonical + HealthLog server as derived-data mirror | HealthKit on device | Mirror for non-HealthKit surfaces (mood, medication intake, Coach context) | No | High — requires HealthKit write-back, currently out of scope per `06-ios-responsibilities.md` | Maximum platform-fit; user owns data through Apple's own export tools |
| C. Status quo + cosmetic banner | HealthLog server | Canonical | Yes — onboarding wall as today | Trivial | Ignores the directive; retroactively impossible to roll back |

**Decision: Pattern A.** It is the only one that honours both the no-server-required directive and the v1.5 read-only HealthKit posture locked in `06-ios-responsibilities.md`. Pattern B is a v1.6-class change — leave it on the table for the day HealthKit write-back is in scope. Pattern C is the do-nothing option and is rejected.

The model the iOS client should mirror is Apple Health itself: on-device first, optional sync as a single user toggle, no migration prompt either way. The difference is that the sync target is the HealthLog server rather than iCloud.

## 2. What "works without an internet connection" means here

The app is fully usable without a server, without an account, and without a network. The standalone option is not a degraded fallback for outages; it is a first-class operating mode the user can elect indefinitely. Network outages while paired are a separate, narrower concern handled by the existing Outbox replay (see `06-ios-responsibilities.md` § Domain 4).

Concretely, in standalone mode:

- The user can install the app and immediately enter measurements, mood, medication intake, and HealthKit imports.
- Every list view, every chart, every entry sheet renders from SwiftData.
- No bearer token exists, no Outbox row is enqueued, no batch POST is attempted.
- Server-derived surfaces (Daily Briefing, Health Score, Insights, Coach, Doctor Report) render an explanatory placeholder with a "Pair with HealthLog server" CTA.

The user is not locked in either direction. Pairing later uploads the local history in one shot; unpairing later leaves the local data intact and wipes the bearer token.

## 3. Pattern A — full specification

### 3.1 Canonical store

SwiftData is the source of truth for every user-entered row:

- `Measurement`
- `MoodEntry`
- `MedicationIntake`
- existing `OutboxOperation` rows

Read paths render from SwiftData first, never from the server cache. The server's `MeasurementListWireResponse` is treated as a sync delta against SwiftData, not a primary read.

### 3.2 SyncMode enum

A new `SyncMode` enum lives in `UserDefaults` and gates every network repository call:

```swift
enum SyncMode: String, Codable {
    case standalone
    case paired
}
```

**Standalone mode behaviour:**
- Write paths skip the Outbox enqueue and the API POST entirely; data persists to SwiftData and stops there.
- Read paths fetch from SwiftData only.
- `AuthenticatedShell` hides the Settings → Account row that exposes paired-only state.
- Server-derived surfaces render a "Pair with HealthLog server" placeholder.

**Paired mode behaviour:**
- Exactly the current implementation: Outbox replay runs, server is canonical for derived surfaces, SwiftData is a write-through cache for user-entered rows.

Default for fresh installs is `.standalone`. Default for existing installs migrating off the current server-first build is `.paired` — they already have an account and an Outbox, the inversion should not invalidate either.

### 3.3 Pairing flow

What triggers it, what the iOS client sends, what the server returns:

1. User taps "Pair with HealthLog server" in Settings → Account → Server pairing.
2. An onboarding-style sheet collects: server URL (default `healthlog.bombeck.io`), email + password OR passkey, biometric consent.
3. iOS posts the credential exchange against the standard auth surface from `05-auth-flows.md` and stores the bearer token in Keychain.
4. iOS enumerates every SwiftData row created in standalone mode, partitions them into ≤500-row idempotency-keyed batches, and POSTs to the existing locked endpoints:
   - `/api/measurements/batch` for every `Measurement` row
   - `/api/mood-entries/bulk` for every `MoodEntry` row
   - `/api/medications/intake/bulk` for every `MedicationIntake` row
5. The server returns a per-row dedup verdict (`inserted | duplicate | skipped`) keyed off the existing `(user_id, type, source, external_id)` composite unique index (Migration 0048, shipped W16b). Re-runs are safe; a row that survived a partial upload returns `duplicate` on the retry.
6. After the backfill commits, `SyncMode` flips to `.paired` and the normal Outbox + observer flow takes over.

The batch contract is the locked contract from `08-locked-contracts.md` § batch ingest. The pairing flow introduces no new endpoint; idempotency keys are reused verbatim. The server cannot tell a first-pair backfill apart from any other batch — and does not need to.

### 3.4 Unpair flow

User taps "Unpair" in Settings → Account → Server pairing:

1. Confirmation sheet: "Local data stays on this device; server data remains on the server."
2. One-shot upload of any rows still in the Outbox so the next pair does not lose them.
3. Wipe the bearer token from Keychain.
4. Flip `SyncMode` to `.standalone`.
5. Server-derived surfaces revert to placeholders.

Re-pairing the same account later refetches the server's snapshot via the standard list endpoints.

### 3.5 Sync triggers

In `.paired` mode the client sends and pulls data on these triggers:

- **App launch** → fetch derived surfaces (Daily Briefing, Health Score, Insights) and run the Outbox replay.
- **App foreground** (any time after the first launch while the process is alive) → same as launch.
- **App backgrounded** (`UIApplication.willResignActiveNotification` or `applicationDidEnterBackground`) → flush the Outbox; do not block the transition.
- **Reachability change** (offline → online) → run the Outbox replay; refresh derived surfaces.
- **Background processing task** (`dev.healthlog.app.healthkit-sync`) — already scheduled per `06-ios-responsibilities.md` § Domain 4; gain a `SyncMode == .paired` guard.
- **Explicit pull-to-refresh** on any list view → fetch + invalidate the matching TanStack-Query-equivalent SwiftData read.
- **First pairing** → one-shot backfill per § 3.3.

In `.standalone` mode none of the above fires a network call.

### 3.6 What does NOT change

- HealthKit read-only contract per `06-ios-responsibilities.md` § Domain 1. Standalone mode still imports HealthKit samples — they land in SwiftData rather than being uploaded.
- MDR 2017/745 boundary per `00-philosophy.md` § Rule 10. Coach, Insights, and Health Score remain server-only; standalone-mode users see placeholders, never client-generated stand-ins.
- Outbox + idempotency-key infrastructure (ADR-011 + ADR-012). Reused verbatim for the backfill.

## 4. Conflict resolution policy

Per-row last-writer-wins, keyed by an Apple-style sync identifier + version. The pattern mirrors `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion` at the HealthLog row level. The server-side columns are additive and deferred to v1.4.28 — see § 6.

### 4.1 Per-row sync identifier

Every SwiftData row carries a stable `syncIdentifier: UUID` assigned at creation time. It is the same UUID the iOS client already sends as `externalId` in the batch contract; the rename is wire-level only and requires no migration.

### 4.2 Per-row sync version

Every mutation increments a `syncVersion: Int` on the row:

```swift
@Model
class Measurement {
    var syncIdentifier: UUID
    var syncVersion: Int = 1
    var deletedAt: Date?
    // ...
}
```

The batch upload carries both fields. The existing composite-unique index handles inserts as it does today. For an existing row the server compares the inbound `syncVersion` and upserts iff the inbound number is strictly higher. The column lands in v1.4.28; until then the field is accepted-and-ignored by the server.

### 4.3 The six rules, ranked by frequency

1. **New row on one side, absent on the other → last-writer-wins by `syncVersion`.** The common case for offline-then-online round trips. The composite-unique index already enforces dedup on `(user_id, type, source, external_id)`; once `syncVersion` ships, the server upserts only when the inbound version is strictly higher.

2. **Same row edited on both sides while offline → higher `syncVersion` wins; lower is dropped.** Identical to Apple HealthKit's `HKMetadataKeySyncVersion` semantics. Whichever device reaches the server first wins; the loser's edit is silently dropped on the next pull. No merge UI — the surface (a measurement value, a mood note, a medication intake timestamp) is too small to justify a manual-resolve dialog.

3. **Deletion on one side, edit on the other → tombstone wins.** Client sends a tombstone row (same `syncIdentifier`, `deletedAt` set, `syncVersion` bumped). The server soft-deletes; on the next pull the edit-side reverts to deleted state. Deliberate choice — accidentally undoing a deletion is worse than accidentally losing an edit, given the kind of data HealthLog tracks.

4. **Server-derived surfaces → server wins always.** Health Score, Insights, Coach replies. The client never computes, never merges. On reconnect the client invalidates the local snapshot and re-fetches. This is the MDR boundary, preserved by construction.

5. **Settings + preferences → server wins when paired; client wins when standalone.** A user who pairs an account inherits the server's preferences (locale, timezone, CoachPrefs, notification channels). On unpair, the local preference snapshot is preserved. Re-pairing the same account replaces the local snapshot with the server's current state.

6. **HealthKit-imported rows → unchanged.** Per-row dedup via `externalId` (= HK sample UUID), already in place via the batch ingest contract and the v1.4.25 W8c `deviceType` column.

### 4.4 What we explicitly do NOT do

- **No three-way merge with operational transform or CRDTs.** The data shape is too coarse — one value, one note, one timestamp — to justify the complexity. Apple's own HKQuantitySample sync rejects this in favour of identifier + version; we follow.
- **No client-side conflict-prompt UI.** Health data with a manual-resolve dialog every reconnect would be unusable. Apple Health does not show one; AutoSleep does not show one; we will not invent one.
- **No "merge by averaging" for numeric values.** A weight of 82.0 kg and 82.4 kg do not average to 82.2 kg — they are two different facts and the latest fact wins.
- **No optimistic-on-server retries that contradict the client.** If the server holds an edit at `syncVersion = 3` and the client sends `syncVersion = 2`, the server returns the row at `syncVersion = 3` in the response and the client adopts it.

## 5. Feature parity matrix

Server feature inventory taken from `06-ios-responsibilities.md`, `07-server-responsibilities.md`, and the live `Screens/` directory in the iOS repo at the iOS v0.3.0 snapshot.

| Server feature | iOS counterpart | Standalone | Needs server | Graceful degradation |
|---|---|---|---|---|
| Dashboard hero greeting | DailyBriefingHero (paired-fed) | Greeting yes | — | Greeting renders; briefing card shows placeholder |
| Daily Briefing | DailyBriefingHero | — | yes | "Pair to enable Daily Briefing" placeholder |
| Health Score tile (4-pillar ring) | HealthScoreStore + Detail Sheet | — | yes | "Pair to enable Health Score" placeholder |
| Trend strip (weight, BP, pulse, glucose, BMI) | ChartsStore + ChartDetailStore | yes | — | Full functionality from SwiftData |
| Measurement entry sheets | MeasurementEntrySheet | yes | — | None |
| HealthKit import pipeline | HealthKitService → MeasurementBatchUploader | yes | — | Lands in SwiftData directly; uploaded later if paired |
| Personal Records | Server-resident; iOS deep-links to PR detail | — | yes | PR badges hidden in standalone |
| GLP-1 therapy card | Not yet on iOS (v0.4 surface) | — | yes | Placeholder; arrives in iOS v0.4 |
| Coach screen | Not yet on iOS (v0.4 surface) | — | yes | "Pair to enable Coach" placeholder |
| Insights screen | InsightsScreen (paired-fed) | — | yes | "Pair to enable Insights" placeholder |
| Doctor Report PDF | DoctorReportScreen (server-rendered) | — | yes | CTA hidden in standalone |
| Withings sync | Server-only | — | yes | CTA hidden in standalone |
| Telegram notifications | Server-only | — | yes | Disabled |
| APNs push delivery | NotificationsStore + DeviceID flow | — | yes | Standalone unsubscribes; no token registered |
| Audit log | AuditLogScreen | yes (local) | partial | Local-only ring buffer; server log absent |
| Export (CSV / JSON) | ExportScreen | yes (local CSV) | partial | New local-export path needed for standalone — small effort |
| Account deletion | DeleteAccountScreen | — | yes | Hidden in standalone (no account) |
| Passkey login | PasskeyService | — | yes | Hidden in standalone |
| Biometric unlock | BiometricGate | yes | — | None — gates the app, not the account |
| Multi-device sync | Outbox + batch | — | yes | Single-device in standalone; pairing restores it |
| Settings (units, locale, theme) | SettingsScreen | yes | partial | Server preferences sync on pair |

About 70 % of the iOS surface works fully in standalone mode. The 30 % that requires the server (Health Score, Briefing, Insights, Coach, PDF, multi-device) gates cleanly behind a placeholder card with a single "Pair with HealthLog server" CTA. No card pretends to render server data offline; no card silently disappears.

## 6. Server-side preparations

### 6.1 v1.4.27 (this release)

**None.** The iOS inversion ships purely on the client. The existing batch + idempotency + composite-unique-index infrastructure shipped in W16b is sufficient for standalone-then-paired backfills today.

### 6.2 v1.4.28 (next release)

The full server prep menu, all additive, all no-op for clients that have not yet upgraded:

| Capability | Status today | Action in v1.4.28 |
|---|---|---|
| `syncVersion Int @default(1)` column on `Measurement` | Not present | Additive Prisma column; server compares on upsert; client always sends |
| `deletedAt DateTime?` soft-delete column on `Measurement` | Not present (hard delete via `/api/measurements/[id]` DELETE) | Additive Prisma column + `(user_id, deletedAt)` index; tombstone propagation |
| `GET /api/sync/state` | Not present | Read-only endpoint returning last-seen `syncIdentifier` + max `syncVersion` per `MeasurementType`; cheap delta queries on reconnect |
| ETag / `If-Modified-Since` on read endpoints | Not present on Dashboard / Insights / Health Score routes | Battery + bandwidth optimisation on reconnect |

None of the four breaks an existing client. The iOS client falls back gracefully when the server has not yet shipped them — `syncVersion` is optional in the wire format; a missing `deletedAt` means tombstones do not propagate and a hard delete on one device disappears on the other (acceptable until the column lands).

### 6.3 Deferred indefinitely

- **HealthKit write-back** — Pattern B architecture; v1.6 at earliest.
- **Local Personal-Record detection in standalone** — the MDR boundary holds; PR detection lives server-side.
- **Local Coach in standalone** — Coach calls a server-side LLM provider; no on-device equivalent respects the safety contract.
- **Conflict-resolution UI** — see § 4.4.

## 7. Cross-references

- `00-philosophy.md` § Rule 9 — why a server exists at all
- `00-philosophy.md` § Rule 10 — the MDR 2017/745 boundary the server preserves
- `06-ios-responsibilities.md` § Domain 1 — HealthKit ingest contract (reused verbatim)
- `06-ios-responsibilities.md` § Domain 4 — the cache + sync queue this proposal inverts
- `07-server-responsibilities.md` — every domain that becomes a placeholder in standalone mode
- `08-locked-contracts.md` § batch ingest — the contract the first-pair backfill reuses
- `13-state-management.md` § iOS analogues — read-path keys mapping to SwiftData queries
- `22-offline-first-architecture.md` — sibling reference doc from R1.5; same research, earlier framing
- ADR-005 (`SwiftData fuer Caches + Outbox`) — the foundation this proposal builds on
- ADR-011, ADR-012 (Outbox persistence + file protection) — preserved verbatim
- Apple developer documentation on `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion` — the contract this proposal mirrors at the HealthLog row level

## 8. Sequencing recommendation

The order keeps the iOS client deployable at every step. Standalone lands first as a complete operating mode; pairing lands second as an opt-in; the conflict-resolution wire fields land third once the server is ready.

1. **Add the `SyncMode` enum** to `UserDefaults`; default `.standalone` for fresh installs, `.paired` for migrating installs.
2. **Add SwiftData properties** `syncIdentifier: UUID` (rename of the existing `externalId`), `syncVersion: Int = 1`, `deletedAt: Date?` to every persisted row type.
3. **Gate every network repository call** on `SyncMode == .paired`.
4. **Build the Settings → Account → Server pairing surface** with the standalone badge, the pair sheet, and the unpair confirmation.
5. **Wire the cloud-derived placeholders** — every Daily Briefing / Health Score / Insights / Coach surface checks `SyncMode` first and renders a "Pair with HealthLog server" CTA when standalone.
6. **Build the first-pair backfill** — enumerate SwiftData rows, partition into ≤500-row chunks, POST via `/api/measurements/batch`, `/api/mood-entries/bulk`, `/api/medications/intake/bulk`.
7. **Hold the `syncVersion` wire field** until v1.4.28 lands the server column. Sending it earlier is safe but the server will ignore it.
