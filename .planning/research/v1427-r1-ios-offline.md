---
file: .planning/research/v1427-r1-ios-offline.md
slot: R1.5
purpose: Research how comparable iOS health apps solve offline-first storage + optional cloud sync, and propose a target pattern for the HealthLog native client.
findings_covered: 24, 25, 26
created: 2026-05-15
status: research-only — no code or schema changes in this round
---

# v1.4.27 R1.5 — iOS offline-first + sync research

## Headline

Six comparable iOS health apps split into three clean buckets — system-bundled (Apple Health), cloud-mandatory (Withings, Bearable), and on-device-or-iCloud-only (Pillow, AutoSleep, Heartwatch). The HealthLog iOS client today sits closest to Withings — server-first with a typed Outbox queue, no local-only path. The offline-first directive (Finding 24) requires inverting that default: SwiftData becomes the canonical store, the HealthLog server becomes an optional sync mirror, and pairing is a user-driven setting rather than an onboarding precondition. Sync conflict resolution lands on per-row last-writer-wins keyed by an Apple-style `syncIdentifier + syncVersion` pair, with the server retaining authority only for derived data (Health Score, Insights, Coach) that the client never recomputes. No server-side migration is required for the v1.4.27 release — the iOS client owns the inversion, the server side only needs an additive read-state endpoint (deferrable to v1.4.28).

## Competitive landscape

| App | Cloud model | Account required | Conflict policy | UX consequence |
|---|---|---|---|---|
| **Apple Health** | On-device first; iCloud sync optional + opt-in (Settings → Health → "Sync this iPhone") | No account beyond Apple ID (which is device-level, not app-level) | `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion`; higher version overwrites lower; transaction-safe | User can use the entire Health app with iCloud sync off; turning sync on is a single toggle, no migration prompt, no data loss; data already on-device just starts replicating |
| **Withings Health Mate** | Cloud-mandatory; account required to pair a scale or watch; offline storage is a short-lived cache only | Yes | N/A — server is canonical; device measurements queue locally over Bluetooth and replay; no client-side conflict path | Devices "become useless" without account acceptance per Withings' own support thread; international data transfer is opaque to the user |
| **Pillow** | On-device-first; iCloud-encrypted backup is opt-in for cross-device | No account, no registration | iCloud handles versioning under the hood (CloudKit private-database semantics — last-writer-wins per record by `recordChangeTag`) | "Anonymous by default" — the app works fully offline, iCloud is positioned as a backup not a sync mode; the data is encrypted such that even Pillow cannot read it |
| **Bearable** | Cloud-by-default but app remains usable offline; data is client-side-encrypted before upload | Yes (email + password / Google / Apple / Facebook) — required for backup, optional for entering data | Server is canonical (Google Cloud EU); local cache is read-mostly; no documented multi-device merge — last successful upload wins | New users see a sign-up wall but past it the data layer is private end-to-end; CSV export is offered as an always-available escape hatch |
| **AutoSleep** | None — strictly on-device + HealthKit re-export | No account, no cloud, no analytics | N/A — single-device by definition; HealthKit handles its own re-import on a new device via Apple ID restore | App Store privacy label reads "Data Not Collected"; export is a paid manual flow, not a sync feature |
| **Heartwatch** | None — strictly on-device + HealthKit-read | No account, no cloud | N/A — HealthKit cross-device sync (Apple-managed) is the only path between iPhone and Apple Watch | Same vendor as AutoSleep, same privacy posture; cross-device continuity is delegated entirely to Apple's Health infrastructure |

**Architectural reading:** the three viable models are (a) **HealthKit as canonical store + no own cloud** (AutoSleep, Heartwatch), (b) **on-device-first + optional iCloud backup** (Pillow), and (c) **on-device-first + optional proprietary cloud sync** (Bearable, with a slightly heavier hand than HealthLog wants). Withings sits at the opposite end and is the model HealthLog's iOS client is closest to today — which is what Finding 24 wants to invert.

## HealthLog target architecture

Three viable patterns, ranked by user impact + implementation effort:

### Option A — On-device-first + optional HealthLog cloud sync (recommended)

