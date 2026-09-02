# Home Assistant and other push integrations

HealthLog pulls from Withings, WHOOP, Fitbit, Oura, Polar and Strava over
OAuth. A local sensor has no such door: a BLE scale, a Garmin bridge or a
Zigbee thermometer lives in your own automation platform and has to push. This
page covers that path — a token you mint yourself, and the two endpoints it
reaches.

Nothing here is specific to Home Assistant. Node-RED, a cron job with `curl`,
or anything else that can set a header works the same way.

## Mint a token

Settings → API & Tokens → **Measurement ingest token**. Name it after the thing
you are pasting it into, because that name is what you will be reading later
when you decide whether to revoke it.

The token is shown **once**. It is stored as an HMAC, so there is no page that
can show it to you again — if you lose it, mint another and revoke the old one.

Tokens expire after a year by default. They appear in the API Tokens list on
the same page alongside every other credential on the account, and are revoked
there.

## What the token can and cannot do

It can add readings, on your own record, through:

- `POST /api/measurements` — one reading, or a small array of them
- `POST /api/measurements/batch` — up to 500 entries per call

It **cannot** read a reading back, change or delete one, reach the export, or
mint another token. That is the point of it being a separate credential rather
than a general one: a container you do not fully trust — a Home Assistant
add-on, a script from a forum — holds something whose worst case is junk in
your own record, not your health history leaving the building.

It also cannot be pointed at somebody else's record. If an account has shared
their record with you, this credential still will not write to it; use the web
app for that.

## Readings are marked as coming from an external device

Rows written with this token carry `source: EXTERNAL`. They show a badge in the
measurements list and can be picked out with the source filter there, so months
later you can still tell which readings came off the scale and which you typed
in yourself. Three consequences worth knowing:

- You can correct them in the UI. Readings owned by a connected provider are
  read-only, because the number is the provider's; these are your own hardware's
  and stay editable.
- **The payload must not name a source at all.** The server decides it from the
  token. A body carrying `"source": "MANUAL"`, `"source": "APPLE_HEALTH"` or
  anything else is refused with a 422 rather than quietly relabelled — you get
  told on the first call instead of discovering later that your rows say
  something you did not ask for. The example below sends no `source`, which is
  all you need.
- They do not claim to be from Apple Health. That source is half the
  deduplication key the iOS app writes into, and a bridge borrowing it corrupts
  the phone's sync rather than merely mislabelling a row. `EXTERNAL` gives these
  writes their own namespace instead, so a bridge's ids can never collide with
  the phone's.

For the same reason, a push through this token does not move the native sync
checkpoint. Your phone's own sync window is unaffected by your scale.

If you were already pushing readings with an older build, those rows stay
`MANUAL` — there is no way to tell them apart retroactively, which is the whole
reason for this label. If a re-push of the same entries produces duplicates,
delete the older pair.

## Home Assistant example

Add a `rest_command` to `configuration.yaml`. Keep the token in
`secrets.yaml`, not here.

```yaml
rest_command:
  healthlog_measurement:
    url: "https://healthlog.example.com/api/measurements"
    method: POST
    headers:
      Authorization: !secret healthlog_token
      Content-Type: "application/json"
    payload: >-
      {
        "type": "{{ type }}",
        "value": {{ value }},
        "measuredAt": "{{ now().isoformat() }}"
      }
```

```yaml
# secrets.yaml
healthlog_token: "Bearer hlk_replace_me"
```

Then call it from an automation. This one forwards a scale whenever it reports
a new weight:

```yaml
automation:
  - alias: "Push weight to HealthLog"
    trigger:
      - platform: state
        entity_id: sensor.bathroom_scale_weight
    condition:
      - condition: template
        value_template: "{{ trigger.to_state.state not in ['unknown', 'unavailable'] }}"
    action:
      - service: rest_command.healthlog_measurement
        data:
          type: WEIGHT
          value: "{{ trigger.to_state.state | float }}"
```

The `condition` is not decoration. Home Assistant sensors publish `unknown` and
`unavailable` as ordinary states, and forwarding one produces a 422 on every
restart.

## Measurement types

`type` is an enum, not free text. Some of the ones a Garmin or scale
integration tends to have:

| What the sensor reports        | `type`                   | Unit expected |
| ------------------------------ | ------------------------ | ------------- |
| Weight                         | `WEIGHT`                 | kg            |
| Body fat                       | `BODY_FAT`               | %             |
| Resting heart rate             | `RESTING_HEART_RATE`     | bpm           |
| Heart-rate variability (SDNN)  | `HEART_RATE_VARIABILITY` | ms            |
| Heart-rate variability (RMSSD) | `HRV_RMSSD`              | ms            |
| Blood oxygen                   | `OXYGEN_SATURATION`      | %             |
| VO₂ max                        | `VO2_MAX`                | ml/kg/min     |
| Respiratory rate               | `RESPIRATORY_RATE`       | breaths/min   |
| Sleep duration                 | `SLEEP_DURATION`         | minutes       |
| Steps                          | `ACTIVITY_STEPS`         | count         |
| Body temperature               | `BODY_TEMPERATURE`       | °C            |

Units are derived server-side from the type, so send the number in the unit
above and do not send a `unit` field. The full enum is in
`docs/api/openapi.yaml` under `MeasurementType`.

## Sending several readings at once

A bare array writes up to five readings in one request — the shape to use for
blood pressure, which is two rows:

```bash
curl -X POST https://healthlog.example.com/api/measurements \
  -H "Authorization: Bearer hlk_..." \
  -H "Content-Type: application/json" \
  -d '[
        { "type": "BLOOD_PRESSURE_SYS", "value": 118, "measuredAt": "2026-03-14T07:20:00Z" },
        { "type": "BLOOD_PRESSURE_DIA", "value": 76,  "measuredAt": "2026-03-14T07:20:00Z" }
      ]'
```

For a backfill of hundreds of rows, use `/api/measurements/batch` instead. It
takes up to 500 entries and reports a per-entry status so a partial failure
tells you which rows to retry.

## Retries and duplicates

Send an `Idempotency-Key` header with a value your automation can reproduce for
the same reading. A retry with the same key returns the original response
instead of writing a second row:

```yaml
headers:
  Authorization: !secret healthlog_token
  Content-Type: "application/json"
  Idempotency-Key: "{{ type }}-{{ now().strftime('%Y-%m-%dT%H') }}"
```

Independently of that, a reading with the same type, timestamp and source as an
existing row is refused with a 409 — so a duplicate push is a visible error
rather than a duplicated data point.

## When it stops working

| Response | What it means                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401`    | The token is wrong, revoked, or expired. Mint a new one.                                                                                                        |
| `403`    | The endpoint is outside the token's scope — check you are calling one of the two above and not a read — or the operator has switched the API off instance-wide. |
| `409`    | A reading with this type, timestamp and source already exists.                                                                                                  |
| `422`    | The payload is wrong: an unknown `type`, a non-numeric `value`, an `unavailable` sensor state, or an entry naming `APPLE_HEALTH`.                               |
| `429`    | Too many requests. The batch route allows 60 calls per minute.                                                                                                  |

The response envelope is `{ "data": ..., "error": null }` on success and
`{ "data": null, "error": "<message>" }` on failure, so logging `error` from
the body will usually say exactly what was wrong.
