---
file: 22-offline-first-architecture.md
purpose: Offline-first architecture for the HealthLog iOS client — competitive landscape, target pattern, pairing flow, sync conflict policy, feature parity, server-side preps
when_to_read: After 06-ios-responsibilities.md and 13-state-management.md; before any iOS-side storage refactor or pairing-flow build.
prerequisites: 00-philosophy.md, 06-ios-responsibilities.md, 08-locked-contracts.md, 13-state-management.md
estimated_tokens: ~4600
version_anchor: v1.4.27 / develop @ d16a627d
status: research handoff — no server-side work in v1.4.27; server preps land in v1.4.28
---

## TL;DR

The iOS client today is server-first with a typed Outbox queue. The new directive (v1.4.27 R1 research) is to invert the default: SwiftData becomes the canonical store, the HealthLog server becomes an optional sync mirror, pairing is a user-driven setting rather than an onboarding precondition. Conflict resolution lands on per-row last-writer-wins keyed by an Apple-style `syncIdentifier + syncVersion` pair, with the server retaining authority only for derived data (Health Score, Insights, Coach replies) the client never recomputes. No server-side migration is required for v1.4.27 — the iOS client owns the inversion, the server side gains `syncVersion` + `deletedAt` columns + `GET /api/sync/state` in v1.4.28 once the iOS client is ready to consume them.

## STOP HERE if…

- You are looking for the current Outbox + idempotency-key contract — read `06-ios-responsibilities.md` § Domain 4 and `13-state-management.md` § iOS analogues first.
- You are building the v1.4.27 server release — this file is reference only; no server change ships in v1.4.27 from this doc.
- You are building the iOS first-pair migration flow — start with the "Pairing flow" section below and cross-reference `08-locked-contracts.md` § batch ingest contract.

## 1. Competitive landscape

Six comparable iOS health apps split into three architectural buckets.

### 1.1 System-bundled (Apple Health)

On-device first; iCloud sync is optional + opt-in via Settings → Health → "Sync this iPhone". No account beyond the device-level Apple ID. Conflict: `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion`; higher version overwrites lower; transaction-safe. UX consequence: user can use the entire Health app with iCloud sync off; turning sync on is a single toggle, no migration prompt, no data loss; data already on-device just starts replicating to other devices.

This is the model HealthLog iOS should mirror — at the row level, against the HealthLog server instead of iCloud.

### 1.2 Cloud-mandatory (Withings Health Mate, Bearable)

Server is canonical; offline is a short-lived cache only. Withings devices "become useless" without account acceptance per Withings' own support thread. Bearable shows a sign-up wall but is client-side-encrypted before upload. Conflict path: server wins by default, last successful upload sets state.

This is what HealthLog iOS does today — and what the directive asks to invert.

### 1.3 On-device-only / iCloud-backup (Pillow, AutoSleep, Heartwatch)

No proprietary cloud. AutoSleep + Heartwatch read HealthKit exclusively and have App Store privacy labels reading "Data Not Collected". Pillow is anonymous by default; iCloud is positioned as backup, not as sync mode, and the iCloud data is encrypted such that even Pillow cannot read it.

This is what HealthLog iOS would become if pairing were never enabled by the user — full functionality minus the server-derived surfaces.

## 2. Target architecture

Three patterns were considered.

| Pattern | User impact | Effort | Recommendation |
|---|---|---|---|
| **A. On-device-first + optional HealthLog cloud sync** | Matches directive verbatim; standalone is default; pairing is deliberate later action | Moderate–high (the toggle, the cloud-derived placeholders, the first-pair migration flow) | **Recommended** |
| B. HealthKit as canonical store + HealthLog cloud as derived-data mirror | Maximum platform-fit; user owns data via Apple's own export | High (HealthKit-write is out of scope per `06-ios-responsibilities.md`; v1.6-class change) | Defer to iOS v1.6 |
| C. Status quo + cosmetic offline banner | Ignores directive; onboarding wall for unpaired users | Trivial | Reject |

**Decision: Pattern A.** Preserves the v1.5 read-only HealthKit posture, leaves Pattern B available as a v1.6 follow-up.

## 3. Pattern A — full specification

### 3.1 Canonical store

SwiftData is the source of truth for every user-entered row:

- `Measurement`
- `MoodEntry`
- `MedicationIntake`
- existing `OutboxOperation` rows

Read paths render from SwiftData first, never from the server cache. The server's `MeasurementListWireResponse` is treated as a sync delta, not a primary read.

### 3.2 SyncMode enum

A new `SyncMode` enum lives in `UserDefaults`:

```swift
enum SyncMode: String, Codable {
    case standalone
    case paired
}
```

The enum gates every network repository call.

**Standalone mode behaviour:**
- All write paths skip the Outbox enqueue + API POST entirely; data persists to SwiftData and stops there.
- All read paths fetch from SwiftData only.
- `AuthenticatedShell` hides the Settings → Account row that exposes pairing state.
- Cloud-derived surfaces (Daily Briefing hero, Health Score tile, Insights cards, Coach screen) render an explanatory placeholder with a "Pair with HealthLog server" CTA.

**Paired mode behaviour:**
- Exactly the current implementation: Outbox replay runs, server is canonical for derived surfaces, SwiftData is a write-through cache for user-entered rows.

### 3.3 Pairing flow

1. User taps "Pair with HealthLog server" in Settings → Account.
2. Onboarding-style sheet collects: server URL (default `healthlog.bombeck.io`), email + password OR passkey, biometric consent.
3. On successful sign-in: app enumerates every SwiftData row created in standalone mode, packages them into ≤500-row idempotency-keyed batches, POSTs to:
   - `/api/measurements/batch` (every Measurement row)
   - `/api/mood-entries/bulk` (every MoodEntry row)
   - `/api/medications/intake/bulk` (every MedicationIntake row)
4. Per-row dedup is server-enforced via the existing `(user_id, type, source, external_id)` composite unique index (W16b). Re-runs are safe; the server returns `status: "duplicate"` for any row that survived a prior partial upload.
5. After the initial backfill finishes, `SyncMode` flips to `.paired` and the normal Outbox + observer flow takes over.

The batch contract is the existing locked contract from `08-locked-contracts.md` § batch ingest. No new endpoints; the pairing flow reuses idempotency keys verbatim.

### 3.4 Unpair flow

User taps "Unpair" in Settings → Account → Server pairing:

1. Confirmation sheet ("Local data stays on this device; server data remains on the server").
2. One-shot upload of any unsynced rows (so the user does not lose data the next time they pair).
3. Wipe the bearer token from Keychain.
4. Flip `SyncMode` to `.standalone`.
5. Cloud-derived surfaces revert to placeholders.

The next pairing on the same account would re-download server data via the standard list endpoints.

### 3.5 Sync triggers

- **App foreground** in paired mode → run the Outbox replay once + fetch derived surfaces.
- **Reachability change** (offline → online) → same as foreground.
- **Background processing task** (`dev.healthlog.app.healthkit-sync`) — already in place; gain a paired-mode check.
- **Explicit pull-to-refresh** on any list view → fetch + invalidate.
- **First pairing** → one-shot backfill (see § 3.3).

### 3.6 What does NOT change

- HealthKit read-only contract per `06-ios-responsibilities.md`. Standalone mode still imports HealthKit samples — they land in SwiftData instead of being uploaded.
- MDR boundary: derived surfaces (Coach, Insights, Health Score) remain server-only. Standalone-mode users see placeholders, not client-generated stand-ins.
- Outbox + idempotency-key infrastructure is reused verbatim for the backfill batch upload.

## 4. Conflict resolution policy

Per-row last-writer-wins keyed by an Apple-style sync identifier + version.

### 4.1 Per-row sync identifier

Every SwiftData row gets a stable `syncIdentifier` (UUID) at creation time. It is the same UUID the iOS client already sends as `externalId` in the batch contract. Reusing the column means no migration on the iOS side beyond renaming the property in the wire format.

### 4.2 Per-row sync version

Every mutation increments a `syncVersion` integer on the row:

```swift
@Model
class Measurement {
    var syncIdentifier: UUID
    var syncVersion: Int = 1
    var deletedAt: Date?
    // ...
}
```

The batch upload payload carries both `syncIdentifier` and `syncVersion`. The server's existing composite-unique index handles inserts as it does today; for an existing row, the server compares the inbound `syncVersion` and upserts iff the inbound number is strictly higher.

### 4.3 The six rules, ranked by frequency