SwiftData is the canonical store on the client. The HealthLog server is an optional mirror activated by a Settings toggle ("Pair with HealthLog server"). Cloud-derived surfaces (Health Score, Coach, Insights) gracefully degrade to a "needs server pairing" placeholder when sync is off, the rest of the app (measurement entry, charts, HealthKit import, medication intake, mood) works fully offline.

- **User impact:** matches the directive verbatim. Standalone-mode is the default, pairing is a deliberate later action, ground-rule "no cloud lock-in" is preserved.
- **Effort:** moderate-to-high. The iOS app already has SwiftData + Outbox; what's missing is the toggle, the gating of cloud-derived surfaces, and a "first-pair migration" flow that uploads the existing on-device history with a single idempotency-keyed batch.
- **Risk:** the gating UX is non-trivial — every cloud-derived card needs an offline placeholder that doesn't look like a bug.

### Option B — HealthKit as canonical store + HealthLog cloud as derived-data mirror

The iOS app writes user-entered values into HealthKit (`HKMetadataKeyExternalUUID` + `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion`) and reads everything from HealthKit. SwiftData is reduced to a thin cache. The HealthLog server still receives a batch upload, but only for surfaces HealthKit cannot host (mood entries, medication-intake logs, Coach context).

- **User impact:** maximum platform-fit; the user owns their data through Apple's own export tools.
- **Effort:** high. HealthKit-write is currently out of scope per `06-ios-responsibilities.md` ("iOS never writes back to HealthKit in v1.5 — read-only flow"). Inverting that is a v1.6-class change.
- **Risk:** the HealthLog domain has non-HealthKit-native metrics (mood, BD-target ranges, medication titration). Splitting storage across two on-device layers complicates conflict resolution for the mixed entries.

### Option C — Status quo + cosmetic offline banner

Keep the server-first model, add a "you are offline — last sync 14:22" banner, do nothing structural.

- **User impact:** ignores the directive. A user who never pairs would see an onboarding wall.
- **Effort:** trivial.
- **Risk:** retroactively impossible to roll back if the directive sticks; iOS v1.6 would have to redo the storage layer.

**Recommendation: Option A.** Matches the directive, preserves the v1.5 read-only HealthKit posture, leaves Option B available as a v1.6 follow-up if the value justifies the cost.

## Proposed HealthLog iOS pattern

### Canonical store

SwiftData is the source of truth for every user-entered row: Measurement, MoodEntry, MedicationIntake, plus the existing OutboxOperation table. Read paths render from SwiftData first, never from the server cache. The server's `MeasurementListWireResponse` is treated as a sync delta, not a primary read.

### Server is an optional mirror

A new `SyncMode` enum (`.standalone | .paired`) lives in `UserDefaults` and gates every network repository call. Standalone mode:

- All write paths skip the Outbox enqueue + API POST entirely; data persists to SwiftData and stops there.
- All read paths fetch from SwiftData only; the `AuthenticatedShell` hides the Settings → Account row that exposes pairing state.
- Cloud-derived surfaces (Daily Briefing hero, Health Score tile, Insights cards, Coach screen) render an explanatory placeholder ("Pair with the HealthLog server to enable Coach + Insights — your data stays on this device today") with a CTA into the pairing flow.

Paired mode is exactly the current behaviour: Outbox replay runs, server is canonical for derived surfaces, SwiftData is a write-through cache for user-entered rows.

### Pairing flow

1. User taps "Pair with HealthLog server" in Settings → Account.
2. Onboarding-style sheet: server URL (default `healthlog.bombeck.io`), email + password OR passkey, biometric consent.
3. On successful sign-in: app enumerates every SwiftData row created in standalone mode, packages them in ≤500-row idempotency-keyed batches, posts to `/api/measurements/batch` + `/api/mood-entries/bulk` + `/api/medications/intake/bulk`.
4. Per-row dedup is server-enforced via the existing `(user_id, type, source, external_id)` composite unique index — re-runs are safe; the server returns `status: duplicate` for any row that survived a prior partial upload.
5. After the initial backfill finishes, `SyncMode` flips to `.paired` and the normal Outbox + observer flow takes over.

