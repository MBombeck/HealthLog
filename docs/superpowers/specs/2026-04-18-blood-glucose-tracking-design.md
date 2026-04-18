# Blood Glucose Tracking — Design Spec

**Datum:** 2026-04-18
**Status:** Draft
**Scope:** Add `BLOOD_GLUCOSE` as a first-class measurement type with context-aware classification (fasting / postprandial / random / bedtime), user-selectable display unit (mg/dL ↔ mmol/L), reference ranges from ADA 2024 and DGIM 2023, and full integration across form, charts, targets, doctor PDF, and insights.

## 1. Problem Statement

Users repeatedly request blood-sugar logging — most recently in **GitHub issue #73, point 8**. Diabetics, pre-diabetics, and people on metabolic-impacting medication (steroids, atypical antipsychotics) need a single place to log glucose alongside weight, BP, and pulse so the doctor PDF reflects the complete metabolic picture. Today they fall back to spreadsheets or vendor-locked apps. Adding glucose to HealthLog closes the largest remaining gap in the "vital sign" set and unlocks correlation insights (e.g. weight ↔ fasting glucose, sleep ↔ glucose variability).

## 2. Scope

In v1 we ship:

- A new `BLOOD_GLUCOSE` measurement type stored canonically in **mg/dL**.
- A required **context tag** per reading: `FASTING`, `POSTPRANDIAL`, `RANDOM`, `BEDTIME`.
- A user preference `glucoseUnit` (`MG_DL` | `MMOL_L`, default `MG_DL` for `de` users, can flip in settings) — display only; storage is canonical.
- Context-aware classification (see §4) and a target card on `/targets` for fasting glucose; secondary line for postprandial when data exists.
- Health chart with diabetes/pre-diabetes band overlays.
- Doctor PDF row + classification line.
- Insights descriptor "glucose control" (fasting avg + variability).

**Stretch (v1.1, not in this spec):** HbA1c as a separate measurement type with its own classification (<5.7% / 5.7–6.4% / ≥6.5%, ADA 2024). Schema is forward-compatible (just add another enum value).

## 3. Data Model

```prisma
enum MeasurementType {
  WEIGHT
  BLOOD_PRESSURE_SYS
  BLOOD_PRESSURE_DIA
  PULSE
  BODY_FAT
  SLEEP_DURATION
  ACTIVITY_STEPS
  BLOOD_GLUCOSE          // NEW
}

enum GlucoseContext {     // NEW
  FASTING
  POSTPRANDIAL
  RANDOM
  BEDTIME

  @@map("glucose_context")
}

model Measurement {
  // ...existing fields
  glucoseContext GlucoseContext? @map("glucose_context")  // NEW, only set when type = BLOOD_GLUCOSE
}

model User {
  // ...existing fields
  glucoseUnit String @default("MG_DL") @map("glucose_unit")  // "MG_DL" | "MMOL_L"
}
```

Migration `20260418_add_blood_glucose`:
1. `ALTER TYPE measurement_type ADD VALUE 'BLOOD_GLUCOSE';`
2. `CREATE TYPE glucose_context AS ENUM (...);`
3. `ALTER TABLE measurements ADD COLUMN glucose_context glucose_context;`
4. `ALTER TABLE users ADD COLUMN glucose_unit text NOT NULL DEFAULT 'MG_DL';`
5. Add `CHECK ((type = 'BLOOD_GLUCOSE') = (glucose_context IS NOT NULL))` to enforce coupling.

The unique constraint `(userId, type, measuredAt, source)` already prevents duplicates; context is intentionally **not** part of the key — the same timestamp can't legally carry two contexts.

Storage unit is always **mg/dL** (`unit = "mg/dL"` in the row) so downstream analytics, exports, and Withings ingest don't need to branch.

## 4. Classifications (`src/lib/analytics/classifications.ts`)

New helpers, ranges from **ADA Standards of Care 2024** (Diabetes Care, Vol. 47, Suppl. 1) and **DGIM/DDG S3-Leitlinie 2023**:

```ts
export type GlucoseContext = "FASTING" | "POSTPRANDIAL" | "RANDOM" | "BEDTIME";

export interface GlucoseClassification {
  category: string;
  color: string;
  severity: "info" | "normal" | "warning" | "danger";
}

export function classifyGlucose(
  mgdl: number,
  context: GlucoseContext,
): GlucoseClassification;
```

Boundaries (mg/dL — mmol/L conversion shown for traceability):

| Context | Hypo (<70 / <3.9) | Normal | Pre-diabetes | Diabetes |
|---------|-------------------|--------|--------------|----------|
| FASTING | danger            | 70–99 (3.9–5.5) normal | 100–125 (5.6–6.9) warning | ≥126 (≥7.0) danger |
| POSTPRANDIAL (2h) | danger | <140 (<7.8) normal | 140–199 (7.8–11.0) warning | ≥200 (≥11.1) danger |
| RANDOM | danger | <140 normal | 140–199 warning | ≥200 danger |
| BEDTIME | danger | 90–150 normal (info if outside) | — | ≥250 danger |