1. **New row on one side, absent on the other → last-writer-wins by `syncVersion`.** Default case for offline-then-online round trips.

2. **Same row edited on both sides while offline → higher `syncVersion` wins, lower is dropped.** Identical to Apple HealthKit's `HKMetadataKeySyncVersion` semantics. Whichever device sees the server first wins; the loser's edit is silently dropped on the next pull. No merge UI — the surface (a measurement value, a mood-entry note) is small enough that a "merge" prompt would be more confusing than the loss.

3. **Deletion on one side, edit on the other → tombstone wins.** Client sends a tombstone row (same `syncIdentifier`, `deletedAt` set, `syncVersion` bumped). Server soft-deletes; on the next pull the edit-side reverts to "deleted" state. Deliberate choice — accidentally undoing a deletion is worse than accidentally losing an edit, given the kind of data HealthLog tracks.

4. **Server-derived surfaces (Health Score, Insights, Coach replies) → server wins always.** Client never computes them, never merges them. On reconnect the client invalidates its local snapshot and re-fetches. This is the MDR boundary, preserved by construction.

5. **Settings + preferences → server wins always when paired; client wins when standalone.** A user who pairs inherits the server's preferences (locale, timezone, CoachPrefs, notification channels). On unpair, the local preference snapshot is preserved.

6. **HealthKit-imported rows → unchanged: per-row dedup via `externalId` (= HK sample UUID).** Already in place via the existing batch ingest contract and the v1.4.25 W8c `deviceType` column.

### 4.4 What we explicitly do NOT do

- **No three-way merge with operational transform / CRDTs.** Data shape is too coarse (one value, one note, one timestamp) to justify the complexity. Apple's own HKQuantitySample sync rejects this in favour of identifier + version; we follow.
- **No client-side conflict-prompt UI.** Health data with a manual-resolve dialog every reconnect would be unusable. Apple Health does not show one; AutoSleep does not show one.
- **No "merge by averaging" for numeric values.** A weight of 82.0 kg and 82.4 kg do not average to 82.2 kg — they are two different facts and the latest fact wins.
- **No optimistic-on-server retries that contradict the client.** If the server holds an edit at `syncVersion = 3` and the client sends `syncVersion = 2`, the server returns the row at `syncVersion = 3` in the response and the client adopts it.

## 5. Feature parity matrix

Server feature inventory taken from `06-ios-responsibilities.md`, `07-server-responsibilities.md`, the v1.4.26 changelog, and the live `Screens/` directory in the iOS repo. Counterpart status as of the iOS v0.3.0 snapshot.

| Server feature | iOS counterpart | Standalone behaviour | Gap |
|---|---|---|---|
| Dashboard hero greeting + Daily Briefing | DailyBriefingHero (server-fed) | Greeting yes; briefing placeholder | Briefing is server-derived |
| Health Score tile (4-pillar ring) | HealthScoreStore + Detail Sheet | Placeholder | Server-derived |
| Trend strip (weight, BP, pulse, glucose, BMI) | ChartsStore + ChartDetailStore | Full functionality from SwiftData | None |
| Personal Records | Server-resident; iOS deep-links to PR detail | Disabled | Native PR detection out of scope |
| GLP-1 therapy card | Not yet on iOS | Placeholder; arrives in iOS v0.4 | Native counterpart pending |
| Coach screen (`/coach`) | Not yet on iOS (deferred in v0.3 backlog) | Placeholder | Native Coach is a v0.4 surface |
| Insights screen | InsightsScreen (server-fed) | Placeholder | Server-derived |
| Doctor Report PDF | DoctorReportScreen (server-rendered) | Hidden CTA | Server-only per ADR-002 |
| HealthKit ingest pipeline | HealthKitService → MeasurementBatchUploader → POST batch (paired) | Lands in SwiftData directly | None |
| Withings sync | Server-only | Hidden CTA | Server-only |
| Telegram notifications | Server-only | Disabled | Server-only |
| APNs push delivery | NotificationsStore + DeviceID flow | Disabled (no APNs token to register) | Standalone unsubscribes |
| Audit log | AuditLogScreen | Local-only ring buffer | Local events only |
| Export (CSV / JSON) | ExportScreen (server-rendered) | Local CSV from SwiftData | New local-export path needed |
| Account deletion | DeleteAccountScreen (server cascade) | Hidden (no account) | None |
| Passkey login + biometric unlock | PasskeyService + BiometricGate | Biometric only; passkey hidden | None |
| Multi-device sync via the server | Outbox + batch | Disabled — single-device | Acceptable trade-off; pairing restores it |