### Conflict policy

Per-row last-writer-wins keyed by an Apple-style sync identifier + version:

- Every SwiftData row gets a stable `syncIdentifier` (UUID) at creation time. It is the same UUID the iOS client already sends as `externalId` in the batch contract.
- Every mutation increments a `syncVersion` integer on the row.
- The batch upload payload carries both `syncIdentifier` and `syncVersion`. The server's existing composite-unique index handles inserts as it does today; for an existing row, the server compares the inbound `syncVersion` and upserts iff the inbound number is strictly higher.
- Server-side derived data (Health Score, Insights, Coach replies) is server-canonical — the client never recomputes, never merges. On reconnect the client invalidates the local snapshot of these surfaces and re-fetches.
- For deletions: the iOS client sends a `tombstone` row (same `syncIdentifier`, `deletedAt` set, `syncVersion` bumped). Server soft-deletes; subsequent sync passes from other devices observe the tombstone.

This is the same pattern Apple uses for HKQuantitySample sync between iPhone and Apple Watch — proven to be transaction-safe under network partitions.

### Sync triggers

- **App foreground** in paired mode → run the Outbox replay once + fetch derived surfaces.
- **Reachability change** (offline → online) → same as foreground.
- **Background processing task** (`dev.healthlog.app.healthkit-sync`) — already in place; gain a paired-mode check.
- **Explicit pull-to-refresh** on any list view → fetch + invalidate.
- **First pairing** → one-shot backfill (see "Pairing flow" above).

### User-visible toggle in Settings

Settings → Account gains a new section "Server pairing":

- **Standalone** badge + "Pair with HealthLog server" CTA (when unpaired).
- **Paired** badge + connected email + "Unpair" CTA (when paired). Unpair triggers a confirmation sheet, then runs a one-shot upload of any unsynced rows (so the user does not lose data), wipes the bearer token from Keychain, flips `SyncMode` to `.standalone`. Server data remains on the server; the next pairing on the same account would re-download it.

### What does NOT change

- HealthKit read-only contract per `06-ios-responsibilities.md`. Standalone mode still imports HealthKit samples — they just land in SwiftData instead of being uploaded.
- The MDR boundary: derived surfaces (Coach, Insights, Health Score) remain server-only. Standalone-mode users see placeholders, not client-generated stand-ins.
- The Outbox + idempotency-key infrastructure. It is reused verbatim for the backfill batch upload.

## Server-side preparations (this release)

The server already has most of what the inversion needs. Concrete gaps and where they sit on the priority list:

| Capability | Status today | Need for v1.4.27 | Action this release |
|---|---|---|---|
| Idempotency keys on batch POST | Landed in W16b (`withIdempotency<[NextRequest]>` on `/api/measurements/batch` and `/api/measurements`) | Required and present | None |
| `(user_id, type, source, external_id)` composite unique index | Landed in W16b (Migration 0048) | Required and present | None |
| Per-row dedup status (`inserted | duplicate | skipped`) | Landed in W16b | Required and present | None |
| `syncVersion` column on Measurement | Not present | Required for last-writer-wins on edits | Additive Prisma column `syncVersion Int @default(1)`; server compares on upsert; client always sends; defer to v1.4.28 if the change does not fit the v1.4.27 schema window |
| `deletedAt` soft-delete column on Measurement | Not present today (hard delete via `/api/measurements/[id]` DELETE) | Required for tombstone propagation | Additive Prisma column `deletedAt DateTime?`; backfill `null`; index `(user_id, deletedAt)` — defer to v1.4.28 |
| `GET /api/sync/state` returning the server's last-seen `syncIdentifier` + max `syncVersion` per metric type | Not present | Useful for cheap delta queries on reconnect | New read-only endpoint, returns one row per `MeasurementType`; defer to v1.4.28 unless trivial to land |
| ETag / `If-Modified-Since` on read endpoints (Dashboard, Insights, Health Score) | Not present | Reduces battery + bandwidth on every reconnect | Defer to v1.4.28; not blocking |

