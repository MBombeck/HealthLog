# Strava integration

HealthLog reads your Strava activities and folds them into the same workout
history as every other source. Strava is a **workout source only** — its API is
activity-centric and exposes no sleep, recovery, body-composition or glucose
data, so connecting it adds runs, rides, swims and the rest to your workout
surface and nothing else.

The OAuth app is brought **per user**: each self-hoster registers their own
Strava API application and pastes the client id/secret into Settings. Strava
caps every newly-created app at "single-player mode" (an athlete capacity of 1)
until you request a capacity increase — perfectly fine for a personal
self-host, and the reason a single shared app cannot serve many operators.

## What you get — and what you don't

**Covered** (one `Workout` row per activity): sport type, start and end time,
moving duration, distance, elevation gain, average and maximum heart rate (when
the activity recorded it), and calories. Power, cadence, the "trainer"/"commute"
flags and the activity name are kept on the row's metadata for provenance but
are **not** surfaced as training analytics — HealthLog treats Strava as another
workout source, not a training-load platform.

**Not covered**: Strava exposes no daily metrics (steps, sleep, resting heart
rate, weight, …). Those come from your wearable's own integration or from Apple
Health / Google Health Connect.

## Duplicate activities are collapsed automatically

If you record a run on an Apple Watch **and** it also lands in Strava, the same
run arrives twice — once via Apple Health, once via Strava. HealthLog keeps one
canonical row per logical workout using your **source-priority ladder**: by
default the device-native capture (Apple Watch, WHOOP, Withings) wins over the
Strava copy, because a Strava activity is often a re-upload with lower-fidelity
or missing heart-rate data. A run you record **only** on Strava (phone GPS)
survives untouched. You can promote Strava above the wearables in
**Settings → Source priority** if you prefer the Strava copy.

## 1. Register a Strava API application

1. Sign in at <https://www.strava.com/settings/api>.
2. Create an application. For **Authorization Callback Domain** enter the host
   of your HealthLog instance (the domain only, no scheme or path).
3. Copy the **Client ID** and **Client Secret**.

## 2. Paste the credentials into HealthLog

1. Open **Settings → Integrations** and find the **Strava** card.
2. Paste the Client ID and Client Secret into the **API Credentials** fields and
   save. (An operator can instead configure a shared app via the
   `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` environment variables; per-user
   credentials always take precedence.)
3. Click **Connect Strava** and approve the access request. HealthLog requests
   the `activity:read_all` scope so it can read every activity, including those
   you marked "only me".

## 3. First sync

The first history import runs in the background shortly after you connect;
afterwards an hourly poll pulls new activities. Strava rotates its refresh token
on every refresh, and HealthLog persists the rotated token each time, so the
connection stays healthy without you re-authorising.

## Disconnecting

Disconnecting revokes the grant at Strava and clears the stored tokens.
Activities already imported stay in your history; reconnecting resumes the sync.

## Related

- Wearable that syncs to Strava but not directly to HealthLog? See the device's
  own page, or ingest via [Apple Health](./apple-health.md) /
  [Google Health Connect](./google-health.md).
- **Garmin owners:** Garmin has no direct connector — see [garmin.md](./garmin.md).
