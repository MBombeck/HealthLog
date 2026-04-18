# User-Configurable Health Thresholds — Design Spec

**Datum:** 2026-04-18
**Status:** Draft
**Scope:** Per-user override layer for the metric target ranges currently rendered on `/targets` and used across analytics.

## 1. Problem

HealthLog computes target ranges from established medical guidelines:

- Weight from BMI 18.5–24.9 (WHO) via `getWeightRange` / `buildWeightBandsFromHeight`
- BP targets age-personalized per ESC/ESH 2018 (`bp-targets.ts`, `getBpTargetsByAge`)
- Pulse from CDC/NCHS percentiles or AHA fallback (`pulse-targets.ts`)
- Body fat from ACE thresholds (`classifyBodyFat`)
- Sleep duration from AASM/SRS (`getSleepDurationRange`)
- Steps from WHO (`getStepsRange`)

These are sane defaults, but real patients receive **doctor-recommended individual targets**. A diabetic with autonomic neuropathy may have a BP target of 110/65–135/80; a marathoner may have a personal "green" pulse band of 38–55 that the AHA bands flag as bradycardia; a recovering anorexia patient may have a clinically supervised weight floor above the BMI-18.5 line. Today the UI exposes computed ranges with **no override mechanism**, and analytics, alerts, and the doctor-report PDF all silently use the guideline values.

## 2. Why (User Intent)

- Users may have doctor-recommended personalized targets that differ from the default ESC/ESH / WHO / AHA guidelines.
- Current UI shows computed defaults with no override mechanism.
- User wants a dedicated settings page where thresholds can be overridden per metric, with the default still visible for comparison and one-click reset.

## 3. Requirements

1. **Per-metric override** for the full set: `WEIGHT` (min/max), `BLOOD_PRESSURE_SYS` (low/high), `BLOOD_PRESSURE_DIA` (low/high), `PULSE` (min/max), `BODY_FAT` (min/max), `SLEEP_DURATION` (min/max in hours), `ACTIVITY_STEPS` (min/max). Reserve slots for `BLOOD_GLUCOSE_FASTING` and `BLOOD_GLUCOSE_POSTPRANDIAL` even though they are not yet measured — the schema should not need a migration when the metric ships.
2. **Optional yellow zone**: each metric may carry a separate `warnMin/warnMax` (orange band) in addition to `min/max` (green band). Falls back to the default's orange computation (currently `±30%` span via `buildTrafficRange`) if absent.
3. **Comparable to default**: every UI surface that renders a range must be able to show "Default: X / Your override: Y" — the API therefore returns `defaults`, `overrides`, and `effective` together.
4. **Reset to default per metric** — single-click, no confirm needed unless overrides existed (see §11).
5. **Source-of-truth precedence**: `effective = override ?? default(profile)`. Default still recomputes when profile (height, age, gender) changes, so users who never override see no change in behavior.
6. **Server-side validation** — overrides must satisfy `min < max`, sit within hard sanity bounds, and pass plausibility checks (out-of-normal-range warns, see §11).
7. **All consumers must use one helper** — no analytics module should call the raw default-computer directly anymore (see §6).
8. **Audit trail** for every change (medical data, see §8).

## 4. Data Model

### Decision: JSON column on `User`, not a new table

Two options were considered:

**Option A — `UserThreshold` table** (one row per user/metric):
- Pro: query-friendly, easy partial indexes, future reporting per metric.
- Con: 9+ rows per user for a feature that is read together every page load; joins on every targets fetch; migration friction when adding metrics.

**Option B — JSON column on `User`** (`thresholdsJson Json?`):
- Pro: read-with-user is one row, atomic write, schema-less for new metrics, mirrors Prisma 7 / Postgres `jsonb` strengths, validated by Zod at the application layer.
- Con: cannot index individual thresholds in the DB (acceptable — there is no use case for "find all users whose pulse cap > 110").

**Choose Option B.** A `UserSetting` model does not currently exist, so we add the column directly to `User`:

```
// prisma/schema.prisma — additive
model User {
  ...
  thresholdsJson Json? @map("thresholds_json")
}
```

### JSON shape (TypeScript, source of truth in `src/lib/validations/thresholds.ts`)

```ts
type ThresholdOverride = {
  min?: number;
  max?: number;
  warnMin?: number;   // optional yellow zone lower bound
  warnMax?: number;   // optional yellow zone upper bound
  updatedAt: string;  // ISO-8601, set server-side on every PUT
};

type ThresholdsJson = {
  WEIGHT?: ThresholdOverride;
  BLOOD_PRESSURE_SYS?: ThresholdOverride;
  BLOOD_PRESSURE_DIA?: ThresholdOverride;
  PULSE?: ThresholdOverride;
  BODY_FAT?: ThresholdOverride;
  SLEEP_DURATION?: ThresholdOverride;
  ACTIVITY_STEPS?: ThresholdOverride;
  BLOOD_GLUCOSE_FASTING?: ThresholdOverride;     // reserved
  BLOOD_GLUCOSE_POSTPRANDIAL?: ThresholdOverride; // reserved
};
```

An override is "active" when `min` and `max` are both numbers; partial-only objects are rejected by Zod. Absence of a key === use default.

## 5. API

### `GET /api/user/thresholds`

Response (envelope `{ data, error, meta }`):
```
data: {
  defaults:  { WEIGHT: { min, max, warnMin, warnMax, source }, ... },
  overrides: { PULSE:  { min, max, warnMin?, warnMax?, updatedAt }, ... },
  effective: { WEIGHT: { min, max, warnMin, warnMax, isOverride: false }, ... },
  profile:   { heightCm, age, gender }
}
```
`defaults` is always populated (even for metrics the user has not measured, so the UI can render an empty slot with the default visible). `overrides` only contains keys the user has actually customized. `effective` is the merged result every analytics consumer should think in.

### `PUT /api/user/thresholds`

Body: partial map of metric → override (Zod-validated). Replaces only the listed metrics; unspecified keys are untouched.
```
{ "PULSE": { "min": 50, "max": 95 },
  "BLOOD_PRESSURE_SYS": { "min": 110, "max": 130, "warnMin": 105, "warnMax": 140 } }
```
Per-metric Zod rules (`src/lib/validations/thresholds.ts`):
- `min < max`
- if `warnMin` set: `warnMin <= min`; if `warnMax` set: `warnMax >= max`
- hard sanity bounds (reject obviously broken input):
  - `WEIGHT`: 30–300 kg
  - `BLOOD_PRESSURE_SYS`: 70–220 mmHg
  - `BLOOD_PRESSURE_DIA`: 40–140 mmHg
  - `PULSE`: 30–220 bpm
  - `BODY_FAT`: 3–60 %
  - `SLEEP_DURATION`: 3–14 h
  - `ACTIVITY_STEPS`: 0–50000
  - `BLOOD_GLUCOSE_FASTING`: 50–250 mg/dL
  - `BLOOD_GLUCOSE_POSTPRANDIAL`: 70–350 mg/dL
- soft "out-of-normal-range" check returns a Zod warning (not error) — surfaced to the UI to trigger the confirm dialog (see §11).

### `DELETE /api/user/thresholds/:metric`

Removes one key from `thresholdsJson`. Returns the new `effective` block so the client can refresh without a second roundtrip.

All three routes are wrapped by `apiHandler` and `requireAuth()`, log Wide Events, and emit AuditLog entries (§8).

## 6. Integration Points

A single helper becomes the only public entry for "what is the target range":

```
src/lib/analytics/effective-range.ts
  getEffectiveRange(metric, user, overrides?) → { min, max, warnMin, warnMax, source, isOverride }
```