**Net for v1.4.27:** the iOS-side inversion (SwiftData canonical, pairing toggle, standalone gating) can ship purely on the iOS client without any server change. The server prep above (`syncVersion`, `deletedAt`, `/api/sync/state`) lands in v1.4.28 as the iOS client adds the corresponding features. That keeps v1.4.27 a QoS-pass release per the maintainer directive.

## Feature parity matrix

Server feature inventory taken from `06-ios-responsibilities.md`, `07-server-responsibilities.md`, the v1.4.26 changelog, and the live `Screens/` directory in the iOS repo. Counterpart status as of the iOS v0.3.0 snapshot.

| Server feature | iOS native counterpart status | Standalone-mode behaviour | Gap |
|---|---|---|---|
| Dashboard hero greeting + Daily Briefing | DailyBriefingHero present (server-fed) | Greeting yes, briefing placeholder | Briefing is server-derived — placeholder only |
| Health Score tile (4-pillar ring) | HealthScoreStore + Detail-Sheet present | Placeholder | Server-derived — placeholder only |
| Trend strip (weight, BP, pulse, glucose, BMI) | ChartsStore + ChartDetailStore present | Full functionality from SwiftData | None |
| Personal Records | Server-resident; iOS deep-links into PR detail | Disabled (server-only) | Native PR detection out of scope; standalone shows no PR badges |
| GLP-1 therapy card | Not yet on iOS | Placeholder; will arrive in iOS v0.4 | Native counterpart pending |
| Coach screen (`/coach`) | Not yet on iOS (deferred in v0.3 backlog) | Placeholder | Native Coach is a v0.4 surface; even in paired mode it's deferred |
| Insights screen with severity-sorted cards | InsightsScreen present, server-fed | Placeholder | Server-derived — placeholder only |
| Doctor Report PDF | DoctorReportScreen present, server-rendered | Disabled (CTA hidden in standalone) | Server-only by ADR-002 |
| HealthKit ingest pipeline | HealthKitService → MeasurementBatchUploader → POST batch (paired); in standalone, lands in SwiftData directly | Full functionality, no upload | None |
| Withings sync | Server-only; iOS shows results in standard endpoints | Disabled (CTA hidden in standalone) | Server-only |
| Telegram notifications | Server-only | Disabled | Server-only |
| APNs push delivery | Iframed in NotificationsStore + DeviceID flow | Disabled in standalone (no APNs token to register) | Standalone mode unsubscribes |
| Audit log | AuditLogScreen present | Local-only audit ring buffer | Standalone mode shows local events only |
| Export (CSV / JSON) | ExportScreen present, server-rendered | Local CSV from SwiftData | New local-export path needed for standalone — small effort |
| Account deletion | DeleteAccountScreen present (server cascade) | Hidden in standalone (no account) | None |
| Passkey login + biometric unlock | PasskeyService + BiometricGate present | Biometric unlock only — passkey path hidden | None |
| Multi-device sync via the HealthLog server | Outbox + batch | Disabled — single-device | Acceptable trade-off in standalone; pairing restores it |

**Bottom line:** about 70 % of the iOS surface area works fully in standalone mode (entry, charts, HealthKit, local export, biometric). The 30 % that requires the server (Health Score, Briefing, Insights, Coach, PDF, multi-device) gates cleanly behind a placeholder card with a single "Pair with server" CTA.

## Sync conflict resolution policy

Concrete rules, ranked by frequency:

1. **New row on one side, absent on the other → last-writer-wins by `syncVersion`.** Default case for offline-then-online round trips. Server-side composite-unique index already enforces the dedup on `(user_id, type, source, external_id)`. With `syncVersion`, the server upserts only when the inbound version is strictly higher.

2. **Same row edited on both sides while offline → higher `syncVersion` wins, lower is dropped.** Identical to Apple HealthKit's `HKMetadataKeySyncVersion` semantics. The client increments `syncVersion` on every edit; whichever device sees the server first wins; the loser's edit is silently dropped on the next pull. No merge UI — the surface (a measurement value, a mood-entry note) is small enough that a "merge" prompt would be more confusing than the loss.

