# R-export — Health-record / doctor-handover export (v1.7.0 flagship)

Research + implementation-ready design. READ-ONLY pass over source; one deliverable.
Conventions consulted: `CLAUDE.md` (no-markdown-library rule, `safeFetch` egress, `apiHandler`
wrapper, Zod `safeParse` + `returnAllZodIssues`, OpenAPI-registry-is-source-of-truth,
audit-log + Postgres rate-limit, `annotate()` wide events, RSC-by-default, kebab-case files).

---

## 0. TL;DR recommendation

- **Structured interchange format: lead with HL7 FHIR R4, packaged as a single `Bundle`
  of `type: "document"` (a Composition "cover page" + Patient + Observations +
  MedicationStatement/MedicationRequest), emitted as one `.json` file.** It is the only
  format a German practice's PVS / the gematik ePA can actually ingest as structured data
  (ePA accepts FHIR Document Bundles + PDF/A — see §4). Ship a **flat JSON** schema as a
  secondary "developer / self-archive" format (we already have `full-backup`), and keep CSV
  per-domain (already shipped). **Do NOT build CDA/C-CDA** — XML-heavy, US-centric, far
  higher cost for zero German-practice upside.
- **PDF: enhance the existing jsPDF + jspdf-autotable generator** (`doctor-report-pdf-core.ts`)
  rather than swap libraries. Add a real cover page (full patient identity incl. the new
  full-name + insurer + insurance-number profile fields), a clinical summary block, optional
  embedded trend charts, and extend the selection schema beyond the current "big five".
- **The PDF should be PDF/A-flavoured enough to satisfy ePA** (embedded fonts, no external
  resources) — jsPDF embeds Helvetica by default and pulls no network resources, so we are
  close; full PDF/A-1b conformance is a stretch goal, not a blocker (§3.5).

---

## 1. What exists today (cite file:line)

HealthLog already ships a mature doctor-report PDF and a per-domain export surface. The v1.7.0
work is **consolidation + a structured FHIR layer on top of an existing aggregator**, not a
greenfield build.

### 1.1 PDF generator

- **Library:** `jspdf` `^4.2.1` + `jspdf-autotable` `^5.0.8` (`package.json`). `pdf-parse`
  `^2.4.5` is present too but only for Apple-Health import parsing, not report generation.
- **Renderer:** `src/lib/doctor-report-pdf-core.ts:144` `buildDoctorReportPdfDocument(data, {t, locale, now, userTz})`
  — isomorphic (runs in browser AND Node; `doc.output("arraybuffer")` at `:704`). i18n-driven:
  every label is a `t("doctorReport.*")` key, number/date formatting via `makeFormatters(locale, userTz)`
  (`:149`). Locale defaults to **German** server-side (`pdf/route.ts:170`) — correct for the
  clinical context.
- **Current sections** (all i18n, A4 portrait, 20 mm margin):
  - Title + subtitle + optional **practice name** cover line (`:170-198`).
  - Patient block: username, DOB, gender, height, reporting period, created-on (`:201-241`).
    **No full name, no insurer, no insurance number** — those profile fields do not exist yet (§2.3).
  - Vitals table (`DOCTOR_REPORT_VITAL_TYPES` at `:79`): WEIGHT, BP sys/dia, PULSE, BODY_FAT,
    TOTAL_BODY_WATER, BONE_MASS, OXYGEN_SATURATION — columns: parameter / current / avg / min / max / n.
  - Per-context glucose rows (FASTING/POSTPRANDIAL/RANDOM/BEDTIME) with effective ranges (`:266-282`).
  - BP classification (ESH grades, `getBpClassificationKey` `:128`), BMI classification
    (`getBmiClassificationKey` `:119`), glucose in/below/above-target lines.
  - Medication compliance table (taken/skipped/missed/total/rate, `:400-456`).
  - GLP-1 therapy block: dose-titration history, weight delta over window, side-effect counts,
    per-med compliance (`:463-603`).
  - Mood summary + distribution (privacy-gated; opt-in only, `:605-668`).
  - Footer disclaimer + source timestamp on every page (`:670-690`).
