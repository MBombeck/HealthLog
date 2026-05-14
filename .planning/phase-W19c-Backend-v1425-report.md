# Phase W19c-Backend — v1.4.25 — Research-mode + GLP-1 PK helpers

Status: complete. Three atomic commits on `develop`, all gates clean.

## Commits

| # | SHA | Title |
|---|-----|-------|
| 1 | `5eeedd7` | feat(db): add user.researchMode acknowledgment fields for GLP-1 PK chart |
| 2 | `36d147e` | feat(medications): one-compartment GLP-1 PK helpers (qualitative use) |
| 3 | `cf27df4` | feat(api): research-mode acknowledgment endpoint (GET/POST/DELETE) |

## Scope delivered

### Commit 1 — Migration 0058 + schema

Added three columns to `users`:

- `research_mode_enabled` `BOOLEAN NOT NULL DEFAULT false`
- `research_mode_acknowledged_at` `TIMESTAMP(3)` nullable
- `research_mode_acknowledged_version` `TEXT` nullable

Prisma fields on the `User` model:

- `researchModeEnabled` (Boolean, default false)
- `researchModeAcknowledgedAt` (DateTime, optional)
- `researchModeAcknowledgedVersion` (String, optional)

Migration uses `ADD COLUMN IF NOT EXISTS` (mirrors 0057). Applied to the dev DB
and `_prisma_migrations` was updated to record the migration so future
`prisma migrate` runs do not re-apply.

### Commit 2 — `src/lib/medications/glp1-pk.ts` (pure)

Public exports:

- `RESEARCH_MODE_DISCLAIMER_VERSION` — `"2026-05-14.1"`. Bump on copy
  change / new drug / new EMA EPAR version.
- `type DoseEvent = { takenAt: Date; doseMg: number }`
- `type PkSample = { tHours: number; concentration: number }`
- `type OneCompartmentOptions = { windowHoursBefore?: number;
  windowHoursAfter?: number; stepHours?: number }`
- `type ShotPhase = "rising" | "peak" | "fading" | "none"`
- `function computeOneCompartment(drug: Glp1DrugId,
  doses: readonly DoseEvent[], asOf: Date, opts?: OneCompartmentOptions):
  PkSample[]`
- `function shotPhaseAt(drug: Glp1DrugId,
  doses: readonly DoseEvent[], asOf: Date): ShotPhase`

Defaults: 14 d look-back, 7 d projection, 6 h sample step (≈ 85 samples per
chart). All math is one-compartment Bateman per research §2.2. Two-compartment
is **explicitly out of scope**; the file header carries the regulatory
rationale (research §2.6 + §11 + §12.4) so any future maintainer reads the
boundary before extending the file.

Reads only `glp1-knowledge.ts` for per-drug constants; no Prisma, no
`fetch`, no `Date.now()`. Where EMA does not publish a pop-PK Ka
(every drug except tirzepatide), the helper falls back to the
textbook `Ka ≈ 3 ln 2 / Tmax` approximation — coarse but adequate for
a unit-less qualitative chart.

15 unit tests:

- 5 per-drug smoke tests (catalog-driven; new drugs will fail until
  the typical-dose helper is updated).
- Zero before the first dose; empty-input zero.
- Linear superposition (two doses sum identically to the
  single-dose contributions).
- Custom window + step honoured.
- Sawtooth shape over weekly cadence (local max + local min both
  required to exist strictly inside the series).
- `shotPhaseAt` returns `none` / `rising` / `fading` at the
  appropriate timepoints. (Peak classification is exercised
  indirectly through the sawtooth test.)
- `RESEARCH_MODE_DISCLAIMER_VERSION` exported, non-empty, matches
  the `YYYY-MM-DD.N` shape.

### Commit 3 — `/api/auth/me/research-mode`

`GET` returns:

```ts
{
  enabled: boolean;
  acknowledgedAt: string | null;    // ISO 8601
  acknowledgedVersion: string | null;
  currentDisclaimerVersion: string;  // === RESEARCH_MODE_DISCLAIMER_VERSION
}
```

The Settings UI compares `acknowledgedVersion` to
`currentDisclaimerVersion`; when they differ, the dialog re-prompts
even if `enabled === true`.

`POST` body shape (strict):

```ts
{ acknowledged: true, version: string }
```

- 401 unauth.
- 422 on malformed JSON or wrong shape.
- 400 (`research-mode.version.stale`) if `version !==
  RESEARCH_MODE_DISCLAIMER_VERSION` — defends against a stale
  client tab acknowledging old wording.
- 429 on per-user rate-limit overflow (5/min via
  `checkRateLimit("research-mode:post:{userId}", 5, 60_000)`).
- Audit log: `user.research-mode.enable` with `{ previous, next }`.

`DELETE`:

- 401 unauth.
- Otherwise idempotent: writes the canonical `{enabled:false,
  ackAt:null, ackVersion:null}` shape and emits a
  `user.research-mode.disable` audit row even when the flag is
  already off.

11 route tests cover every branch.

### Prompt-injection posture

