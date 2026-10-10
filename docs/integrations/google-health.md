# Google Health integration (Fitbit + Pixel Watch + Fitbit Air)

HealthLog reads Fitbit, Pixel Watch and Fitbit Air data through the **Google
Health API** (`health.googleapis.com/v4`), the successor to the classic Fitbit
Web API. Google retires the classic Fitbit Web API in **September 2026**, and
Fitbit access/refresh tokens do not carry over — every account re-consents
through Google OAuth. This integration is that path.

The OAuth app is a **Google Cloud** OAuth client, not a Fitbit developer-console
app. Credentials are brought **per user**: each user registers their own Google
Cloud OAuth client and pastes the client id/secret into Settings. The internal
integration key is `google-health`; it runs alongside the classic `fitbit`
integration without touching it. For the classic connection (a developer app
registered on the Fitbit side), see [fitbit.md](./fitbit.md).

> **Beta.** Field mapping is still being verified against live Google Health
> accounts, so some values may be missing or shift in a later update.

## What you get — and what you don't

Weight, body fat, heart rate, resting heart rate, heart-rate variability, blood
oxygen, respiratory rate, sleep stages, steps, distance, active energy, floors,
VO₂ max and workouts flow in on a periodic pull.

Two honest limits, set by the API itself:

- **Stress and readiness are not available.** The Google Health API exposes no
  stress or daily-readiness data type. Nothing HealthLog can do surfaces them.
- **Skin temperature is a nightly deviation**, not a raw stream — a single
  per-night value rather than a continuous trace.

There is **no webhook** at launch: Google Health syncs on the safety-net cron
pull, the same model as Oura and Polar.

## 1. Create a Google Cloud project and enable the Health API

1. In the **Google Cloud console** (<https://console.cloud.google.com>) create a
   project (or pick an existing one).
2. Under **APIs & Services → Library**, find and **enable the Google Health
   API** for that project.

## 2. Configure the OAuth consent screen — keep it in "Testing"

1. Under **APIs & Services → OAuth consent screen**, configure the screen for
   the project.
2. Leave the publishing status on **Testing**. This is the deliberate choice for
   a self-hoster: a Testing-mode client avoids Google verification and the
   annual third-party CASA security assessment entirely.
3. On the **Audience** page, add every account that will connect as a **test
   user** (**+ Add users**). An unverified client is capped at **100 users** —
   staying at or below that ceiling keeps you verification-free.

The cost of staying in Testing is the **7-day refresh-token expiry** — see the
caveat at the end. Going past 100 users, or publishing the client, requires
Google Trust & Safety verification **plus an annual CASA assessment**, because
every Google Health scope is Restricted.

## 3. Create a "Web Server" OAuth client

1. Under **APIs & Services → Credentials**, create an **OAuth 2.0 Client ID** of
   type **Web application** (a "Web Server" client).
2. **Authorized redirect URI:**
   `https://your-instance.example.com/api/google-health/callback`
   Use your instance's real origin; the path is always
   `/api/google-health/callback`.
3. Save. Google issues a **Client ID** and **Client Secret** — keep the secret
   out of any chat log.

HealthLog drives the standard Google OAuth 2.0 web-server flow: it sends the
browser to the authorization endpoint
`https://accounts.google.com/o/oauth2/v2/auth` (with `access_type=offline`,
`prompt=consent` and an S256 PKCE challenge), then exchanges the returned code at
the token endpoint `https://oauth2.googleapis.com/token`.

## 4. Scopes

HealthLog requests exactly these four read-only **Restricted** scopes:

```
https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly
https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly
https://www.googleapis.com/auth/googlehealth.sleep.readonly
https://www.googleapis.com/auth/googlehealth.profile.readonly
```

No write scopes are requested — the connection is read-only. These four core
scopes are the full set the client requests today.

ECG and irregular-rhythm notifications (the Pixel Watch clinical data types) are
a **planned** future addition, not a current option — there is no reader for them
yet, so no scope is requested for either. When that support lands the runbook
will document how to opt in; until then leave them out of your OAuth client.

## 5. Wire the credentials in Settings → Integrations

Credentials are stored per user, not in `.env`. Sign in as the target user, open
**Settings → Integrations → Google Health**, and paste the Client ID and Client
Secret. They are encrypted AES-256-GCM at rest.

## 6. Connect

Click **Connect with Google**. HealthLog redirects to Google's consent screen,
exchanges the returned code for an access + refresh token, stores them encrypted,
and runs an initial backfill in the background.

## Redirect URI is validated strictly

The resolved `redirect_uri` is asserted at connect time to be absolute, `https`
(or `http` on localhost), to target exactly `/api/google-health/callback`, and —
when `GOOGLE_HEALTH_REDIRECT_URI` is set alongside `NEXT_PUBLIC_APP_URL` — to
share its origin. A misconfigured value fails closed rather than redirecting
elsewhere.

## Optional instance env var

```env
# Only when the callback origin differs from NEXT_PUBLIC_APP_URL:
GOOGLE_HEALTH_REDIRECT_URI="https://your-instance.example.com/api/google-health/callback"
```

The Google Cloud client id/secret are per-user (Settings), not env vars.

## Backfill, the hourly sync and Google's rate limit

Only one sync runs per account at a time. While the history backfill that
follows a connect is running, the hourly sync leaves that account alone, and
**Sync now** reports that a sync is already in progress and shows its progress
instead of starting a second one.

Google limits how many requests one account may make per minute. When a sync
reaches that limit, Google answers `429`, and HealthLog waits and repeats the
request; the connection is never marked as needing a reconnect because of it.
Access tokens last an hour, and a long backfill renews its token as it goes.
A backfill that stops part-way (a restart, the job's time budget) picks up
with the data types it has not finished yet on its next attempt.

If an older version left your Google Health card asking for a reconnect after
a backfill, the first sync after updating checks the stored grant and resumes
on its own when the grant is still valid.

## The 7-day re-consent caveat

While the OAuth consent screen stays in **Testing** publishing mode, Google
**expires the refresh token after 7 days**. When that happens the sync stops with
a soft "needs reconnect" state rather than a hard error, and the Google Health
card shows a **Reconnect** banner. Click it, complete the Google consent once
more, and syncing resumes. This is the price of avoiding CASA — it is expected,
not a bug. (Publishing the client past verification removes the 7-day expiry but
triggers the verification + CASA requirements above.)

## Source overlap

If Google Health and another source (Withings, WHOOP, Apple Health) both supply
the same vital — resting heart rate, blood oxygen, respiratory rate — the source
priority ladder in **Settings → Sources** decides which one wins
per metric.

## Disconnect

The Settings **Disconnect** button removes the connection and its stored tokens.
Previously synced measurements stay in the database.

## Garmin owners

Garmin has no direct connector for a self-hosted instance. Since Garmin Connect
5.14.1 (July 2025) the app writes to Google Health Connect, so this integration
is how Garmin data reaches HealthLog on Android. See [garmin.md](./garmin.md) for
what comes through and what Garmin withholds.