- **Data aggregator (single source of truth):** `src/lib/doctor-report-data.ts:255`
  `collectDoctorReportData(userId, range, { practiceName, sections })`. Excludes soft-deleted
  rows (`deletedAt: null`, `:279`). Range normalisation `normaliseDateRange` (`:198`) caps custom
  windows at **730 days**; `days` fallback caps at 365; default 90. Mood is **never queried** when
  the toggle is off (`:307`) — privacy-by-default, the audit log proves the read never happened.
- **No charts in the PDF today** — tables only. (Limit: a physician skimming trends has no curve.)

### 1.2 API surface (PDF)

- `POST /api/doctor-report` (`src/app/api/doctor-report/route.ts:34`) — returns the aggregated
  JSON, **client** renders the PDF via jsPDF in the browser.
- `POST /api/doctor-report/pdf` (`src/app/api/doctor-report/pdf/route.ts:33`) — **server**-renders
  the finished PDF bytes (used on iOS/Safari where client-side jsPDF download UX is unreliable).
- Both: `requireAuth()` (cookie OR Bearer), rate-limit `doctor-report:<userId>` **10/h**, audit
  `doctor-report.generate` / `doctor-report.pdf.generate` recording days/range/locale/sections.
  Body is Zod-tolerant: `doctorReportPrefsSchema.safeParse(...).success ? data : {}` (never 422s on drift).
- `GET /api/doctor-report/availability` exists (data-presence preflight for the dialog).
- Prefs persistence: `User.doctorReportPrefsJson` + `User.lastReportPracticeName`; validation in
  `src/lib/validations/doctor-report-prefs.ts` (`DEFAULT_DOCTOR_REPORT_PREFS` at `:60`, mood=false default).

### 1.3 Selection UI today

- `src/components/settings/export-section.tsx` — Settings → Export. Hero `<ArztberichtHeroCard>`
  (the flagship PDF flow) + 4 secondary cards: Measurements CSV, Medications CSV, Mood CSV, Full JSON backup.
- `src/components/doctor-report/doctor-report-dialog.tsx` + `doctor-report-section-toggles.tsx` —
  the section-toggle dialog (the existing "selectable data" surface).

### 1.4 Raw export surface (already shipped)

- `GET /api/export?format=csv|json&type=measurements|medications|intake|mood|all`
  (`src/app/api/export/route.ts`).
- Per-domain CSV: `GET /api/export/measurements`, `/medications`, `/mood` (`since`/`until` filters).
- `GET /api/export/full-backup` (`src/app/api/export/full-backup/route.ts`) — single-file JSON
  matching `backupPayloadSchema`, round-trippable via admin restore.
- Formatting helpers + RFC-4180 CSV escaping + per-user-tz ISO-with-offset timestamps:
  `src/lib/export.ts`. All export routes share the `export:<userId>` 10/h bucket + audit `user.export.*`.

**Current limits to fix in v1.7.0:**
1. No structured **interchange** format (FHIR) — only flat backup JSON + CSV.
2. PDF cover lacks full patient identity (full name / insurer / insurance number — see §2.3).
3. PDF selection is coarse (`bp/weight/pulse/bmi/mood/compliance/sleep`); the 40+ HealthKit metric
   types (HRV, RHR, VO2max, glucose contexts, body-composition family) have **no** per-section toggle
   (`MEASUREMENT_TYPE_SECTION` at `doctor-report-data.ts:591` only maps 5 types).
4. No charts in the PDF.
5. No single "build me the handover package" entry point that bundles PDF + FHIR together.

---

## 2. Data-domain inventory (Prisma models)

All user-scoped, all filterable by `[start,end]`, all soft-delete-aware where applicable.

