/**
 * The plausibility band each measurement type may occupy, and the check every
 * ingest path runs against it. Zod-free on purpose: the value-domain facts
 * (`value-domain.ts`) read the band on the client, and this module keeps that
 * read from pulling the measurement schemas, and Zod with them, into every
 * metric page. `@/lib/validations/measurement` re-exports both for the
 * server-side writers.
 */

// Plausible ranges per measurement type
export const VALUE_RANGES: Record<string, { min: number; max: number }> = {
  WEIGHT: { min: 1, max: 500 },
  BLOOD_PRESSURE_SYS: { min: 40, max: 300 },
  BLOOD_PRESSURE_DIA: { min: 20, max: 200 },
  PULSE: { min: 20, max: 300 },
  BODY_FAT: { min: 1, max: 80 },
  // Minutes (v1.4.23 unit change). Per-stage rows can run from a few
  // seconds (a brief awakening) to 600+ minutes (a long IN_BED block),
  // so the upper bound covers a 24-hour day.
  SLEEP_DURATION: { min: 0, max: 1440 },
  ACTIVITY_STEPS: { min: 0, max: 200000 },
  BLOOD_GLUCOSE: { min: 20, max: 800 }, // mg/dL — covers severe hypo to severe hyperglycemia
  // Beta-hydroxybutyrate, mmol/L. The blood ketone meters people type these
  // off (Abbott Precision Xtra / FreeStyle Optium, Keto-Mojo, Nova Max Plus)
  // measure from 0.0 or 0.1 up to 8.0 mmol/L and print "HI" above it; 10
  // leaves room for a venous value read off a lab sheet. A meter reads 0.0,
  // so zero is a real reading, not an empty one.
  BLOOD_KETONES: { min: 0, max: 10 },
  TOTAL_BODY_WATER: { min: 5, max: 100 }, // kg of water — adults typically 30–55 kg
  BONE_MASS: { min: 0.5, max: 8 }, // kg — adult plausibility (typical 2.5–4.5 kg)
  // Pulse oximetry (SpO2). BTS Guideline 2017 + ATS clinical practice put the
  // healthy resting range at 95–100%. We accept down to 50% so a faulty-sensor
  // critically-low reading still gets logged for the doctor to see; below 50%
  // is incompatible with sustained life and almost certainly a sensor glitch.
  OXYGEN_SATURATION: { min: 50, max: 100 },
  // ── v1.4.23 Apple Health ranges ──
  // HRV SDNN ms — Apple's own "high HRV" threshold sits ~80 ms; lows can
  // reach 5–10 ms in stressed/sick samples. 200 ms is a generous upper
  // bound for unusually relaxed athletic windows.
  HEART_RATE_VARIABILITY: { min: 1, max: 200 },
  // Resting HR bpm — endurance athletes can reach the high 30s; severe
  // tachycardia caps below 220.
  RESTING_HEART_RATE: { min: 25, max: 220 },
  // Active energy kcal/sample — a daily-rollup sample tops out around
  // 6–8000 kcal even for ultra-endurance days.
  ACTIVE_ENERGY_BURNED: { min: 0, max: 10000 },
  // Resting energy kcal/sample — a whole day at rest sits around 1200–3000
  // kcal; the same ceiling as active energy leaves room for a large body.
  BASAL_ENERGY_BURNED: { min: 0, max: 10000 },
  // Flights — vertical-feet/3 ≈ flights; cap generous.
  FLIGHTS_CLIMBED: { min: 0, max: 1000 },
  // Walking/running distance per sample (metres). 200 km covers an
  // ultra-marathon or a multi-stage day.
  WALKING_RUNNING_DISTANCE: { min: 0, max: 200000 },
  // VO2 max mL/(kg·min) — elite endurance hovers ~85; sedentary floor ~10.
  VO2_MAX: { min: 5, max: 100 },
  // Body temperature °C — survivable lows ~28; severe hyperthermia ~45.
  BODY_TEMPERATURE: { min: 28, max: 45 },
  // ── v1.4.25 W5d Withings full coverage ──
  // Fat-free mass kg — adult plausibility, ~30 kg (small adult) to 120 kg
  // (large lean athlete). Same bounds as weight minus a fat-mass floor.
  FAT_FREE_MASS: { min: 10, max: 250 },
  // Fat mass kg — pairs with FAT_FREE_MASS so totals reconcile to weight.
  FAT_MASS: { min: 0, max: 250 },
  // Muscle mass kg — sub-component of fat-free mass; widest sensible bound.
  MUSCLE_MASS: { min: 5, max: 200 },
  // Skin temperature °C — surface temps run cooler than core. ScanWatch's
  // dermal sensor reports a relative offset that lands in the 25–40 °C
  // band; treat anything outside as a sensor glitch.
  SKIN_TEMPERATURE: { min: 20, max: 45 },
  // Pulse-wave velocity m/s — clinical ranges sit ~4–15 m/s. Higher
  // numbers indicate stiffer arteries (cardiovascular risk).
  PULSE_WAVE_VELOCITY: { min: 1, max: 30 },
  // Vascular age in years — Withings derives this from PWV + chronological
  // age; the value is a "biological age" not a chronological one. Hard cap
  // at 130 because that's the human longevity record.
  VASCULAR_AGE: { min: 10, max: 130 },
  // Visceral fat rating 1–12 (Withings' own scale; not a percent).
  VISCERAL_FAT: { min: 0, max: 30 },
  // ── v1.4.25 W8d Apple Health server-prep ──
  // Audio exposure dBA — Apple's "loud audio" warning sits at 80 dBA;
  // concerts run 100–115 dBA; 140 dBA is the pain threshold. The floor
  // of 30 dBA covers a quiet bedroom; anything below is silence and
  // almost certainly a sensor artefact.
  AUDIO_EXPOSURE_ENV: { min: 30, max: 140 },
  // Headphone audio caps slightly below the open-air upper edge because
  // sealed-driver listening physically cannot reach a concert PA's SPL.
  AUDIO_EXPOSURE_HEADPHONE: { min: 30, max: 140 },
  // Time in daylight (minutes/day) — full 24-hour window. Outdoor work
  // tops the range; sedentary indoor days sit near 0.
  TIME_IN_DAYLIGHT: { min: 0, max: 1440 },
  // ── v1.5.5 iOS-coord additions ──
  // Respiratory rate breaths/min — adult range ~12-20 at rest; severe
  // distress can spike past 40; bradypnea floor ~4. Generous bounds.
  RESPIRATORY_RATE: { min: 3, max: 60 },
  // BMI kg/m² — sub-12 is starvation-class, 70 covers extreme obesity.
  // Outside the band is almost certainly a height-or-weight typo.
  BODY_MASS_INDEX: { min: 8, max: 70 },
  // Lean body mass kg — adult plausibility, ~25 kg (small adult) to
  // 150 kg (extreme lean athlete). Same shape as FAT_FREE_MASS.
  LEAN_BODY_MASS: { min: 10, max: 250 },
  // Walking heart rate average bpm — endurance athletes can sit in
  // the high 70s while walking; ailing or post-stimulant readings can
  // touch 200. Same upper bound as the spot PULSE / RESTING_HEART_RATE.
  WALKING_HEART_RATE_AVERAGE: { min: 30, max: 220 },
  // Gait percent (0-100). Apple ships these as 0..1 fractions; after
  // the ×100 server-side scaling the canonical band is 0..100.
  WALKING_ASYMMETRY: { min: 0, max: 100 },
  WALKING_DOUBLE_SUPPORT: { min: 0, max: 100 },
  // Same ×100-scaled 0..100 percent as its two gait siblings above. The
  // entry was simply missing; the map is the app's plausibility domain AND
  // (via `value-domain.ts`) the answer to "can this metric be negative",
  // so an omission reads as "unknown" on both questions.
  WALKING_STEADINESS: { min: 0, max: 100 },
  // ── v1.5.5 iOS-coord follow-up — raw-SI gait pair ──
  // Step length (metres) — adult walking sits around 0.5–0.8 m; the
  // 0.1 floor captures shuffling gait and the 2.0 ceiling covers
  // unusually tall sprinters without catching obvious sensor noise.
  WALKING_STEP_LENGTH: { min: 0.1, max: 2.0 },
  // Walking speed (m/s) — healthy adult casual gait ≈ 1.2–1.4 m/s;
  // brisk walking tops out near 2.2 m/s before transitioning to a
  // run. The 0.1 floor captures a very slow shuffle; 3.0 covers
  // race-walking record territory.
  WALKING_SPEED: { min: 0.1, max: 3.0 },
  // ── v1.10.0 — additive HealthKit signals (WX-A) ──
  // Cardio recovery (bpm) — the one-minute HR drop after peak exertion.
  // Trained athletes can drop 50+ bpm; an unfit or autonomically
  // impaired recovery sits in the single digits. 0 is a flat (poor)
  // recovery; 100 is a generous ceiling beyond any plausible reading.
  CARDIO_RECOVERY: { min: 0, max: 100 },
  // Wrist temperature (°C) — overnight skin-side reading. Runs cooler
  // than core; the 30–42 band covers the plausible nighttime range and
  // rejects obvious sensor glitches. Same shape as SKIN_TEMPERATURE.
  WRIST_TEMPERATURE: { min: 30, max: 42 },
  // Fall count — a daily tally. A handful in a bad day is plausible;
  // 50 is a generous ceiling that still catches a runaway sensor.
  FALL_COUNT: { min: 0, max: 50 },
  // Six-minute-walk distance (metres). Healthy adults walk ~400–700 m;
  // the 50 m floor captures severe impairment and the 1000 m ceiling
  // covers an unusually fit reading without admitting sensor noise.
  SIX_MINUTE_WALK_DISTANCE: { min: 50, max: 1000 },
  // Stair gait speed (m/s) — slower than level walking. Adult stair
  // ascent sits around 0.4–0.7 m/s, descent slightly faster. The 0.05
  // floor captures a very slow climb; 2.0 is well above any sustained
  // stair pace and rejects a free-fall artefact.
  STAIR_ASCENT_SPEED: { min: 0.05, max: 2.0 },
  STAIR_DESCENT_SPEED: { min: 0.05, max: 2.0 },
  // Breathing-disturbance index (count). A per-night index; 0 is an
  // undisturbed night and the 1000 ceiling is generous headroom over
  // any plausible severe-apnea night.
  BREATHING_DISTURBANCES: { min: 0, max: 1000 },
  // ── v1.10.0 — categorical events (WX-B) ──
  // EVENT rows carry a fixed `value = 1` (one fired event). The range pins
  // the value so a malformed ingest (value 0, or a stray sensor number)
  // is rejected rather than stored as a phantom event.
  IRREGULAR_RHYTHM_NOTIFICATION: { min: 1, max: 1 },
  HIGH_HEART_RATE_EVENT: { min: 1, max: 1 },
  LOW_HEART_RATE_EVENT: { min: 1, max: 1 },
  WALKING_STEADINESS_EVENT: { min: 1, max: 1 },
  BREATHING_DISTURBANCE_EVENT: { min: 1, max: 1 },
  // Loud-listening event flag (env + headphone). One fired event per row, so
  // the floor is 1 — a non-event is not stored. The entry was missing from
  // the map entirely, which let ANY number through ingest, including a
  // negative one. The ceiling stays generous rather than pinned at 1 like the
  // five events above: this type is written only by the iOS client and
  // nothing in this repo asserts the exact value, so the floor is the part
  // that is certain.
  AUDIO_EXPOSURE_EVENT: { min: 1, max: 1000 },
  // ── v1.10.0 — computed scores (WX-C) ──
  // Server-derived 0–100 scores. The plausibility band pins them to the
  // score range so a malformed store (a stray negative or > 100) is rejected.
  RECOVERY_SCORE: { min: 0, max: 100 },
  STRESS_SCORE: { min: 0, max: 100 },
  STRAIN_SCORE: { min: 0, max: 100 },
  // ── v1.11.0 — WHOOP-native score classes ──
  // RMSSD HRV (ms). Lows reach single digits in stressed samples. RMSSD runs
  // higher than SDNN in relaxed, well-trained sleepers, and nightly readings
  // above 200 ms are real (#1110), so the ceiling sits at 300 ms.
  HRV_RMSSD: { min: 1, max: 300 },
  // Day / workout strain on WHOOP's bounded 0–21 scale.
  DAY_STRAIN: { min: 0, max: 21 },
  WORKOUT_STRAIN: { min: 0, max: 21 },
  // Sleep quality percentages (0–100).
  SLEEP_PERFORMANCE: { min: 0, max: 100 },
  SLEEP_EFFICIENCY: { min: 0, max: 100 },
  SLEEP_CONSISTENCY: { min: 0, max: 100 },
  // Recommended sleep duration in minutes — 0..1440 covers the 24-hour day.
  SLEEP_NEED: { min: 0, max: 1440 },
  // Day energy expenditure in kJ — 50 000 kJ (~12 000 kcal) is a generous
  // ceiling over any plausible ultra-endurance day.
  ENERGY_EXPENDITURE_KJ: { min: 0, max: 50000 },
  // ── v1.12.8 — WHOOP cycle + sleep coverage completion ──
  // Daily average / max heart rate bpm — same plausibility band as the
  // spot PULSE: endurance athletes touch the 30s at rest, severe
  // tachycardia caps below 300.
  AVERAGE_HEART_RATE: { min: 20, max: 300 },
  MAX_HEART_RATE: { min: 20, max: 300 },
  // Per-night sleep disturbance count — 0 is an undisturbed night; 200 is a
  // generous ceiling over any plausible severely-fragmented night.
  SLEEP_DISTURBANCE_COUNT: { min: 0, max: 200 },
  // ── v1.17.1 — Polar Nightly Recharge + Training Load Pro components ──
  // ANS charge is a baseline-relative autonomic deviation that can run
  // negative; a generous symmetric ±100 band covers any plausible reading.
  // Cardio Load is a non-negative cumulative-strain figure; 1000 is a generous
  // ceiling over any plausible single-day training load.
  ANS_CHARGE: { min: -100, max: 100 },
  CARDIO_LOAD: { min: 0, max: 1000 },
  // ── v1.17.1 — Oura coverage completion ──
  // Sleep Score (0–100), same band as the other score classes.
  SLEEP_SCORE: { min: 0, max: 100 },
  // Body-temperature deviation (°C) — a signed nightly offset centred on 0.
  // Oura clamps its own display near ±1 °C; ±5 °C is a generous band that
  // rejects an obvious sensor glitch while keeping every real illness /
  // luteal-phase swing.
  BODY_TEMPERATURE_DEVIATION: { min: -5, max: 5 },
  // ── v1.19.0 — Oura resilience ──
  // Ordinal level scale: 1 (limited) … 5 (exceptional). The closed encoding
  // never falls outside this band.
  RESILIENCE: { min: 1, max: 5 },
  // ── v1.25 — clinical-signals wave ──
  // PHQ-9 total 0–27, GAD-7 total 0–21 — server-derived from the screener.
  PHQ9_SCORE: { min: 0, max: 27 },
  GAD7_SCORE: { min: 0, max: 21 },
  // ── v1.27.9 — screening scores. WHO-5 reported percentage 0–100 (raw × 4),
  // SCI total 0–32 — both server-derived, higher = better.
  WHO5_SCORE: { min: 0, max: 100 },
  SCI_SCORE: { min: 0, max: 32 },
  // ── v1.44 — the minute rings and mindful minutes are bounded by the day;
  // a row is one sample or one day's total, never more than 1440 minutes.
  EXERCISE_MINUTES: { min: 0, max: 1440 },
  STAND_MINUTES: { min: 0, max: 1440 },
  MINDFUL_MINUTES: { min: 0, max: 1440 },
  // Stood hours: 1 per hour sample, at most 24 on a day's total.
  STAND_HOURS: { min: 0, max: 24 },
  // State of Mind valence: HealthKit's closed −1..1 scale.
  STATE_OF_MIND_VALENCE: { min: -1, max: 1 },
  // AFib burden as a percent of the week, after the ×100 scaling. A client
  // that already scaled sends 2 for 2 %, which lands at 200 and is refused.
  AFIB_BURDEN: { min: 0, max: 100 },
  // ── v1.44 — room climate. CO2: outdoor air sits near 420 ppm and a closed
  // bedroom can pass 3000; consumer sensors top out at 5000–10000 ppm.
  INDOOR_CO2: { min: 0, max: 10000 },
  // Indoor air °C: a cold cellar to an overheated attic.
  INDOOR_TEMPERATURE: { min: -20, max: 60 },
  // Relative humidity, percent.
  INDOOR_HUMIDITY: { min: 0, max: 100 },
  // Garmin's 0–100 scores. Acute load is an EWMA of activity load;
  // a heavy training block reaches the high hundreds, so 3000 leaves room
  // without admitting a unit slip.
  BODY_BATTERY: { min: 0, max: 100 },
  STRESS_LEVEL: { min: 0, max: 100 },
  TRAINING_READINESS: { min: 0, max: 100 },
  ACUTE_TRAINING_LOAD: { min: 0, max: 3000 },
  // Grip strength kg — a child can read in the single digits, an elite athlete
  // tops ~90 kg; 120 is a generous ceiling that still rejects sensor noise.
  GRIP_STRENGTH: { min: 0, max: 120 },
  // Pain NRS — the validated 0–10 scale; the closed band pins the integer.
  PAIN_NRS: { min: 0, max: 10 },
  // Waist circumference cm — paediatric lows ~30, severe obesity ~250.
  WAIST_CIRCUMFERENCE: { min: 30, max: 250 },
  // Waist-to-height ratio — dimensionless; healthy ~0.4–0.5, the band is
  // generous either side to admit any plausible body habitus.
  WAIST_TO_HEIGHT: { min: 0.2, max: 1.5 },
};

export function validateMeasurementRange(
  type: string,
  value: number,
): string | null {
  const range = VALUE_RANGES[type];
  if (range && (value < range.min || value > range.max)) {
    return `Value must be between ${range.min} and ${range.max}`;
  }
  return null;
}
