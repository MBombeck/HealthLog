# W19b — GLP-1 Pen / vial inventory + 30-day in-use clock

Branch: develop. Atomic commits, professional Marc-Voice, no AI co-author trailers, no `--no-verify`.

## Commits (5)

| Commit | Subject |
|---|---|
| 570b14d | feat(schema): MedicationInventoryItem + 30-day in-use clock (Migration 0056) |
| 34ec6d3 | feat(medications): pen-inventory state-machine + 30-day clock helpers |
| d34c30e | feat(api): medication-inventory CRUD + intake-event hook for dose decrement |
| a0b9c11 | feat(medications): inventory card on medication detail page |
| 7f133a1 | feat(jobs): daily medication-inventory expire-stale queue (03:00 cron) |

## Scope delivered

- **Schema (Migration 0056).** `medication_inventory_items` table + `medication_inventory_state` enum (`ACTIVE` | `IN_USE` | `EXPIRED` | `USED_UP`). Indexes `(user_id, medication_id, state)` for the active-inventory read path and `(user_id, expires_at)` for the daily expire cron. Coexists with the existing `MedicationInventoryEvent` ledger — entity-level surface vs running-sum ledger.
- **State-machine helper.** `src/lib/medications/inventory/state-machine.ts` — pure `computeInventoryState`, `decrementDose`, `daysRemainingInUse`, `computeExpiresAt`. Configurable in-use window (defaults to 30 days; accepts 56 for Ozempic). 24 unit tests.
- **Service layer.** `service.ts` composes the Prisma I/O — `consumeOneDose` (intake-hook entry-point, FIFO selection: IN_USE before ACTIVE), `expireStaleInUseItems` (cron entry-point), `buildCreateInventoryInput`. 10 service tests.
- **API routes.** `GET/POST /api/medications/[id]/inventory` and `PATCH/DELETE /api/medications/[id]/inventory/[itemId]`. `requireAuth()`, Zod validation via new `createInventoryItemSchema` / `updateInventoryItemSchema`, `auditLog()` on every mutation, per-user POST rate-limit 30/min. Intake POST now calls `consumeOneDose` after creating the event; failures are swallowed and annotated so the intake never 500s on a flaky inventory hook. 11 route tests.
- **UI.** `InventorySection` component injected into the GLP-1 medication card as a collapsible disclosure (mirrors the existing dose-history `<details>`). Live pens (ACTIVE + IN_USE) with state badges + day countdown + mark-as-in-use / mark-as-used-up actions; collapsed history list for EXPIRED / USED_UP. Add-pen Dialog with `dosesTotal` / `printedExpiry` / `purchasedAt` / `notes`. i18n keys under `medications.inventory.*` across all 6 locales (EN/DE/FR/ES/IT/PL).
- **Cron.** `medication-inventory-expire` pg-boss queue at 03:30 Europe/Berlin (slotted inside the existing 02:xx–03:xx maintenance window). Notification surface deliberately silent — opt-in via Settings → Notifications is a future toggle. Module-shape test + the service test covers the sweep semantics.

## Quality gates

- `pnpm prisma generate` — clean.
- `pnpm test` — 24 (state-machine) + 10 (service) + 11 (routes) + 2 (cron module) = 47 new tests; existing 25 GLP-1 card + 8 intake tests still pass.
- `pnpm lint` — clean on all touched paths.
- `pnpm openapi:check` — in sync.
- `pnpm typecheck` — clean on my paths. Two pre-existing failures in the working tree are outside my scope: `src/lib/tz/resolver.ts` (unstaged Fix-G half-merge) and the parallel agent's untracked `src/components/insights/personal-record-badge.tsx` (missing `useRef` import).

## Touch-disjoint check + one flag

The parallel W16c agent shipped commits 4600c23, 7b7a896, 15a72bb on the same branch during my run. Two surfaces overlapped:

1. **`messages/*.json medications.inventory.*` namespace** — the W16c agent's commit 15a72bb landed the *exact* same `medications.inventory.*` i18n block I had drafted for all 6 locales (de, en, fr, es, it, pl). I restored the messages files from HEAD before committing 19b.4 so I did not re-write what was already there. Functionally identical, but it means W16c reached outside its declared scope. Worth flagging for the dispatcher.

2. **`src/lib/jobs/reminder-worker.ts`** — co-edited cleanly: W16c added `pr-detection` queue + handler + cron; I added `medication-inventory-expire` adjacent without conflict (different queue name, different handler, different cron line).

No collisions on `src/lib/personal-records/`, batch ingest routes, insights badge, or `messages.insights.personalRecord.*`.

## Phase report path

`/Users/marc/Projects/HealthLog/.planning/phase-W19b-v1425-pen-inventory-report.md`