| Domain | Prisma model | Notes / cite |
|---|---|---|
| Vitals + body comp + HealthKit metrics | `Measurement` (`schema.prisma:540`) | 40+ `MeasurementType` enum values (`:447-503`): WEIGHT, BLOOD_PRESSURE_SYS/DIA, PULSE, BODY_FAT, SLEEP_DURATION, ACTIVITY_STEPS, BLOOD_GLUCOSE (mg/dL + `GlucoseContext`), TOTAL_BODY_WATER, BONE_MASS, OXYGEN_SATURATION, HEART_RATE_VARIABILITY, RESTING_HEART_RATE, ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE, VO2_MAX, BODY_TEMPERATURE, FAT_FREE_MASS, FAT_MASS, MUSCLE_MASS, SKIN_TEMPERATURE, PULSE_WAVE_VELOCITY, VASCULAR_AGE, VISCERAL_FAT, AUDIO_EXPOSURE_*, TIME_IN_DAYLIGHT, WALKING_STEADINESS/ASYMMETRY/DOUBLE_SUPPORT/STEP_LENGTH/SPEED, RESPIRATORY_RATE, BODY_MASS_INDEX, LEAN_BODY_MASS, WALKING_HEART_RATE_AVERAGE. `source` ∈ {MANUAL, WITHINGS, IMPORT, APPLE_HEALTH}. `SleepStage` per-row for SLEEP_DURATION. |
| Workouts | `Workout` (`:682`) + `WorkoutRoute` (`:744`) | Activity sessions; not in current PDF. Candidate FHIR `Observation`/`Procedure` — defer to phase 2. |
| Personal records | `PersonalRecord` (`:778`) | Gamification; **exclude** from clinical export. |
| Medications | `Medication` (`:840`) + `MedicationSchedule` (`:915`) | name, dose, `treatmentClass` (GENERIC/GLP1), `deliveryForm` (ORAL/INJECTION, v1.6.0), `oneShot`, `startsOn`/`endsOn`, schedules. → FHIR `MedicationStatement`/`MedicationRequest`. |
| Dose titration | `MedicationDoseChange` (`:1054`) | GLP-1 dose history → FHIR `MedicationRequest` history or `dosageInstruction`. |
| Intake / compliance | `MedicationIntakeEvent` (`:1017`) | scheduledFor / takenAt / skipped / `injectionSite`. Compliance % computed in `src/lib/analytics/compliance.ts`. → FHIR `Observation` (medication-adherence) or rendered as PDF table only. |
| Side effects | `MedicationSideEffect` (`:1175`) | EMA-EPAR taxonomy, 1-5 Likert. → FHIR `Observation` (symptom) or `AdverseEvent`. |
| Inventory | `MedicationInventoryItem`/`Event` (`:1082/:1113`) | **exclude** from clinical export. |
| Mood | `MoodEntry` (`:1418`) | score 1-5, tags, `moodLoggedAt`. **Opt-in only** (privacy default off). → FHIR `Observation` (mood) — gate behind explicit selection. |
| AI Insights / Coach | `CoachConversation`/`CoachMessage` (`:2080/:2111`, `encryptedContent` Bytes), `User.insightsCachedText` (`schema.prisma:38`) | AI-generated prose. **Exclude from FHIR** (not clinical observations; could mislead a physician as if machine-diagnosed). Optionally render the latest **briefing summary** as a non-clinical "Patient notes" appendix in the PDF, clearly labelled "AI-generated, informational" — flag for maintainer (§7). |
| Patient identity | `User` (`:15`) | username, email, `heightCm`, `dateOfBirth`, `gender`, `timezone`, `glucoseUnit`, `thresholdsJson`. **Missing**: legal full name, insurer, insurance number (§2.3). |

### 2.3 New profile fields (added THIS release)

The brief states full name + insurer + insurance number are being added to the profile in v1.7.0.
They do **not** exist in `schema.prisma` yet (grep for `insurer|insurance|fullName|legalName` →
zero hits) and are **not** in any validation schema. The export design assumes:

```prisma
// additions to model User
fullName        String? @map("full_name")          // legal name for the report cover / FHIR Patient.name
insurerName     String? @map("insurer_name")        // e.g. "AOK Bayern" / FHIR Patient.contact or Coverage.payor
insuranceNumber String? @map("insurance_number")    // KVNR (10-char) / FHIR Patient.identifier (system = KVNR)
```

- These are **PII at rest** — per CLAUDE.md they must NOT be encrypted-only-if-policy-says, but
  note `insuranceNumber` (German KVNR) is a quasi-identifier; recommend storing it **encrypted**
  (`*Encrypted` convention, `src/lib/crypto.ts`) to match the project's at-rest posture. Flag to
  maintainer (§7) — the other profile fields (DOB, gender, height) are currently plaintext, so
  there's a consistency call to make.
- All three are **optional** on the cover: omitted lines collapse exactly like `practiceName` does
  today (`doctor-report-pdf-core.ts:183`).
- KVNR validation: 10 chars, leading letter + 9 digits, mod-10 check digit — add a Zod refine.

---

## 3. The enhanced PDF

### 3.1 Library decision

