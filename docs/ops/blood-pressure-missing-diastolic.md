# Blood pressure readings missing their diastolic half

## What happened

The iPhone app (every App Store build up to 1.0.3 and TestFlight 1.1.0)
saves a manually entered blood pressure as two requests to
`POST /api/measurements`: one `BLOOD_PRESSURE_SYS`, one
`BLOOD_PRESSURE_DIA`, both carrying the same `Idempotency-Key`. Until the
replay cache learned to compare request bodies, the server treated the second
request as a retry of the first. It answered with the first request's cached
`201` (header `X-Idempotent-Replay: true`) and never wrote the diastolic
value. The app showed success, so nobody noticed.

The fix makes the cache replay only a request with the same body. A different
body under the same key now runs normally. Nothing recovers the values that
were never sent to the database: they exist only on the person's phone, if at
all.

## Finding the affected readings

Read-only. Run it against the HealthLog database (with the bundled compose
file: `docker compose exec db psql -U healthlog healthlog`). It lists every live systolic reading that has no
live diastolic reading for the same account at the same instant.

<!-- bp-missing-diastolic:start -->

```sql
SELECT u.username,
       m.id,
       m.measured_at,
       m.value AS systolic,
       m.source
FROM measurements m
JOIN users u ON u.id = m.user_id
WHERE m.type = 'BLOOD_PRESSURE_SYS'
  AND m.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM measurements d
    WHERE d.user_id = m.user_id
      AND d.measured_at = m.measured_at
      AND d.type = 'BLOOD_PRESSURE_DIA'
      AND d.deleted_at IS NULL
  )
ORDER BY u.username, m.measured_at;
```

<!-- bp-missing-diastolic:end -->

Readings from the phone app carry `source = 'MANUAL'`. Rows from a synced
source (Withings, Apple Health) that show up here are a different gap, not
this one: those sources write both halves themselves.

## What to tell users

There is nothing the server can repair: the diastolic value never reached
it. A person whose reading appears in the list can re-enter it: delete the
incomplete reading, then add the blood pressure again with both values and
the original date and time. From this release on, both halves are saved on
the first try, from any app version.
