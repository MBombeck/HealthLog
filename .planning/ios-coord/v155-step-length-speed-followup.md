# v1.5.5 — walking step length + walking speed wired (follow-up)

Server-side change shipping on `main`, follows
[`v155-wire-six-deferred-identifiers.md`](./v155-wire-six-deferred-identifiers.md).

## Summary

After the six-identifier wire-up landed, the iOS team flagged two
more HK quantity types they needed mapped before they could flip
them client-side: `walkingStepLength` and `walkingSpeed`. Both sat
in `HK_QUANTITY_TYPE_DEFERRED` inside
`src/lib/measurements/apple-health-mapping.ts`; the batch route
returned HTTP 200 with a per-entry `skipped:"unmappable_identifier"`,
and the iOS app advanced its sync anchor on the 200. Every sample
carrying one of these identifiers was lost forever, no retry path.

Both identifiers now wire end-to-end with new `MeasurementType`
values + Zod validator entries + DB plausibility ranges + category /
PR-direction / list-meta / chart-token coverage:

| HK identifier                                  | MeasurementType       | DB unit |
| ---------------------------------------------- | --------------------- | ------- |
| `HKQuantityTypeIdentifierWalkingStepLength`    | `WALKING_STEP_LENGTH` | `m`     |
| `HKQuantityTypeIdentifierWalkingSpeed`         | `WALKING_SPEED`       | `m/s`   |

DB migration:
`prisma/migrations/0086_v155_ios_walking_step_length_speed`. Pure
additive `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.

## Unit convention — raw SI, NO server-side scaling

The percent gait metrics added in the earlier wire-up
(`walkingAsymmetryPercentage`, `walkingDoubleSupportPercentage`)
ride the ×100 server-side scaling path because Apple ships them as
0..1 fractions. The two follow-up identifiers are different:

- `walkingStepLength` ships as raw metres on the wire.
- `walkingSpeed` ships as raw metres-per-second on the wire.

Both pass through `convertToDbUnit` as identity — no scaling, no
clamp. The convention block at the top of `apple-health-mapping.ts`
now spells the split out (percent path vs raw SI path) so a future
contributor wiring a new gait identifier picks the correct bucket.

## iOS action

iOS can flip both identifiers client-side now. Wire format expected
by the server:

```json
{
  "hkIdentifier": "HKQuantityTypeIdentifierWalkingStepLength",
  "value": 0.72,
  "unit": "m",
  "startDate": "2026-05-28T09:00:00.000Z",
  "endDate": "2026-05-28T09:00:00.000Z"
}
```

```json
{
  "hkIdentifier": "HKQuantityTypeIdentifierWalkingSpeed",
  "value": 1.34,
  "unit": "m/s",
  "startDate": "2026-05-28T09:00:00.000Z",
  "endDate": "2026-05-28T09:00:00.000Z"
}
```

The server stores both verbatim — no pre-multiplication needed and
no pre-multiplication accepted (the plausibility-range guard caps
step length at 2.0 m and speed at 3.0 m/s; a stray ×100 would land
in `skipped:"value_out_of_range"`).

## Plausibility ranges

Both ranges are tuned for the adult walking band with margin for
the extremes (race-walk speeds for the upper edge, shuffling gait
for the lower):

- `WALKING_STEP_LENGTH`: 0.1–2.0 m
- `WALKING_SPEED`: 0.1–3.0 m/s

## Personal-record direction

- `WALKING_SPEED` → `MAX`. Walking speed is the "sixth vital sign"
  in older-adult medicine — faster casual gait correlates with
  cardiovascular fitness, sarcopenia recovery, and overall mobility
  resilience. Apple's own Mobility section frames higher as the
  achievement.
- `WALKING_STEP_LENGTH` → `null` (no PR direction). Step length is
  a state metric: taller users have longer strides regardless of
  fitness, and very long strides can also signal an unsafe
  overstride. The trend chart still surfaces deltas, but the PR
  detection worker skips this type.