**Reuse `jspdf` + `jspdf-autotable`.** Rationale: isomorphic (the dual client/server render parity
is a load-bearing property at `doctor-report-data.ts:1-9`), already wired through i18n + tz, embeds
fonts with no network fetch (matters for ePA/PDF-A and for the no-external-resource CSP posture).
Swapping to `@react-pdf/renderer` or Puppeteer/Playwright-print would break isomorphism, add a
headless-Chromium dependency to the Alpine image (heavy, arm64 pain), and require explicit approval
per the Recharts-style "replacement requires approval" convention. **No new PDF library.**

### 3.2 Cover page (new)

```
┌──────────────────────────────────────────────────────────┐
│  Gesundheitsbericht                              [logo]    │  ← title (existing)
│  Persönlicher Gesundheitsbericht für die ärztliche Vorlage │  ← subtitle
│  ────────────────────────────────────────────────────────  │
│  Praxis: Dr. med. Mustermann                               │  ← practiceName (existing)
│  ────────────────────────────────────────────────────────  │
│  Patient:            <fullName ?? username>                │  ← NEW fullName line
│  Geburtsdatum:       1980-01-01                            │
│  Geschlecht:         männlich                              │
│  Größe:              180 cm                                │
│  Krankenkasse:       AOK Bayern                            │  ← NEW insurerName
│  Versichertennr.:    A123456789                            │  ← NEW insuranceNumber (KVNR)
│  Berichtszeitraum:   2026-01-01 — 2026-05-31              │
│  Erstellt am:        2026-05-31                            │
└──────────────────────────────────────────────────────────┘
```

Implementation: extend the `patientInfo[]` builder (`doctor-report-pdf-core.ts:203-241`) with three
new optional lines, and widen the `DoctorReportData.patient` shape (`doctor-report-data.ts:57-62`)
+ the `collectDoctorReportData` `select` (`:314-323`) to pull the new columns. New i18n keys:
`doctorReport.patientFullName`, `doctorReport.insurer`, `doctorReport.insuranceNumber` (×6 locales —
`i18n-call-site-coverage.test.ts` + `i18n-locale-integrity.test.ts` enforce this).

### 3.3 Clinical summary block (new, top of body)

A 4-6 line auto-generated factual summary above the vitals table (NOT AI — deterministic, like the
existing BP/BMI classification lines):
- "Über N Tage erfasst: X Messwerte über Y Parameter."
- Latest + trend arrow per primary vital (↑/↓/→ from first-half vs second-half mean).
- Medication-adherence headline (weighted mean across active meds).
- Any value crossing the user's effective threshold (`getEffectiveRange`) flagged "außerhalb Zielbereich".

This is the "physician reads one paragraph and knows the story" feature. Pure data, reuses
`effective-range.ts` + `compliance.ts`.

### 3.4 Charts (new, optional per selection)

- Render a **sparkline/trend line per selected vital** as a PNG and `doc.addImage(...)` into the PDF.
- Generation path: **server-side** chart-to-PNG. Do NOT pull headless Chromium. Use a lightweight
  pure-JS approach — render the line to an SVG string from the existing measurement series, then to
  PNG. Two viable options without a Chromium dependency:
  - `@napi-rs/canvas` or `canvas` to draw the polyline directly (no Recharts) — small, deterministic.
  - or hand-roll the polyline as vector lines using jsPDF's own `doc.lines()` primitive (**zero new
    dependency** — preferred for v1 to avoid a native module in the Alpine build). A jsPDF-native
    mini-sparkline (axis + polyline + min/max labels) is enough for a doctor handover and keeps the
    isomorphic + no-native-dep posture.
- Charts must remain visually consistent with the app's Recharts look only loosely — this is a
  print artefact, not the live dashboard, so the "charts must stay visually identical" rule
  (Recharts memory) does NOT bind here; flag as a deliberate scope note.
- **Selection-gated**: chart per domain only when that domain's toggle is on AND a new
  `includeCharts` flag is true (default true; off for a compact text-only report).

### 3.5 PDF/A (stretch, ePA-friendly)

ePA accepts PDF/A documents for unstructured upload. jsPDF does not emit PDF/A-1b conformance
metadata (XMP, OutputIntent, document-ID) out of the box. v1 ships a "PDF/A-leaning" file (embedded
standard fonts, no external resources, no JavaScript actions) which most practice systems accept;
**full PDF/A-1b conformance is a documented stretch goal**, not a v1.7.0 blocker. Flag to maintainer (§7).

