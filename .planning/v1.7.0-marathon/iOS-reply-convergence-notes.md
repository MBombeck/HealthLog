# iOS reply — convergence points to enforce at reconcile (W10)

Source: `.planning/ios-coord/v1.7.0-ios-to-server-reply.md` (iOS repo branch
`feat/v0100-marathon`). The implementation agents were dispatched before this
reply landed; their field names already match, but verify/adjust these exact
details when reconciling each branch.

## W1 — dashboard widgets allowlist (was: "accept-and-ignore unknown")
Allowlist the EXACT 11 iOS-only ids (union with the 16 server-known = 27). Do NOT 422 on any:
`restingHeartRate, hrv, walkingSpeed, walkingAsymmetry, walkingStepLength, bmi,
bodyTemperature, walkingDoubleSupport, respiratoryRate, audioExposureEnvironment,
audioExposureHeadphone`.
Server-known (16, already accepted): `weight, bp, pulse, bodyFat, mood,
medications, sleep, steps, glucose, totalBodyWater, boneMass, bpInTarget,
oxygenSaturation, achievements, vo2Max, recentWorkouts`.
Persist visibility/order for all; ignore the unknown-to-web ones (web has no row).

## W1/W2 — schedule field names are now LOCKED (iOS will decode these verbatim)
- PRN: `asNeeded` / `prn` boolean.
- Cyclic: `cycleWeeksOn` / `cycleWeeksOff` + anchor.
- `liveActivityEnabled`, `criticalAlarmEnabled` booleans default false (GET/PUT).
- `nextDueAt` nullable, read-only, `null` ⇒ PRN.
Keep these names; iOS pins them from openapi.yaml at the tag.

## W5 — FHIR R4 must converge with iOS, not fork
iOS already emits a FHIR R4 Document Bundle on-device. Match its conventions so
either side's Bundle is interchangeable:
- `Composition` first entry, type LOINC `11503-0` "Medical records"; sections
  "Vital signs" + "Medications".
- `Patient` (name).
- `Observation` per vitals row AND per chart point; vital-signs LOINC-coded; UCUM
  units; BP as systolic/diastolic components.
- `MedicationStatement` per active (status `active`) + archived (status `completed`);
  dose+schedule as free-text Dosage.
- `DiagnosticReport` last entry; LOINC `85353-1` vital-signs panel; routes all
  Observation refs as `result[]`.
iOS LOINC/UCUM source: `HealthLog/FHIR/MetricFHIRMapper.swift` + `LOINCCode.swift`.
Selection contract to match or exceed: date-range 30/60/90/180/365 + 5 section
toggles (`vitals, charts, medications, adherence, mood`). Server export should be
a SUPERSET. Backup JSON/CSV already served by `POST /api/export`.

## W6 — snapshot adoption conditions if we want iOS to consume it (optional)
iOS leans yes IF: (1) SWR-cacheable as ONE key; (2) carries per-metric latest
value/state seed (`metricStates`) else iOS still fans out; (3) includes the
iOS-only widget ids in the layout block; (4) additive — per-store endpoints stay.
Web first-paint is the primary driver; treat iOS adoption as a bonus — keep the
envelope additive + one-key cacheable at minimum.

---

## FINAL LOCKS — from `.planning/ios-coord/v1.7.0-ios-convergence-locks.md`
(Landed AFTER the implementation agents were dispatched. Enforce these at reconcile;
the lock doc is the authoritative table — read it directly when reconciling W5/W1/W7.)

### W5 / FHIR — byte-identical LOINC/UCUM (HIGHEST reconcile risk)
The server FHIR `Observation` codes MUST match the iOS table byte-for-byte:
same `code.coding[].code`, `display`, and `valueQuantity.{code,unit}`. Source of
truth: `healthlog-iOS/.../FHIR/MetricFHIRMapper.swift:102-374` + `LOINCCode.swift`.
- Systems: LOINC `http://loinc.org`, UCUM `http://unitsofmeasure.org`.
- UCUM is case-sensitive canonical, brackets load-bearing: `mm[Hg]`, `/min`,
  `Cel` (NOT °C), `kg/m2`, `{steps}`, `{flights}`, `dB[A]`, `mL/min/kg`, `m/s`, `m`.