Color tokens reuse the existing Dracula palette (`#50fa7b` normal, `#f1fa8c` info, `#ffb86c` / `#ff79c6` warning, `#ff5555` danger). Add `getGlucoseFastingRange()` returning `{ min: 70, max: 99 }` for the target card range bar, and `getGlucosePostprandialRange()` for the optional secondary bar.

## 5. UI

**Measurement form (`src/components/measurements/measurement-form.tsx`):**
- New entry in `MEASUREMENT_TYPES`: `{ value: "BLOOD_GLUCOSE", labelKey: "measurements.typeGlucose", unitKey: "measurements.unitGlucose", placeholder: "95" }`.
- When `type === "BLOOD_GLUCOSE"`, render an additional `<Select>` for context (4 options). Default = `FASTING` between 04:00–10:00 local time, else `RANDOM`.
- Unit suffix is resolved via `useGlucoseUnit()` hook reading `user.glucoseUnit`; the input value is converted to mg/dL before POST.
- Min 20, max 600 mg/dL (or equivalent mmol/L); inputs accept 1 decimal in mmol/L mode, integers in mg/dL mode.

**Targets page (`src/app/targets/page.tsx`):**
- New `TYPE_ICONS["BLOOD_GLUCOSE"]` = `Droplet` (Lucide), color token `text-dracula-yellow`.
- Card title "Fasting glucose" with `RangeBar` 70–99, orangeMin 100, orangeMax 125 (puts pre-diabetes in yellow zone, diabetes in red).
- If postprandial data exists in last 30 days, render a second labelled `RangeBar` below using `getGlucosePostprandialRange()`, mirroring the BP-diastolic pattern already in `TargetCard`.
- Source link → `https://diabetesjournals.org/care/issue/47/Supplement_1` (ADA 2024).

**Health chart (`src/components/charts/health-chart.tsx`):**
- New chart preset on `/charts` page: `types: ["BLOOD_GLUCOSE"]`, color `var(--dracula-yellow)`, `valueBands` for pre-diabetes (100–125) and diabetes (≥126) overlays, plus a `ReferenceLine` at 70 (hypo).
- Filter chips for context (All / Fasting / Postprandial / Random / Bedtime) — implemented as a client-side filter on the dataset, not a new API call.
- Y-axis unit follows user pref (mg/dL or mmol/L); points are converted on render.

**Insights:** Add `glucose-control.ts` insight returning `{ avgFasting, fastingInTargetPct, postprandialPeak, variability, classification }`. AI-friendly descriptor injected into the general-status prompt: `"glucose control: avg fasting {avg} mg/dL ({class}), {pct}% of fasting readings in target."`

**Doctor PDF (`src/lib/doctor-report-pdf.ts`):**
- `TYPE_LABEL_KEYS["BLOOD_GLUCOSE"] = "doctorReport.typeGlucose"`.
- `TYPE_UNIT_KEYS["BLOOD_GLUCOSE"]` resolves to user pref via a new `unitFor(type, ctx)` extension.
- Add `BLOOD_GLUCOSE` to `vitalTypes` array — table row appears automatically.
- New optional section "Glukose-Klassifikation" below the BP block: shows fasting average + classification key, plus postprandial average if `count > 0`, with i18n keys `doctorReport.glucoseClassificationTitle`, `doctorReport.glucoseFastingRow`, `doctorReport.glucosePostprandialRow`.
- Distribution table per context (n per FASTING/POSTPRANDIAL/RANDOM/BEDTIME) so the GP sees coverage.

## 6. API

No new endpoints. `POST /api/measurements` already accepts `type`, `value`, `measuredAt`, `notes` — extend the Zod schema in `src/lib/validations/measurement.ts` with optional `glucoseContext: z.enum([...])` and a refinement: `BLOOD_GLUCOSE` requires the context, other types reject it. The form sends mg/dL; conversion happens client-side.

`/api/analytics` and `/api/insights/targets` add `BLOOD_GLUCOSE` to their type whitelists and emit a `glucose` summary object with per-context aggregates when ≥1 reading exists.

`PATCH /api/auth/me` (already exists for profile updates) gains an optional `glucoseUnit` field.

## 7. Conversion Helpers

New module `src/lib/glucose.ts`:

```ts
export const GLUCOSE_FACTOR = 18.0182; // mg/dL per mmol/L (molar mass of glucose)

export function mgdlToMmol(mgdl: number): number {
  return Math.round((mgdl / GLUCOSE_FACTOR) * 10) / 10; // 1 decimal
}

export function mmolToMgdl(mmol: number): number {
  return Math.round(mmol * GLUCOSE_FACTOR); // integer
}

export function formatGlucose(mgdl: number, unit: GlucoseUnit, t: T): string;
```