### 3.6 Selection mechanics (PDF)

Extend `doctorReportPrefsSchema` (`doctor-report-prefs.ts:25`) from the current 7 flags to a
**grouped** shape, additive (forward-compat preserved by `.partial()` + defaults merge):

```ts
{
  vitals:        { weight, bp, pulse, bodyFat, oxygenSaturation, bodyComposition },
  cardioFitness: { restingHeartRate, hrv, vo2max },
  activity:      { steps, distance, energy, sleep },
  glucose:       boolean,          // all contexts together (already per-context inside)
  medications:   { list, compliance, glp1, sideEffects },
  mood:          boolean,          // privacy default OFF (unchanged)
  bmi:           boolean,
  includeCharts: boolean,          // default true
}
```

`MEASUREMENT_TYPE_SECTION` (`doctor-report-data.ts:591`) grows to map every clinically-relevant
`MeasurementType` to its group key. The mood privacy-by-default contract (never-query-when-off) is
preserved and extended: each new group's data is only read when its toggle is on.

---

## 4. Structured interchange export (FHIR R4)

### 4.1 Why FHIR R4, document Bundle, single JSON

- **German reality:** the ePA ("für alle", mandatory in all practices since 2025-10-01) ingests
  structured data as **FHIR Document Bundles** and unstructured data as PDF/A. There is no realistic
  path where a German physician imports a CDA/C-CDA XML from a patient PWA; FHIR is the structured
  lingua franca gematik standardised on (MIOs are FHIR). [gematik ePA], [HL7 PHR-format IG].
- **Apple parity:** Apple Health Records shares with doctors via FHIR + SMART; the iOS ecosystem the
  maintainer benchmarks against is FHIR-native. [Rhapsody/Apple-FHIR], [Apple HealthKitV2 export].
- **R4 not R5:** R4 (4.0.1) is the deployed, tooling-saturated baseline; R5/R6 are ballot/edge. Use R4.
- **Bundle.type = "document"** with a leading `Composition` ("cover page": author=Patient/app,
  subject=Patient, sections per domain) is the PHR-recommended shape for "a self-contained record
  handed to a clinician" — vs `collection`/`searchset` which are API-transport shapes. [HL7 PHR IG],
  [IPS Bundle examples].
- **Single `.json` file** (PHR IG: under 16 MB → Bundle saved as `.json`; over 16 MB → NDJSON bulk).
  Our per-user windowed export is comfortably under 16 MB, so **one `.json`** — no zip needed for the
  FHIR file itself. (A combined "handover package" zip that holds PDF + FHIR JSON together is offered
  separately, §5.3.)

### 4.2 Resource mapping per domain