**Bottom line.** About 70 % of the iOS surface area works fully in standalone mode (entry, charts, HealthKit, local export, biometric). The 30 % requiring the server (Health Score, Briefing, Insights, Coach, PDF, multi-device) gates cleanly behind a placeholder card with a "Pair with HealthLog server" CTA.

## 6. Server-side preparations

### 6.1 v1.4.27 (this release)

**None.** The iOS-side inversion ships purely on the iOS client. The existing batch + idempotency + composite-unique-index infrastructure (W16b) is enough to support standalone-then-paired flows.

### 6.2 v1.4.28 (next release)

| Capability | Status | Action in v1.4.28 |
|---|---|---|
| `syncVersion Int @default(1)` column on Measurement | Not present | Additive Prisma column; server compares on upsert; client always sends |
| `deletedAt DateTime?` soft-delete column | Not present (hard delete today) | Additive Prisma column + `(user_id, deletedAt)` index; tombstone propagation |
| `GET /api/sync/state` | Not present | Read-only endpoint returning last-seen `syncIdentifier` + max `syncVersion` per metric type |
| ETag / `If-Modified-Since` on read endpoints | Not present | Battery + bandwidth optimisation on reconnect |

All four are additive, no breaking changes. The iOS client falls back gracefully when the server side has not yet shipped them — `syncVersion` is optional in the wire format; missing `deletedAt` means soft-delete is not propagated and a hard delete on one device disappears on the other (acceptable until the column lands).

### 6.3 Deferred indefinitely

- **HealthKit write-back** — Pattern B architecture; v1.6 at earliest.
- **Local PR detection in standalone** — MDR boundary holds.
- **Local Coach in standalone** — Coach calls a server-side LLM provider; no offline equivalent that respects the safety contract.
- **Conflict-resolution UI** — see § 4.4.

## 7. Cross-references

- `00-philosophy.md` § Rule 9 — why a server exists at all
- `06-ios-responsibilities.md` § Domain 1 — HealthKit ingest contract (reused verbatim)
- `06-ios-responsibilities.md` § Domain 4 — offline cache + sync queue (the foundation this proposal inverts)
- `07-server-responsibilities.md` — twenty-two server-resident domains, every one of which becomes a "needs pairing" placeholder in standalone mode
- `08-locked-contracts.md` — batch ingest contract reused for the first-pair backfill
- `13-state-management.md` § iOS analogues — TanStack Query keys mapping to SwiftData read paths
- ADR-005 (`SwiftData fuer Caches + Outbox`) — the foundation this proposal builds on
- ADR-011, ADR-012 (Outbox persistence + file protection) — preserved verbatim
- WWDC20 session 10184 — Apple's `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion` contract that this proposal mirrors at the HealthLog row level

## 8. Sequencing recommendation for the iOS implementer

1. **Add the SyncMode enum** to `UserDefaults`; default `.paired` for existing installs, `.standalone` for fresh installs.
2. **Add SwiftData properties** `syncIdentifier: UUID` (existing `externalId` rename), `syncVersion: Int = 1`, `deletedAt: Date?` to every persisted row type.
3. **Gate every network repository call** on `SyncMode == .paired`.
4. **Build the Settings → Account → Server pairing surface** with the toggle, the pair sheet, and the unpair confirmation.
5. **Wire the cloud-derived placeholders** — every Daily Briefing / Health Score / Insights / Coach surface checks `SyncMode` first and renders a "Pair with HealthLog server" CTA when standalone.
6. **Build the first-pair backfill** — enumerate SwiftData rows, batch into ≤500-row chunks, POST via existing `/api/measurements/batch` etc.
7. **Wait for v1.4.28** before adding the `syncVersion` field to wire payloads (the server will not consume it earlier). Until then, send the field if you want, but the server ignores it.

The order above keeps the iOS client deployable at every step — standalone mode lands first as a complete feature, pairing lands second as an opt-in, the conflict-resolution fields land third once the server is ready.
