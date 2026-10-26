# Fitbit integration (Fitbit & Pixel)

> **Experimental.** Field mapping is still being verified against live accounts,
> so some values may be missing or change in a future update.

HealthLog reads Fitbit and Pixel Watch data through the **classic Fitbit Web
API** (`api.fitbit.com`). The OAuth app is a **Fitbit developer app registered
at [dev.fitbit.com](https://dev.fitbit.com/)** — **not** a Google Cloud
OAuth client. Like WHOOP, credentials are brought per user: each user (or the
operator on their behalf) supplies their own Fitbit app's client id/secret in
Settings. The internal integration key is `fitbit`.

> **Common mistake:** the field wants a **Fitbit** Client ID (a short numeric
> id from dev.fitbit.com), **not** a Google Cloud client id ending in
> `.apps.googleusercontent.com`. A Google Cloud client fails at the Fitbit
> consent screen with `unauthorized_client — Invalid client_id`, because Fitbit
> and Google Cloud are separate client registries.

> **The classic Fitbit Web API is turned off on 30 October 2026.** Google
> ended support for it on 30 September 2026 and turns it off on
> **30 October 2026**, after which it "will no longer function or sync data"
> ([Google's migration guide](https://developers.google.com/health/migration)).
> New app registrations at `dev.fitbit.com/apps/new` are already closed.
>
> From that day HealthLog stops calling the Web API for every Fitbit
> connection: no hourly sync, no backfill, no token refresh, and no new
> connection. Nothing is deleted. The connection and every reading it imported
> stay, and the Fitbit card explains the move instead of asking for a
> reconnect. To keep Fitbit and Pixel data coming, connect the
> [Google Health integration](google-health.md). It reads the same devices,
> but Google asks for consent once more: Fitbit tokens cannot be carried over.
>
> Both integrations can run side by side while you move. Where both deliver the
> same day, the source-priority ladder keeps one of them per day (Fitbit ranks
> just above Google Health by default), so steps, sleep and the other daily
> values are not counted twice. After the turndown only Google Health delivers.

## 1. Use an existing Fitbit developer app

Registration of new apps is no longer possible (see the note above). For an
app you registered before the shutdown, these are the settings that matter:

1. **OAuth 2.0 Application Type:**
   - **Personal** — the app only ever sees the **owner's own** Fitbit account,
     and gets intraday (per-minute) heart-rate/steps automatically. This is the
     right choice for a single-person self-host.
   - **Server** (or **Client**) — needed when the instance connects **other
     people's** accounts. Intraday/heart-rate access is then granted case by
     case via Fitbit's Intraday Data Access request form.
2. **Callback URL:** `https://your-instance.example.com/api/fitbit/callback`
   — absolute, **HTTPS**, and matching the `redirect_uri` HealthLog sends (see
   the redirect-URI note below). One entry per environment you connect from.
3. **Scopes:** the ones HealthLog requests (next section).
4. The app's settings page shows the **Client ID** (short, numeric) and the
   **Client Secret** — keep the secret out of any chat log.

## 2. Scopes

HealthLog requests exactly these read scopes (space-separated on the wire):

```
activity cardio_fitness heartrate oxygen_saturation profile respiratory_rate sleep weight
```

The `temperature` scope is intentionally omitted — the classic skin-temperature
reading is a baseline delta rather than an absolute value, so it has no honest
canonical slot yet. The authorization uses the Authorization Code Grant **with
PKCE (S256)**, which Fitbit recommends; HealthLog mints the `code_verifier`
server-side and never exposes it to the browser.

## 3. Wire the credentials in Settings → Integrations

Credentials are stored per user, not in `.env`. Sign in as the target user, open
**Settings → Integrations → Fitbit**, and paste the Client ID and Client Secret.
They are encrypted AES-256-GCM at rest.

## 4. Connect

Click **Connect with Fitbit**. HealthLog redirects to the Fitbit consent screen
(`www.fitbit.com/oauth2/authorize`), exchanges the returned code for an access +
refresh token at `api.fitbit.com/oauth2/token`, stores them encrypted, and runs
an initial sync. There is **no webhook** — Fitbit syncs on the safety-net cron
pull. Classic Fitbit refresh tokens rotate (one-time use); HealthLog replaces the
stored token on every refresh.

## Redirect URI is validated strictly

The resolved `redirect_uri` is asserted at connect time to be absolute, `https`
(or `http` on localhost), to target exactly `/api/fitbit/callback`, and — when
`FITBIT_REDIRECT_URI` is set alongside `NEXT_PUBLIC_APP_URL` — to share its
origin. A misconfigured value fails closed rather than redirecting elsewhere.

## Optional instance env var

```env
# Only when the callback origin differs from NEXT_PUBLIC_APP_URL:
FITBIT_REDIRECT_URI="https://your-instance.example.com/api/fitbit/callback"
```

The Fitbit client id/secret are per-user (Settings), not env vars.

## Source overlap

If Fitbit and another source (Withings, WHOOP, Apple Health) both supply the same
vital — resting heart rate, blood oxygen, body temperature or respiratory rate —
the source priority ladder in **Settings → Source priority** decides which one wins
per metric. FITBIT is ranked in every default metric ladder; override
per metric on that page.

## Disconnect

The Settings **Disconnect** button revokes the stored tokens and removes the
connection. Previously synced measurements stay in the database.