| HealthLog data | FHIR R4 resource | Coding (system / code / unit) |
|---|---|---|
| User identity | `Patient` | `name` (fullName), `birthDate` (dateOfBirth), `gender`, `identifier` (KVNR: system `https://gematik.de/fhir/sid/telematik-id` or the KVNR namespace), `Observation`(body-height 8302-2). Insurer → `Coverage.payor` (display only) or `Patient.contact`. |
| WEIGHT | `Observation` (vital-signs profile) | LOINC **29463-7**, UCUM **kg** |
| BODY_MASS_INDEX / computed BMI | `Observation` | LOINC **39156-5**, **kg/m2** |
| BLOOD_PRESSURE_SYS+DIA | `Observation` (BP panel) | panel LOINC **85354-9**, components **8480-6** (sys) + **8462-4** (dia), **mm[Hg]** |
| PULSE / heart rate | `Observation` | LOINC **8867-4**, **/min** |
| RESTING_HEART_RATE | `Observation` | LOINC **40443-4**, **/min** |
| RESPIRATORY_RATE | `Observation` | LOINC **9279-1**, **/min** |
| BODY_TEMPERATURE | `Observation` | LOINC **8310-5**, **Cel** |
| OXYGEN_SATURATION | `Observation` | LOINC **2708-6** (or 59408-5 SpO2 by pulse ox), **%** |
| BODY_FAT (%) | `Observation` | LOINC **41982-0**, **%** |
| BLOOD_GLUCOSE | `Observation` | fasting LOINC **1558-6**, generic glucose **2339-0**, **mg/dL** (or mmol/L per user unit). Map `GlucoseContext` to the context-specific LOINC. |
| VO2_MAX | `Observation` | LOINC **84478-5**, **mL/min/kg** |
| HEART_RATE_VARIABILITY (SDNN) | `Observation` | LOINC **80404-7**, **ms** |
| ACTIVITY_STEPS | `Observation` | LOINC **41950-7** (steps/24h), **/{steps}/d** |
| SLEEP_DURATION | `Observation` (+ component per `SleepStage`) | LOINC **93832-4** (sleep duration), **min** |
| Body-composition family (TBW, bone, muscle, fat-mass, lean, visceral, PWV, vascular age) | `Observation` | LOINC where one exists; otherwise local `CodeableConcept` with `text` + UCUM unit. Document the local-code fallback inline. |
| Medications (active) | `MedicationStatement` | `medicationCodeableConcept` (free-text `.text` = name; no ATC lookup in v1), `dosage`, `effectivePeriod` (startsOn/endsOn), `status`. |
| Dose titration history | `MedicationStatement` per dose-change OR `dosage[]` history | reuse `MedicationDoseChange`. |
| Compliance % | `Observation` (medication-adherence) | LOINC **71799-1** (medication adherence) or local code; value = % over window. |
| Side effects (GLP-1) | `Observation` (symptom) | severity 1-5 as `valueInteger` + `interpretation`; EMA-EPAR category in `category`. |
| Mood | `Observation` | LOINC **76542-6** (mood) — **opt-in only**, omitted from Bundle when toggle off (read never issued, mirrors §1.1). |
| AI insights / coach | — | **NOT mapped** to FHIR (not a clinical observation). |

Every `Observation` carries `category = vital-signs|laboratory|activity|...`, `subject = Patient ref`,
`effectiveDateTime` (the per-user-tz ISO-with-offset already produced by `formatInUserTz`,
`src/lib/export.ts:79`), `status = final`, and a stable `id` (cuid → `Observation/<cuid>`).

### 4.3 Builder module

New `src/lib/fhir/build-bundle.ts` — pure function
`buildFhirDocumentBundle(data: DoctorReportData, patient, selection): FhirBundle`.
**Reuse the existing `collectDoctorReportData` aggregator** so the FHIR export and the PDF are
guaranteed to describe the same numbers (same source-of-truth property the two PDF endpoints already
share). FHIR types: hand-roll narrow TypeScript interfaces (do NOT pull a multi-MB `@types/fhir` or a
FHIR SDK — consistent with the "hand-rolled fetch over documented wire, no vendor SDKs" AI-provider
convention). Zod-validate the emitted shape in tests against a minimal Bundle schema.

### 4.4 No-markdown / XSS note

FHIR JSON is data, not rendered HTML — no markdown library involved, no `dangerouslySetInnerHTML`.
The `Composition.text` narrative (xhtml div) must be **escaped plain text**, not user-HTML.

---

## 5. API surface