3. **Deletion on one side, edit on the other → tombstone wins.** A delete is a one-way fact. The client sends a tombstone row (same `syncIdentifier`, `deletedAt` set, `syncVersion` bumped). The server soft-deletes; on the next pull the edit-side reverts to "deleted" state. This is a deliberate choice — accidentally undoing a deletion is worse than accidentally losing an edit, given the kind of data HealthLog tracks.

4. **Server-derived surfaces (Health Score, Insights, Coach replies) → server wins always.** The client never computes them, never merges them. On reconnect the client invalidates its local snapshot and re-fetches. This is the MDR boundary — preserved by construction.

5. **Settings + preferences → server wins always when paired; client wins when standalone.** A user who pairs an account inherits the server's preferences (locale, timezone, CoachPrefs, notification channels). On unpair, the local preference snapshot is preserved. Re-pairing the same account replaces the local snapshot with the server's current state.

6. **HealthKit-imported rows → unchanged: per-row dedup via `externalId` (= HK sample UUID).** Already in place via the existing batch ingest contract and the v1.4.25 W8c `deviceType` column.

**What we explicitly do NOT do:**

- No three-way merge with operational-transform / CRDTs. The data shape is too coarse (one value, one note, one timestamp) to justify the complexity, and Apple's own HKQuantitySample sync — the most directly comparable system — also rejects this in favour of identifier + version.
- No client-side conflict-prompt UI. Health data with a manual-resolve dialog every reconnect would be unusable. Apple Health does not show one; AutoSleep does not show one; we should not invent one.
- No "merge by averaging" for numeric values. A weight of 82.0 kg and 82.4 kg do not average to 82.2 kg — they are two different facts and the latest fact wins.
- No optimistic-on-server retries that contradict the client. If the server holds an edit at `syncVersion = 3` and the client sends `syncVersion = 2`, the server returns the row at `syncVersion = 3` in the response and the client adopts it.

## Out-of-scope deferrals

Items that need more iOS-side work before they are useful at the server boundary, and therefore deferred past v1.4.27:

- **`syncVersion` column on `Measurement`** — additive Prisma migration, defer to v1.4.28 once the iOS client emits the field. No-op if the client does not yet send it (column has a default of 1).
- **`deletedAt` soft-delete column** — defer to v1.4.28. The current hard-delete contract is acceptable while standalone mode is the only path. Tombstone propagation requires the column.
- **`GET /api/sync/state`** — defer to v1.4.28. The client can recover full deltas via the existing `/api/measurements?limit=…` paging on the first pair; the explicit endpoint is a v1.4.28 efficiency improvement, not a correctness requirement.
- **ETag / `If-Modified-Since` on read endpoints** — defer to v1.4.28. Battery + bandwidth optimisation, not a blocker.
- **HealthKit write-back** — defer to iOS v1.6. Currently scoped out by ADR / `06-ios-responsibilities.md`. Required for the Option-B architecture if HealthLog ever wants HealthKit to be the canonical store.
- **Local PR detection in standalone** — defer indefinitely. The MDR boundary holds: PR detection lives server-side; standalone mode has no PR detection. Acceptable.
- **Local Coach in standalone** — never. Coach calls a server-side LLM provider, which has no offline equivalent that respects the MDR safety contract.
- **Conflict-resolution UI** — never. See "What we explicitly do NOT do" above.

## Cross-references

- `06-ios-responsibilities.md` — Domain 4 (offline cache + sync queue), Domain 1 (HealthKit ingest contract that this proposal reuses).
- `08-locked-contracts.md` — the batch ingest contract is the upload path the pairing flow reuses verbatim.
- `/Users/marc/Projects/healthlog-iOS/HealthLogIOS/docs/architecture.md` — current iOS data-strategy paragraph that this research recommends inverting.
- ADR-005 (`SwiftData fuer Caches + Outbox`) — the foundation the canonical-store proposal builds on. ADR-011 + ADR-012 (Outbox persistence + file protection) — preserved verbatim.
- WWDC20 session 10184 — Apple's `HKMetadataKeySyncIdentifier` + `HKMetadataKeySyncVersion` contract that this proposal mirrors at the HealthLog row level.