It internally calls the existing default computers (`getWeightRange`, `getBpTargets`, `getPersonalizedPulseTarget`, `classifyBodyFat`'s table, `getSleepDurationRange`, `getStepsRange`) and applies any matching override. `source` becomes `"User override"` when `isOverride === true`, otherwise the existing guideline string.

Refactor in scope:
- `src/lib/analytics/classifications.ts` — `classifyBP`, `classifyPulse`, `classifyBodyFat`, `classifySleepDuration`, `classifySteps`, `getWeightRange`, `getPulseRange`, `getSleepDurationRange`, `getBpTargetsByAge`: keep as pure default computers, but stop being called from feature code. Add thin `classifyXWithRange(value, range)` variants that take the resolved range.
- `src/lib/analytics/value-bands.ts` — `buildTrafficRange` and `buildWeightBandsFromHeight` accept an optional `override` argument and prefer it over the BMI-derived band.
- `src/lib/analytics/pulse-targets.ts` — `getPersonalizedPulseTarget` stays as the default; new `resolvePulseTarget(user, overrides)` lives in `effective-range.ts`.
- `src/lib/analytics/bp-targets.ts` — `getBpTargets` likewise stays; `effective-range.ts` wraps it.
- `src/app/api/insights/targets/route.ts` (the API behind `/targets`) reads `thresholdsJson` once and passes it to `getEffectiveRange` per metric, then returns the `effective` block to the client. The `source` field already shown on `TargetCard` flips to "User override" automatically.
- Doctor-report PDF (`src/lib/doctor-report-pdf.ts`) and Wide-Event annotations include `isOverride` so reports clearly mark customized targets.

## 7. Migration

Additive only — single Prisma migration adds `users.thresholds_json jsonb`. Existing users get `NULL`, which `getEffectiveRange` treats as "no overrides → behave exactly as before". No data backfill, no flag rollout.

## 8. Auditing

Every `PUT` and `DELETE` writes one `AuditLog` row (model already exists at `prisma/schema.prisma:391`):

- `action`: `"thresholds.update"` or `"thresholds.reset"`
- `details` (JSON string): `{ metric, before: {min,max,warnMin,warnMax} | null, after: {...} | null, reason?: "user" | "out_of_range_confirmed" }`
- `userId`, `ipAddress`, `location` from session context (already populated by `apiHandler`).

The `before` value is read from the current `thresholdsJson` *or* the computed default (so the audit trail captures the implicit baseline a user customized away from). Reset writes `after: null`.

## 9. i18n Keys

New section under `messages/en.json` and `messages/de.json`:

| Key | EN | DE |
|---|---|---|
| `thresholds.title` | "Custom thresholds" | "Eigene Zielwerte" |
| `thresholds.intro` | "Override the medical default ranges with values your doctor recommended. Defaults stay visible for comparison and you can reset any metric to the guideline at any time." | "Ersetze die medizinischen Standardbereiche durch arztempfohlene Werte. Die Standardwerte bleiben sichtbar und du kannst jeden Wert jederzeit auf die Leitlinie zurücksetzen." |
| `thresholds.defaultLabel` | "Default" | "Standard" |
| `thresholds.overrideLabel` | "Your override" | "Eigener Wert" |
| `thresholds.enableToggle` | "Use custom value" | "Eigenen Wert verwenden" |
| `thresholds.warnZoneLabel` | "Yellow zone (optional)" | "Gelber Bereich (optional)" |
| `thresholds.minLabel` | "Min" | "Min" |
| `thresholds.maxLabel` | "Max" | "Max" |
| `thresholds.resetButton` | "Reset to default" | "Auf Standard zurücksetzen" |
| `thresholds.resetPrompt` | "Reset {metric} to the medical default?" | "{metric} auf den medizinischen Standardwert zurücksetzen?" |
| `thresholds.saved` | "Thresholds saved" | "Zielwerte gespeichert" |
| `thresholds.outOfRangeWarn` | "This value lies outside the typical medical range. Please confirm only if your doctor recommended it." | "Dieser Wert liegt außerhalb des üblichen medizinischen Bereichs. Bitte nur bestätigen, wenn dein Arzt das empfohlen hat." |
| `thresholds.notMedicalAdvice` | "HealthLog does not provide medical advice. Custom thresholds are stored as-is." | "HealthLog ersetzt keine ärztliche Beratung. Eigene Zielwerte werden unverändert gespeichert." |
| `thresholds.validation.minLessMax` | "Min must be less than max" | "Min muss kleiner als Max sein" |
| `thresholds.validation.warnEnvelope` | "Yellow zone must surround the green zone" | "Der gelbe Bereich muss den grünen Bereich umschließen" |
| `thresholds.validation.outOfBounds` | "Value outside allowed range ({min}–{max} {unit})" | "Wert außerhalb des erlaubten Bereichs ({min}–{max} {unit})" |

Existing `targets.*` keys stay; the targets page gains a small "Customize" link routing to `/settings#thresholds`.

## 10. UI

New section in the existing settings shell at `/settings#thresholds`:

- One card per metric. Header shows the metric label + icon (reuses `TYPE_ICONS` from `targets/page.tsx`).
- Body left: read-only "Default: 60 – 100 bpm" with the source citation (same external link logic as `getTargetSourceLink`).
- Body right: an "Use custom value" toggle. When on, two number inputs (min, max) plus an optional collapsible "Yellow zone" with `warnMin`/`warnMax`.
- Inline validation via React Hook Form + Zod (the same schema the server uses).
- Footer: "Reset to default" button (visible only when an override exists).
- Out-of-range soft warnings render as an inline orange callout with a "I confirm my doctor recommended this" checkbox required to enable Save.
- Persistent disclaimer banner at the top: `thresholds.notMedicalAdvice`.

## 11. Nyquist Validation (tests in `src/lib/analytics/__tests__/effective-range.test.ts` and route tests)

- `getEffectiveRange` returns the override when present and the default when absent (one test per metric).
- Boundary tests: `min === max` rejected; `warnMin === min` accepted; off-by-one above/below the hard sanity bounds rejected/accepted.
- Profile-change test: removing `heightCm` collapses the WEIGHT default to "no range", but a present override survives.
- API contract: `GET` returns `defaults`, `overrides`, `effective`, `profile`. `PUT` with partial body leaves untouched metrics intact. `DELETE :metric` removes only that key.
- AuditLog firing: spy that one row is written per `PUT`/`DELETE`, with correct `before`/`after`. Confirm `details` JSON parses.
- Out-of-range confirmation: PUT with a value flagged "out_of_normal_range" requires `?confirm=1` query param (or a body flag) — without it the route returns `400 confirmation_required`.
- i18n parity test: every new EN key has a DE counterpart (re-uses the existing parity test if present, else add).

## 12. Risks & Mitigations

- **Users set unhealthy targets.** Hard sanity bounds reject obvious nonsense; soft "out-of-normal-range" warns and demands explicit confirmation. Persistent banner ("not medical advice"). Audit trail enables forensic review.
- **Insights/AI prompts may quote a user-customized range as if it were the medical guideline.** The provider prompts must receive the `source` field and explicitly distinguish "User override" from a guideline citation. Update `src/lib/ai/prompts/*` accordingly.
- **Doctor-report PDF.** Mark each customized range with a small "(custom)" tag so a treating physician sees that the report's coloring reflects the patient's own targets, not the guideline.
- **Default drift over time.** If we update guidelines (e.g. ESC/ESH 2024), users with overrides are unaffected — but users without overrides will see their colored bands shift. Document in the changelog.

## 13. Out of Scope

- Sharing thresholds between users / household.
- Doctor export of overrides (a treating physician downloading the override JSON to reuse) — could come later as part of the doctor report.
- Time-bounded thresholds ("until 2026-12-31"), seasonal thresholds, schedule-based thresholds.
- Per-medication or per-condition threshold packs.
- Threshold suggestions from AI insights.

## 14. Effort

**M (medium).** One Prisma migration, one new helper module, three new API routes, refactoring of ~5 analytics consumers to go through `getEffectiveRange`, one new settings card, ~14 i18n keys per locale, and one new test file. No external integrations, no UI primitive work (existing shadcn `Card`/`Input`/`Switch`/`Button` cover everything). Estimated 1.5–2 focused days for a senior dev including tests and audit-log wiring.