New namespace `/api/export/...`, every route `apiHandler`-wrapped, `requireAuth()` (cookie OR Bearer),
shared `export:<userId>` **10/h** bucket (so structured + PDF + CSV can't be parallelised past the cap),
audit-logged, `annotate()`-instrumented. Same-origin; no CORS.

### 5.1 `POST /api/export/health-record`  (the flagship route)

Single entry point that produces **either** the PDF **or** the FHIR bundle **or** the combined zip,
driven by a Zod-validated selection payload.

```ts
// src/lib/validations/health-record-export.ts
const exportSelectionSchema = z.object({
  format: z.enum(["pdf", "fhir", "package"]),     // package = zip of both
  range:  z.object({                               // reuse normaliseDateRange semantics
    startDate: z.string().datetime().optional(),
    endDate:   z.string().datetime().optional(),
    days:      z.number().int().min(1).max(365).optional(),
  }).optional(),
  sections: doctorReportPrefsSchemaV2.partial().optional(),  // grouped shape, §3.6
  locale:   z.enum(locales).optional(),            // PDF only
  practiceName: z.string().max(120).optional(),
  includeCharts: z.boolean().optional(),
}).strict();
```

- **No `userId` in the body** (CLAUDE.md hard rule — narrowed from `requireAuth()`).
- Validation via `safeParse` + `returnAllZodIssues` → 422 multi-issue envelope on bad input (this
  route is strict, unlike the legacy doctor-report route which tolerates drift — the flagship route
  should fail loudly).
- Response:
  - `format: "pdf"` → `application/pdf`, `Content-Disposition: attachment; filename="healthlog-report-<date>.pdf"`.
  - `format: "fhir"` → `application/fhir+json`, filename `...-<date>.json`. (Bare body, not the
    `apiSuccess` envelope — same pattern as `full-backup`.)
  - `format: "package"` → `application/zip` containing `report.pdf` + `bundle.json` + a `README.txt`.
    Use a tiny zip writer; if none present, prefer `fflate` (small, no native dep) — confirm with
    maintainer before adding (§7). Falls back to two sequential single-file downloads if zip is descoped.
- Audit `health-record.export` with `{ format, days, sections, charts }` (never the values).
- `annotate({ action: { name: "export.health-record.build" }, meta: { format, bytes, days } })`.
- `Cache-Control: no-store` (sensitive PHI).

### 5.2 `GET /api/export/fhir`  (optional convenience)

Thin GET wrapper for "give me everything as FHIR, default 90-day window" — for power users / scripting
against a Bearer token. Same auth/rate-limit/audit. Optional; `POST .../health-record` covers it.

### 5.3 Keep existing routes

`/api/doctor-report`, `/api/doctor-report/pdf` (iOS depends on the server-render path), `/api/export*`
all stay. The new `health-record` route is additive — the iOS client can migrate to it later.

---

## 6. Selection UI sketch (ASCII)

Promote the existing dialog into a full "Health Record Export" surface (still inside Settings → Export,
above the secondary CSV cards). One screen, format toggle drives what's shown (per the
"no top/bottom split, dropdown drives the form" preference).

```
┌─ Gesundheitsbericht / Health Record Export ───────────────────────────┐
│                                                                        │
│  Format:   ( • PDF )  ( ○ Strukturiert (FHIR) )  ( ○ Paket: PDF+FHIR ) │
│                                                                        │
│  Zeitraum: [ Letzte 90 Tage ▾ ]   oder   von [____] bis [____]         │
│                                                                        │
│  Praxis (optional):  [ Dr. med. Mustermann____________________ ]       │  ← PDF only
│                                                                        │
│  Enthaltene Daten:                                                     │
│   ┌─ Vitalwerte ──────────────────────────────────────────────┐       │
│   │ [✓] Gewicht   [✓] Blutdruck   [✓] Puls   [✓] SpO₂          │       │
│   │ [✓] Körperfett   [ ] Körperzusammensetzung                 │       │
│   └────────────────────────────────────────────────────────────┘      │
│   ┌─ Herz & Fitness ──────────────────────────────────────────┐       │
│   │ [ ] Ruhepuls   [ ] HRV   [ ] VO₂max                        │       │
│   └────────────────────────────────────────────────────────────┘      │
│   ┌─ Aktivität & Schlaf ─[ ] Schritte [ ] Distanz [ ] Schlaf ─┐        │
│   └────────────────────────────────────────────────────────────┘      │
│   [✓] Blutzucker     [✓] Medikamente & Einnahmetreue                  │
│   [ ] Stimmung (standardmäßig aus — sensible Daten)                    │  ← mood opt-in
│   [✓] BMI            [✓] Trend-Diagramme einbetten (nur PDF)           │
│                                                                        │
│  ℹ Strukturierte Ausgabe folgt dem FHIR-R4-Standard (ePA-kompatibel). │  ← shown when FHIR/package
│                                                                        │
│                                    [ Vorschau ]   [ Erstellen ⤓ ]      │
└────────────────────────────────────────────────────────────────────────┘
```

- Format = FHIR/package hides PDF-only fields (practice name, charts checkbox) and reveals the
  ePA-compat note. Mood stays default-off everywhere. Section groups collapse on mobile (cards stack).
- "Vorschau" hits `POST /api/doctor-report` (JSON) to show a count summary before generating.
- New components: `health-record-export-panel.tsx` + `export-selection-groups.tsx` (kebab-case,
  `"use client"`; the group definitions live in a shared const so PDF + FHIR selection stay in sync).

---

## 7. Open questions for the maintainer

1. **Insurance number at rest** — store `insuranceNumber` (KVNR) **encrypted** (matches AES-256-GCM
   posture) while DOB/gender stay plaintext, or keep all three plaintext for consistency? (Recommend encrypted.)