The `POST` body carries only the version string. The route compares
it byte-for-byte to the server-side constant before any DB write
and never forwards it to any LLM surface. There is no free-text
field.

## Quality gates

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- Touched-surface tests — clean (15 PK + 11 route = 26 new tests; all green).

## For W19c-Frontend

Import paths and contracts the next agent will need:

```ts
// Disclaimer version constant — display in the dialog footer and
// post back with the acknowledgment.
import { RESEARCH_MODE_DISCLAIMER_VERSION } from "@/lib/medications/glp1-pk";

// PK helpers for the AreaChart and the dashboard chip.
import {
  computeOneCompartment,
  shotPhaseAt,
  type DoseEvent,
  type PkSample,
  type ShotPhase,
} from "@/lib/medications/glp1-pk";

// Drug id enum — matches the catalog.
import {
  GLP1_DRUG_IDS,
  type Glp1DrugId,
} from "@/lib/medications/glp1-knowledge";
```

### API contract for the Settings toggle

```
GET    /api/auth/me/research-mode
       → 200  { data: { enabled, acknowledgedAt, acknowledgedVersion,
                        currentDisclaimerVersion } }

POST   /api/auth/me/research-mode
       body: { acknowledged: true,
               version: RESEARCH_MODE_DISCLAIMER_VERSION }
       → 200  { data: { enabled: true, ... } }
       → 400  { error: "research-mode.version.stale" }
       → 422  { error: "research-mode.body.invalid_shape" |
                       "research-mode.body.invalid_json" }
       → 429  on rate-limit

DELETE /api/auth/me/research-mode
       → 200  { data: { enabled: false, ack*: null, ... } }
```

### Chart wiring sketch

The W19c-Frontend dialog should:

1. On open, `GET` to read the current state.
2. Compare `acknowledgedVersion === currentDisclaimerVersion` — if
   they differ (or `enabled === false`), show the disclaimer.
3. The acknowledgment button posts `{ acknowledged: true,
   version: currentDisclaimerVersion }`. Use the version returned by
   `GET`, not the constant from `glp1-pk.ts` — that way a server
   redeploy that bumps the version is reflected without a client
   reload.
4. Once `enabled === true`, render the Recharts AreaChart over
   `computeOneCompartment(drugId, doses, new Date())`. Hide the
   y-axis tick labels. Label the axis "Estimated level
   (relative)" — never include a unit (research §2.3).
5. The dashboard tile chip reads `shotPhaseAt(drugId, doses, new
   Date())` and maps the four labels to the four chip variants.

### Drug-id enum

The frontend must pass exactly one of:

- `"tirzepatide"`
- `"semaglutide"`
- `"liraglutide"`
- `"dulaglutide"`
- `"exenatide"`

Use `GLP1_DRUG_IDS` to iterate or `findDrugByBrand` from
`glp1-knowledge.ts` to look up by user-entered brand name.

### Settings re-prompt rule

`acknowledgedVersion !== currentDisclaimerVersion` MUST hide the
chart and re-show the disclaimer, even when `enabled === true`. The
backend already rejects a `POST` carrying a stale version, so this
is a defence-in-depth UX rule for the client.

## Concerns / open items handed forward

- **No `dosesPerPen` integration**. The PK math accepts an
  arbitrary dose-mg series; integrating W19b's pen-inventory state
  into the chart's input is a W19c-Frontend / W19e concern, not
  Backend's. The frontend should source `DoseEvent[]` from
  `MedicationIntakeEvent` rows (already in the schema).
- **Two-compartment math deferred to v1.5**. The header comment in
  `glp1-pk.ts` carries the rationale. If a future agent ports the
  two-compartment closed form, it must ship alongside a renewed
  Coach refusal-layer audit and a Marc-direct decision on the
  unit-less y-axis.
- **Ka fallback rule** (`Ka ≈ 3 ln 2 / Tmax`) is a textbook
  approximation. For tirzepatide the catalog carries the
  psp4.13099 value verbatim, so the fallback never fires for that
  drug; for the others the EMA EPAR does not publish a pop-PK Ka
  and the textbook value is the best available. Documented in the
  module header.

## Touch-disjoint compliance

Files touched (all permitted by the dispatch spec):

- `prisma/schema.prisma` — User model only (added three fields
  in a `// v1.4.25 W19c — ...` block adjacent to W6c's block).
- `prisma/migrations/0058_user_research_mode/migration.sql`
- `src/lib/medications/glp1-pk.ts` (new)
- `src/lib/medications/__tests__/glp1-pk.test.ts` (new)
- `src/app/api/auth/me/research-mode/route.ts` (new)
- `src/app/api/auth/me/research-mode/__tests__/route.test.ts` (new)
- `.planning/phase-W19c-Backend-v1425-report.md` (this file)

Did not touch any W14b-Content surface (`messages/*.json`,
`src/app/onboarding/**`, `src/components/onboarding/**`), any
W19c-Frontend surface (`src/components/medications/**`, settings
page), or any W19c-Safety surface (`src/lib/coach/**`).
