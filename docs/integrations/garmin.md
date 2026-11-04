# Garmin

HealthLog reads Garmin Connect directly through Garmin's **Personal API**: you
create a key for your own account in Garmin Connect, paste it into HealthLog,
and the server pulls your data every hour. Nothing is pushed by Garmin, and
nothing is written back.

The Personal API is for your own data only. Each person on an instance
creates and pastes their own key; there is no shared app and no operator
setup.

## Create a key

1. Open [Garmin Connect → Settings → Personal API](https://connect.garmin.com/app/settings/personalApiToken).
2. Create a key and choose how long it stays valid: 30, 90, 180 days or one
   year.
3. Copy it right away. Garmin shows the key once.

## Connect

Open **Settings → Integrations → Garmin**, paste the key, and pick the same
validity you chose in Garmin Connect. HealthLog checks the key with Garmin
before storing anything, so a mistyped or revoked key is refused on the spot.
The key is stored encrypted at rest and is never shown again, logged or sent
anywhere but Garmin.

Accounts registered with Garmin's China service work too: a key the global
service does not know is tried there once, and the service that accepts it is
remembered.

After connecting, the last 30 days arrive within a minute and the rest of your
history follows in the background. The card says "Older history is still
loading" until it is done.

## Key expiry

Garmin keys expire and cannot be extended. Garmin does not report a key's end
date through the API, so HealthLog works it out from the validity you picked
at connect, and replaces that estimate with Garmin's own date once the key is
in its last day (the short-lived tokens it buys are cut off at the key's end).

From seven days before the end the card says when the key expires. When it
has expired, or you revoked it in Garmin Connect, syncing stops and the card
asks for a new key: create one, open **Replace key** in the card's menu and
paste it. Nothing imported is lost. If you did not pick a validity, the card
says that it cannot warn ahead.

## What comes through

| Garmin data                                                           | HealthLog type             | Unit          |
| --------------------------------------------------------------------- | -------------------------- | ------------- |
| Steps                                                                 | `ACTIVITY_STEPS`           | steps         |
| Step distance                                                         | `WALKING_RUNNING_DISTANCE` | m             |
| Floors climbed                                                        | `FLIGHTS_CLIMBED`          | flights       |
| Active calories                                                       | `ACTIVE_ENERGY_BURNED`     | kcal          |
| Resting heart rate                                                    | `RESTING_HEART_RATE`       | bpm           |
| All-day average stress level                                          | `STRESS_LEVEL`             | 0–100         |
| Body Battery (the day's high)                                         | `BODY_BATTERY`             | 0–100         |
| Sleep stages (light, deep, REM, awake)                                | `SLEEP_DURATION` per stage | minutes       |
| Sleep score                                                           | `SLEEP_SCORE`              | 0–100         |
| Average overnight SpO₂                                                | `OXYGEN_SATURATION`        | %             |
| Average overnight breathing rate                                      | `RESPIRATORY_RATE`         | breaths/min   |
| Overnight HRV (RMSSD)                                                 | `HRV_RMSSD`                | ms            |
| Weight, BMI, body fat, body water, muscle and bone mass, visceral fat | the body-composition types | kg, %, rating |
| Activities                                                            | workouts                   |               |
| Logged period days                                                    | the cycle tracker          |               |

Notes:

- Garmin's HRV is RMSSD and lands on `HRV_RMSSD`. Garmin reports no SDNN, so
  nothing is written to `HEART_RATE_VARIABILITY`.
- Stress and Body Battery are Garmin's own scores and keep types of their own.
  They are not mixed into HealthLog's computed stress score.
- Days you did not wear the watch import nothing, not zeros.
- Period days are only added on days you have not logged yourself; your own
  entries are never changed. Cycles Garmin only predicts are not imported.
- When the same data also arrives through Apple Health or Health Connect, the
  source order in **Settings → Sources** decides which one a chart shows.
  Garmin ranks with the other watches.

## What the Personal API does not carry

Training Readiness, Training Status, acute training load and recovery time
are not part of the Personal API. If you read them elsewhere, for example
through a Home Assistant integration, push them through an ingest token: see
[Home Assistant](./home-assistant.md#garmin-training-figures). They land as
`TRAINING_READINESS` and `ACUTE_TRAINING_LOAD` and show on the recovery page
beside Body Battery.

## Limits

- Garmin sets how many requests a key may make. HealthLog reads one resource
  at a time and stops the hour's run at Garmin's first rate-limit answer; the
  history backfill waits as long as Garmin asks before it goes on.
- Disconnecting removes the key from HealthLog. It stays valid at Garmin until
  you revoke it there.

## Without a key

Garmin Connect also writes to Apple Health on iOS and to Google Health Connect
on Android, so the [Apple Health](./apple-health.md) and
[Google Health](./google-health.md) paths keep working for anyone who prefers
not to create a key. Body Battery, stress and Garmin's sleep score only come
through the Personal API.