2. **Zip dependency** — OK to add `fflate` (tiny, no native dep) for the `format: "package"` zip, or
   ship PDF + FHIR as two separate downloads in v1 and defer the bundle?
3. **AI briefing in the PDF** — include the latest deterministic briefing summary as a clearly-labelled
   "AI-generated, informational only" appendix, or keep all AI strictly out of the clinical artefact?
   (Lean: keep out, or behind an explicit off-by-default toggle.)
4. **PDF/A-1b** — pursue full conformance (XMP + OutputIntent, needs work jsPDF won't do natively) this
   release, or ship "PDF/A-leaning" and document full conformance as a follow-up?
5. **Chart rendering** — accept the jsPDF-native polyline sparkline (zero new dep) for v1, or invest in
   `@napi-rs/canvas` for richer charts (native module in the Alpine arm64 build)?

---

## 8. Test list

Unit (Vitest):
- `build-bundle.test.ts` — Bundle is `type:"document"`, leading Composition, every selected domain →
  correct LOINC/UCUM; mood absent when toggle off; soft-deleted rows absent; empty-domain omits resource.
- `health-record-export.validation.test.ts` — Zod `.strict()` rejects unknown keys, `userId` in body
  rejected, range cap honoured, returnAllZodIssues multi-issue envelope.
- PDF cover: new full-name/insurer/insurance lines render + omit cleanly when null (extend
  `doctor-report-pdf-core.test.ts`).
- KVNR Zod refine: valid/invalid check-digit cases.
- Clinical-summary block: deterministic output for a fixture, threshold-cross flagging.
- Selection-group → measurement-type mapping coverage (analogue to the existing enum-coverage test).
- i18n: new `doctorReport.*` keys resolve in all 6 locales (existing guards catch this).

Integration (testcontainers Postgres):
- `POST /api/export/health-record` format=fhir → valid Bundle, only the auth'd user's rows, audit row
  written, rate-limit shared bucket enforced (11th call in an hour → 429).
- format=pdf → `application/pdf` `%PDF-` magic bytes, correct Content-Disposition.
- format=package → zip contains both entries (if zip shipped).
- Cross-user isolation: user A's token can't export user B's data.

E2E (Playwright): selection panel — toggle format hides/shows PDF-only fields; mood default-off;
generate triggers a download; axe pass on the panel.

OpenAPI: `openapi:check` stays green after registry additions (§9).

## 9. OpenAPI additions

Add to `src/lib/openapi/registry.ts` + `routes.ts`, then `pnpm openapi:generate` and commit the YAML:
- `POST /api/export/health-record` — request `exportSelectionSchema`; responses 200
  (`application/pdf` | `application/fhir+json` | `application/zip` — document the content-type
  variance per `format`), 422 (multi-issue envelope), 429.
- `GET /api/export/fhir` (if shipped) — query `days`; 200 `application/fhir+json`.
- Register the FHIR `Bundle`/`Composition`/`Observation`/`MedicationStatement` response schema shapes
  (narrow, only the fields we emit) with `.meta()` annotations so the contract is documented for the
  iOS client and any third-party consumer.

---

## Sources

- HL7 FHIR R4 Vital Signs profile (LOINC + UCUM): https://hl7.org/fhir/R4/observation-vitalsigns.html
- FHIR R4 Observation: https://hl7.org/fhir/R4/observation.html ; BP example: https://www.hl7.org/fhir/R4/observation-example-bloodpressure.html
- HL7 Personal Health Record Format IG (Bundle .json <16MB, NDJSON bulk, Composition cover, .sphr zip):
  https://build.fhir.org/ig/HL7/personal-health-record-format-ig/en/recordkeeping.html
- International Patient Summary Bundle examples: https://build.fhir.org/ig/HL7/fhir-ips/Bundle-IPS-examples-Bundle-01.json.html
- gematik ePA "für alle" (FHIR Document Bundles + PDF/A, mandatory 2025-10-01):
  https://www.gematik.de/anwendungen/epa-fuer-alle ; https://fachportal.gematik.de/anwendungen/epa-fuer-alle
- Apple Health Records uses FHIR/SMART: https://rhapsody.health/blog/apple-health-fhir/ ;
  Apple HealthKitV2 clinical-records export format: https://support.mydatahelps.org/hc/en-us/articles/4412375685523