Round-trip rule: `mmolToMgdl(mgdlToMmol(x))` must be within ±1 mg/dL of `x` for x ∈ [40, 400]. Tested in §9.

## 8. i18n Keys (`messages/de.json` + `messages/en.json`)

| Key | DE | EN |
|---|---|---|
| `measurements.typeGlucose` | Blutzucker | Blood glucose |
| `measurements.unitGlucose.mgdl` | mg/dL | mg/dL |
| `measurements.unitGlucose.mmol` | mmol/L | mmol/L |
| `measurements.glucoseContextLabel` | Kontext | Context |
| `measurements.glucoseContextFasting` | Nüchtern | Fasting |
| `measurements.glucoseContextPostprandial` | Nach dem Essen (2 h) | Post-meal (2h) |
| `measurements.glucoseContextRandom` | Zufällig | Random |
| `measurements.glucoseContextBedtime` | Vor dem Schlafen | Bedtime |
| `targets.glucoseFastingTitle` | Nüchtern-Blutzucker | Fasting glucose |
| `targets.glucosePostprandialTitle` | 2-h-Postprandial | 2h post-meal |
| `targets.glucoseSourceAda` | ADA 2024 / DGIM 2023 | ADA 2024 / DGIM 2023 |
| `classifications.glucoseHypo` | Hypoglykämie | Hypoglycemia |
| `classifications.glucoseNormal` | Normal | Normal |
| `classifications.glucosePrediabetes` | Prädiabetes | Pre-diabetes |
| `classifications.glucoseDiabetes` | Diabetes-Bereich | Diabetes range |
| `doctorReport.typeGlucose` | Blutzucker | Blood glucose |
| `doctorReport.glucoseClassificationTitle` | Glukose-Klassifikation | Glucose classification |
| `doctorReport.glucoseFastingRow` | Ø Nüchtern: {avg} {unit} — {class} | Avg fasting: {avg} {unit} — {class} |
| `doctorReport.glucosePostprandialRow` | Ø Postprandial: {avg} {unit} — {class} | Avg postprandial: {avg} {unit} — {class} |
| `settings.glucoseUnitLabel` | Blutzucker-Einheit | Blood glucose unit |
| `insights.glucoseControlTitle` | Glukose-Kontrolle | Glucose control |

## 9. Nyquist Validation

- **Unit conversion**: property test — for every integer mg/dL in [40, 400], `mmolToMgdl(mgdlToMmol(x))` differs from `x` by ≤1.
- **Classification boundaries**: assert `classifyGlucose(99, "FASTING").severity === "normal"`, `classifyGlucose(100, "FASTING").severity === "warning"`, `classifyGlucose(125, ...) === "warning"`, `classifyGlucose(126, ...) === "danger"`, `classifyGlucose(69, "FASTING").severity === "danger"` (hypo). Same for postprandial at 139/140/199/200.
- **Schema refinement**: `POST /api/measurements` with `BLOOD_GLUCOSE` and missing `glucoseContext` returns 400; with non-glucose type and a `glucoseContext` returns 400.
- **End-to-end smoke**: form submit → DB row → chart render → PDF generation; assert mg/dL stored regardless of UI unit, assert PDF row appears in `vitalRows`.
- **Doctor PDF snapshot test**: render with mixed contexts, assert classification line and per-context distribution rows.

## 10. Risks

- **Hypoglycemia notifications**: showing "severe low — seek help" on every reading <54 mg/dL could panic users with sensor noise or delayed entries. Notifications are **opt-in** via NotificationPreference (`MEASUREMENT_ANOMALY` event), default off, and the message text always ends with "HealthLog ist kein Medizinprodukt — bei akuten Symptomen 112 anrufen."
- **Unit confusion**: a user flipping the unit pref must not reinterpret historical mg/dL values as mmol/L. Migration sets a default; UI shows the unit suffix on every value.
- **Withings overlap**: Withings supports glucose via some BGM integrations. Document that Withings sync stays disabled for glucose in v1 (out of scope) to avoid double-entry races.
- **Context defaulting**: auto-selecting `FASTING` based on time of day is a heuristic; the user must always be able to override before save.

## 11. Out of Scope

- CGM (Dexcom / Libre) live integration.
- Ketone (β-hydroxybutyrate) tracking.
- Insulin dose log and bolus calculator.
- Carb counting / meal logging.
- HbA1c (deferred to v1.1, schema is ready).

## 12. Effort

**M (medium).** Roughly: schema + migration (S), classifications + conversion lib + tests (S), form/context selector + unit pref (M), targets card + chart preset (S), insight + PDF row + i18n (M), Nyquist tests (S). Estimate 1.5–2 dev-days end-to-end including review. No external dependencies, no new infra.
