# v1.5.5 — six previously-deferred HK identifiers wired

Server-side change shipping on `main` for v1.5.5.

## Summary

Six HealthKit identifiers used to sit in
`HK_QUANTITY_TYPE_DEFERRED` inside
`src/lib/measurements/apple-health-mapping.ts`. The mapping returned
null; the batch route emitted HTTP 200 with a per-entry
`skipped:"unmappable_identifier"`; the iOS app read 200 as success
and advanced its sync anchor. Net effect: every sample carrying one
of these identifiers was silently dropped forever with no retry
path. The audit team flagged the gap on the v0.8.0 iOS pass.

The six identifiers now wire end-to-end with new `MeasurementType`
values + Zod validator entries + DB plausibility ranges + category /
PR-direction / list-meta / chart-token coverage:

| HK identifier                                              | MeasurementType              | DB unit       |
| ---------------------------------------------------------- | ---------------------------- | ------------- |
| `HKQuantityTypeIdentifierRespiratoryRate`                  | `RESPIRATORY_RATE`           | `breaths/min` |
| `HKQuantityTypeIdentifierBodyMassIndex`                    | `BODY_MASS_INDEX`            | `kg/m²`       |
| `HKQuantityTypeIdentifierLeanBodyMass`                     | `LEAN_BODY_MASS`             | `kg`          |
| `HKQuantityTypeIdentifierWalkingHeartRateAverage`          | `WALKING_HEART_RATE_AVERAGE` | `bpm`         |
| `HKQuantityTypeIdentifierWalkingAsymmetryPercentage`       | `WALKING_ASYMMETRY`          | `%`           |
| `HKQuantityTypeIdentifierWalkingDoubleSupportPercentage`   | `WALKING_DOUBLE_SUPPORT`     | `%`           |

DB migration: `prisma/migrations/0083_v155_ios_measurement_types`.
Pure additive `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.

## Unit convention — server-side scaling is canonical

The audit also flagged a footgun in the gait-percent path. Two
conventions for "percent" values were live in the tree:

- `walkingAsymmetryPercentage` + `walkingDoubleSupportPercentage`
  — iOS multiplied the HK reading (`0..1` fraction) by ×100 **before
  upload**, so the wire value already lived in `0..100`.
- `walkingSteadiness` (v1.4.30) — iOS sent the raw HK reading
  (`0..1` fraction), the server applied the ×100 at ingest. Same
  shape as the existing `oxygenSaturation` + `bodyFatPercentage`
  paths.

The split was source-of-bugs: every future contributor adding a new
percent metric had to remember which convention applied. We picked
the cleaner one as the project convention:

> **Server-side scaling is canonical.** Every HealthKit value flows
> over the wire as the raw HK reading. Whatever ×100 / unit-bend /
> clamp the canonical DB shape needs, the server applies it inside
> `convertToDbUnit` at ingest.

`apple-health-mapping.ts` now documents this convention at the top
of the `APPLE_HEALTH_TYPE_MAP` block.

### iOS migration window

The v1.5.5 server release ships with the new gait identifiers
applying the ×100 scaling server-side. iOS releases that still
multiply by 100 pre-upload will land values in the `0..10000` band
— the plausibility-range guard (`0..100`) will reject them with
`skipped:"value_out_of_range"` per entry.

Action item for the iOS client: drop the pre-multiplication for
`HKQuantityTypeIdentifierWalkingAsymmetryPercentage` and
`HKQuantityTypeIdentifierWalkingDoubleSupportPercentage` so the raw
HK reading (`0..1`) flows over the wire. The server will apply the
×100 the same way it already does for `oxygenSaturation`,
`bodyFatPercentage`, and `appleWalkingSteadiness`.

Suggested timing: one iOS release alongside the v1.5.5 server cut,
or the next regular iOS sync if the existing TestFlight build can
wait. The plausibility-range guard fails closed — no bad data lands
in the DB; the only impact during the window is that those two
gait identifiers ingest as `skipped:"value_out_of_range"` instead
of as recorded samples.
