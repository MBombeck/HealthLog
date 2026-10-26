# Google Health integration (Fitbit + Pixel Watch + Fitbit Air)

HealthLog reads Fitbit, Pixel Watch and Fitbit Air data through the **Google
Health API** (`health.googleapis.com/v4`), the successor to the classic Fitbit
Web API. Google ended support for the classic Fitbit Web API on 30 September
2026 and turns it off on **30 October 2026**
([migration guide](https://developers.google.com/health/migration)); from that
day HealthLog's `fitbit` connection stops syncing and keeps what it imported.
Fitbit access/refresh tokens do not carry over, so every account consents once
more through Google OAuth. This integration is that path.

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

Only one sync runs per account at a time. **Sync now** reports that a sync is
already in progress while the history backfill that follows a connect is
running, and shows its progress instead of starting a second one.

The backfill reads the account's whole history. Heart rate is by far the
largest part: a page holds up to 1,000 readings, so a watch that records once
a minute fills some 525 pages a year, and one that records every few seconds
(as many Pixel and Fitbit watches do during the day) several thousand; one
account measured about 4,100 pages a year. It runs in
slices: a slice reads for up to five minutes or 500 pages, writes what it
read, notes how far it got and lets go of the account. The next slice starts
a minute later where the last one stopped. Two kinds of note are kept: a data
type read to the end is not read again, and a data type read page by page
(heart rate, weight, body fat, blood glucose, core temperature) keeps the
time of the oldest reading it has written, so the next slice asks Google only
for what is older. A restart or an update in the middle loses at most the page
that was being read.

Asking for "what is older" uses an upper bound on the sample time, which
Google's filter grammar allows but which a given account may still refuse. If
Google answers that first resumed request with `400`, the slice reads the data
type again without the bound, passes over the readings newer than its note
without writing them, and carries on writing from there. The refusal is noted
per data type, so later slices read without the bound straight away. The pages
passed over are not counted against the slice's 500 pages, but they do run on
its five minutes, and passing over stops after three minutes at most, so a
slice never holds the account longer than a slice. Wherever the walk stops, on
a limit or on a rate limit, it keeps Google's page token for the page it read
last, and the next slice reads that one page again and goes on from there
instead of passing over everything earlier slices wrote: the pages read stay
in proportion to the history. If Google no longer takes the token, or the page
it returns no longer reaches the noted reading, the slice starts again from the
newest page and passes over as before. A `400` that names something else (the
page size, or the page token of a walk that did not start from a kept one) is
still a failure.

The hourly sync waits for the slice that is running (up to eight minutes)
instead of skipping the account, so recent data keeps arriving while an old
history is still coming in. The hourly job stays inside its own fifteen-minute
limit: the wait is cut short when the job's time runs low, the sync after it
gets only what is left and leaves the rest of its window to the next hour, and
an account the job reaches after its time is up waits for the next hour.

Google limits how many requests one account may make per minute. When a sync
reaches that limit Google answers `429`, and HealthLog waits and repeats the
request. If Google asks for a longer wait than a minute, the slice ends there
and the next one starts five minutes later. A server error (`500`, `502`,
`503`, `504`), a request that times out and a dropped connection are repeated
three times before they count as a failure. None of these mark the connection
as needing a reconnect. Access tokens last an hour, and a long backfill renews
its token as it goes.

### How far back the backfill reads

The backfill is not bounded by a number of pages, because how many pages a
year of history fills depends on the device. Two bounds apply instead:

- **The horizon.** It reads back at most 20 years. Set
  `GOOGLE_HEALTH_BACKFILL_HORIZON_YEARS` to a whole number from 1 to 100 to
  change that (it is on the compose `environment:` list; any other value
  falls back to 20). A data type whose history goes back further is imported
  up to the horizon and ends there.
- **Progress.** A walk has to reach older readings as it goes. If Google
  hands out 20 pages in a row that reach no further back than the ones before
  them (the same page again, or a page token that goes round in a circle),
  the walk stops where it got to. A passing fault in Google's paging looks
  the same as the end of what it holds, so the first time this happens the
  data type only waits: it keeps its place, the rest of the backfill goes
  on, and a day later it is walked again from there. If that second attempt
  also stops without getting anywhere, the data type's history ends at the
  oldest reading written so far. If it moves on, it is an ordinary walk
  again. A walk that stops before it has written a single reading notes no
  end at all (there is no date it could be said to end at); the slice fails
  as stuck and is retried like any other. A reconnect starts the backfill
  over.

Either way the data type counts as finished once its end is final, the
backfill completes once every other type is in, and the integration card
stops saying that older history is loading. Instead it says, per data type,
how far back the import reaches and why it ends there. While a type waits
for its second attempt the backfill is not complete, and the card still
says older history is loading.

Before 1.43.6 every page-by-page data type had a ceiling of pages counted
across all slices (10,000 for heart rate, 1,000 for the others). A dense
heart-rate history reaches 10,000 pages two to three years back, the count
never reset, and from then on every slice stopped at the same place without
the backfill ever completing. A backfill left in that state continues from
where it stopped with the first slice after the update.

A slice that moved nothing forward (no data type finished, no reading older
than before) is a real failure: the job fails with the reason, pg-boss retries
it a few times, and after that the next restart offers the backfill again.
Everything already written stays.

If an older version left your Google Health card asking for a reconnect after
a backfill, the first sync after updating checks the stored grant and resumes
on its own when the grant is still valid.

### Reading the backfill in the logs

Every slice writes one log line when it ends, with
`"background":{"task_name":"job.integration_backfill"}`. The parts worth
reading:

- `meta.kind` is `google-health-backfill`, `meta.slice` the slice number
  (0 for the first), `meta.job_id` the pg-boss job.
- `external_calls` lists the requests the slice made to Google, one entry per
  request: `method` names the data type and page (`fetchHeartRate(page=212)`),
  `status` the HTTP status, `duration_ms` how long it took. A request that was
  repeated carries a `note` (`rate_limited_retrying_in_ms=4000`,
  `server_error_retrying_in_ms=2000`, `no_response_retrying_in_ms=2000`,
  `token_rejected_retrying_with_fresh_token`,
  `edge_filter_rejected_reading_without_it`); one that failed for good
  carries an `error`. Successful requests are listed up to 60 per line and
  everything up to 200; `external_calls_omitted` counts the rest.
- `meta["googleHealth.backfill.slice"]` sums the slice up:
  - `pages`, `elapsedMs` and `imported`: what the slice read, how long it
    took, how many readings it wrote. `skippedPages` is the part of `pages`
    read only to pass over readings already written, on a data type whose
    upper-bound filter Google refused.
  - `stopReason`: why it ended early. `time_budget` and `page_budget` are the
    normal end of a slice, `rate_limited` means Google would not take more
    requests for now, `job_budget` that the job itself ran out of time,
    `lane_wanted` that the slice made room for another heavy job (a nightly
    run, a backup, an upload) that was waiting; the next slice starts two
    minutes later. `null` means the slice read everything it started.
  - `collectionsDone` of `collectionsTotal`: data types read to the end so
    far.
  - `collections`: one entry per data type the slice touched, with its
    `status` (`done`, `stopped` short on a budget or a rate limit,
    `deferred` to the next slice, or `failed`), its `pages`, and for the
    page-by-page types
    `edgeFrom` and `edgeTo`, the oldest reading written before and after the
    slice.
  - `edges`: where every unfinished page-by-page data type stands now.
  - `ended`: data types whose history ended short of its beginning, each
    with its measurement `type`, the instant it ends at (`at`) and the
    `reason` (`horizon` or `no_progress`). A `no_progress` entry also
    carries `attempts` and `endedAt`; with one attempt it is waiting for
    its second, a day after `endedAt`, and is not yet published.
- `action: google_health.backfill.retry_scheduled` marks a slice that found
  nothing left but a data type waiting for its second attempt and queued the
  next slice for when it is due (`delaySeconds`).
- `meta["googleHealth.backfill.ended"]` appears on the slice where a data
  type ended short: the `collection`, its measurement `type`, the `reason`,
  whether the end is `final`, how many data types have ended short so far
  (`endedCount`) and of those for good (`finalCount`), and their `types`.
  The full entries are in the slice report's `ended`. A walk stopped for lack of
  progress also leaves a warning:
  `fetchHeartRate: 20 pages in a row reached no further back than <instant>`.
- `meta["googleHealth.backfill.edgeFilterUnsupported"]` appears on the slice
  where Google refused the upper-bound filter, listing the data types noted
  as refusing it.
- `action.name` is `google_health.backfill.continued` for a slice that made
  progress and queued the next one, `google_health.backfill.complete` for the
  one that finished the history, and `google_health.backfill.stuck` for one
  that moved nothing. A stuck slice also fails the job with a message that
  names each unfinished data type and its status, for example
  `no progress in slice 4, stopped on rate_limited; fetchHeartRate:stopped`.

While a slice runs, the usual `job.progress` line for the
`integration-backfill-admission` queue reports
`google_health_backfill_slice`, `google_health_backfill_pages` and
`google_health_backfill_collections_done` every two minutes.

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
priority ladder in **Settings → Source priority** decides which one wins
per metric.

## Disconnect

The Settings **Disconnect** button removes the connection and its stored tokens.
Previously synced measurements stay in the database.

## Garmin owners

Garmin has no direct connector for a self-hosted instance. Since Garmin Connect
5.14.1 (July 2025) the app writes to Google Health Connect, so this integration
is how Garmin data reaches HealthLog on Android. See [garmin.md](./garmin.md) for
what comes through and what Garmin withholds.