- 23 distinct LOINC codes (20 standard incl. BP panel 85354-9 + systolic 8480-6 +
  diastolic 8462-4; + 3 glucose-context: random/bedtime `2339-0`, fasting/beforeMeal
  `1558-6`, afterMeal `1521-4`).
- Key codes: weight `29463-7` kg; HR `8867-4` /min; resting HR `40443-4`; HRV(SDNN)
  `80404-7` ms; body temp `8310-5` Cel; SpO2 `59408-5` %; resp rate `9279-1` /min;
  body fat `41982-0` %; body water `73704-9` kg; bone mass `73708-0` kg; BMI
  `39156-5` kg/m2; sleep `93832-4` h; steps `41950-7` {steps}; VO2max `96402-2`
  mL/min/kg; walking speed `41957-2` m/s; walking asymmetry `91557-1` %; step
  length `41955-6` m; active energy `41981-2` kcal.
- 6 HK-PLACEHOLDER codes (emit the HK identifier string AS the code, do NOT invent
  a LOINC): walkingDoubleSupport `HKQuantityTypeIdentifierWalkingDoubleSupportPercentage` %;
  audio env `HKQuantityTypeIdentifierEnvironmentalAudioExposure` dB[A]; audio
  headphone `HKQuantityTypeIdentifierHeadphoneAudioExposure` dB[A]; flights
  `HKQuantityTypeIdentifierFlightsClimbed` {flights}; distance
  `HKQuantityTypeIdentifierDistanceWalkingRunning` m; daylight
  `HKQuantityTypeIdentifierTimeInDaylight` min.
- ⚠ codes carry `physicianReviewPending:true` on iOS (UI disclaimer only); server
  still emits the same code.
ACTION: diff W5's FHIR mapper against this table; align to byte-identical. If W5
built its own LOINC set from R-export.md, this table WINS.

### W1/W2 — final field names (adopt verbatim in openapi.yaml)
- PRN flag = **`asNeeded`** (Bool) — NOT `prn`. (iOS locked `asNeeded`.)
- Cyclic = `cycleWeeksOn` (Int?), `cycleWeeksOff` (Int?), `cycleAnchor` (ISO date String?).
- `liveActivityEnabled`, `criticalAlarmEnabled` (Bool, default false, GET/detail+PUT).
- `nextDueAt` (ISO8601 String?, read-only, null for PRN).
- Compliance per-day adds `due` (Bool) + `expectedCount` (Int).
- Widget enum: server source-of-truth file is `src/lib/dashboard-layout.ts` →
  `DASHBOARD_WIDGET_IDS`; widen to the full 27-ID catalogue (16 server-known + 11
  iOS-only from the convergence notes above). bmi IS one of the 11 iOS-only.

### W7 — walking speed stays m/s on the wire/FHIR; km/h is DISPLAY ONLY
iOS has NO km/h conversion and NO unit toggle. Our km/h is a presentation-layer
choice: convert display only (`km/h = m/s × 3.6`); persist + export `m/s`. The W5
FHIR walking-speed value MUST be `m/s` (UCUM `m/s`, LOINC `41957-2`) — so W7's
display transform must not leak into W5's export or the stored value. The global
unit toggle is web-only; fine, iOS unaffected.

### W6 — snapshot (if iOS is to consume): carry all 27 widget IDs + iOS MetricKind
raw values. Non-obvious raws: spo2="oxygenSaturation", bodyWater="totalBodyWater",
hrv="heartRateVariability", bmi="bodyMassIndex",
walkingAsymmetry="walkingAsymmetryPercentage",
walkingDoubleSupport="walkingDoubleSupportPercentage",
audioExposureEnvironment="environmentalAudioExposure",
audioExposureHeadphone="headphoneAudioExposure", activeEnergy="activeEnergyBurned".
