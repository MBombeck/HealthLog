# WHOOP integration

HealthLog connects to WHOOP via OAuth2 plus HMAC-signed webhooks for
near-real-time sync of recovery, strain, sleep, and the underlying
heart-rate / HRV signals. Unlike Withings, WHOOP credentials are
brought per user: each user (or the operator on their behalf)
registers their own WHOOP developer app and pastes the client
id/secret into Settings.

## Why bring your own keys

WHOOP caps the number of users a single developer app may authorise.
Per-user BYO-keys sidestep that per-app cap: every user authorises
against their own WHOOP app, so a shared HealthLog instance never
runs into one app's user ceiling. It also keeps each user's WHOOP
grant scoped to credentials they control.

## 1. Register a WHOOP developer app

1. Sign in at <https://developer.whoop.com/> and create a new app.
2. **Redirect URI:** `https://your-instance.example.com/api/whoop/callback`
   (matches `WHOOP_REDIRECT_URI`, below). Add one entry per
   environment you connect from.
3. Request these scopes (the exact set HealthLog asks for):

   ```
   offline read:recovery read:sleep read:workout read:cycles read:profile read:body_measurement
   ```

   `offline` is **mandatory** — without it WHOOP issues no refresh token
   and the connection dies when the first access token expires (~1 hour).
   The remaining `read:*` scopes are read-only; request all of them so the
   user grants once and every sync resource is covered.

4. Save the app. WHOOP issues a **Client ID** and **Client Secret** —
   keep the secret out of any chat log; it grants read access to the
   linked account's full WHOOP history.

## 2. Wire the credentials in Settings > Integrations

WHOOP credentials are stored per user, not in `.env`. Sign in as the
target user, open **Settings > Integrations > WHOOP**, and paste the
client ID and secret. They are encrypted AES-256-GCM at rest.

## 3. Connect

Click **Connect WHOOP**. The flow:

1. The Connect button redirects to WHOOP's OAuth authorize endpoint.
2. The user signs in on WHOOP and grants the requested scopes.
3. WHOOP redirects back to `/api/whoop/callback` with an auth code.
4. HealthLog exchanges the code for an access + refresh token, stores
   them encrypted, and triggers an initial sync of recent history.
   (The webhook is **not** registered per user — it is configured once
   at app level in the WHOOP developer console; see the env-var
   section below.)
5. Subsequent syncs run on every webhook delivery plus a safety-net
   cron pull.

## Optional instance env vars

Two server-level env vars tune the OAuth callback and webhook
verification. They are optional — the per-user client id/secret in
Settings drive the connection itself.

```env
WHOOP_REDIRECT_URI="https://your-instance.example.com/api/whoop/callback"
WHOOP_WEBHOOK_SECRET="$(openssl rand -hex 32)"
```

- `WHOOP_REDIRECT_URI` — the OAuth callback URL handed to WHOOP. Must
  match a redirect URI registered in the WHOOP developer app.
- `WHOOP_WEBHOOK_SECRET` — used twice: as the **trailing path segment**
  of the webhook URL you register in the WHOOP console, and as the key
  HealthLog verifies the WHOOP HMAC body signature against. Set the
  webhook URL in the WHOOP console to:

  ```
  https://your-instance.example.com/api/whoop/webhook/<WHOOP_WEBHOOK_SECRET>
  ```

  WHOOP signs each body (`X-WHOOP-Signature` + `X-WHOOP-Signature-Timestamp`,
  HMAC-SHA256); the handler rejects deliveries older than five minutes and
  validates the signature before processing. The body signing key on WHOOP's
  side must equal `WHOOP_WEBHOOK_SECRET`. Generate a fresh random value and
  restart the `app` container after setting it. Without a webhook, WHOOP
  still syncs on the safety-net cron pull — only the near-real-time push is
  lost.

## Disconnect

The Settings page **Disconnect** button revokes the stored tokens and
removes the connection. Existing measurements synced from WHOOP stay
in the database — disconnect does not delete data.
