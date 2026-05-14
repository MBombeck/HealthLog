# Phase W17a — Withings webhook secret hardening

**Status:** complete
**Branch:** develop
**Commit:** TBD on completion
**W10 finding addressed:** Security M-2 — Withings webhook secret travels via URL query parameter

---

## Investigation

### What Withings actually supports

The Withings `Notify.subscribe` API accepts exactly six parameters:
`action`, `callbackurl`, `appli`, `client_id`, `nonce`, `signature`
(plus optional `comment`). There is **no facility for custom HTTP
headers** and **Withings does not sign outgoing webhook bodies**.

Inbound webhook deliveries are `POST application/x-www-form-urlencoded`
with payload `userid` / `appli` / `startdate` / `enddate`, and no
Withings-supplied authenticity header (no `X-Withings-Signature`,
nothing equivalent). The subscriber's only authenticity surface is the
`callbackurl` itself.

The W10 security review's suggestion to "move the secret to the
`X-Withings-Webhook-Secret` header at subscribe time" was based on an
inaccurate claim that Withings supports a `headers` object on
subscribe — confirmed false against the public docs
(`developer.withings.com/developer-guide/v3/data-api/notifications/notification-subscribe/`,
`developer.withings.com/developer-guide/v3/data-api/notifications/notification-content/`).

### Chosen pattern

**Path-segment binding.**
`?secret=<value>` → `/<value>` in the URL path.

This is the largest practical shift away from query-string logging
that Withings supports end-to-end:

- Most reverse proxies (nginx, Caddy, Coolify default config) log
  `request_uri` AND a separate `query_string` column; moving the
  secret out of the query string keeps it off the field every default
  access-log template captures.
- GlitchTip URL/breadcrumb capture is already scrubbed of `?…` in
  `reportToGlitchtip` (`src/lib/api-handler.ts:394-403`), but that
  scrubber operates on `searchParams`; path segments would survive it,
  which means we need to apply matching path-segment redaction at the
  proxy in production. The redaction rule is a single
  regex (`/api/withings/webhook/<token> → /api/withings/webhook/_`),
  much narrower than the multiplicity of query-string secrets we'd
  otherwise need to spell out.
- The path-segment value is constant-time-compared against
  `WITHINGS_WEBHOOK_SECRET` server-side. Rotating the secret rotates
  every subscription's URL on the next `setupWebhook` call, which
  fires whenever a user re-OAuths (organic during v1.4.25 thanks to
  W5d's `user.activity` scope upgrade).

Header-based auth was rejected because Withings will not propagate any
header we configure — they ignore unknown subscribe parameters
silently, so a `headers` shim would only authorise manual replay tests
(which the legacy route already covers via
`X-Withings-Webhook-Secret`).

HMAC signature verification was rejected because Withings does not
sign the payload — there's no shared signature for us to verify.

## Implementation

### New files

- `src/app/api/withings/webhook/[token]/route.ts` —
  path-segment Withings webhook route. POST / HEAD / GET, each
  rate-limited and gated on a `timingSafeEqual` comparison between the
  dynamic `[token]` segment and `process.env.WITHINGS_WEBHOOK_SECRET`.
- `src/lib/withings/webhook-handler.ts` — extracted shared body
  processing (rate limit, form/JSON body decode, user lookup,
  fire-and-forget sync). Used by both the new route and the legacy
  one so the migration window doesn't drift between the two surfaces.
- `src/app/api/withings/webhook/[token]/__tests__/route.test.ts` —
  8 tests: valid token / wrong token / empty token / unset env / prefix-
  match-rejection / rate-limited / HEAD verify / GET verify.
- `src/lib/withings/__tests__/sync.test.ts` — 3 tests confirming
  `getWithingsWebhookCallbackUrl()` returns the path form, encodes
  unsafe characters, and falls back gracefully without a secret.

### Modified files

- `src/lib/withings/sync.ts` — `getWithingsWebhookCallbackUrl()` now
  emits `…/api/withings/webhook/<encoded-secret>` instead of
  `…/api/withings/webhook?secret=<secret>`. New `setupWebhook` calls
  hand the path-segment URL to Withings; the legacy form is no longer
  generated anywhere in the codebase.
- `src/app/api/withings/webhook/route.ts` — refactored over the
  shared helper. Legacy semantics preserved: query-string secret still
  authorises (with a `getEvent().addWarning(…)` deprecation breadcrumb),
  header secret still authorises (manual-replay path). Documented
  removal target: **v1.4.27**, by which time every active Withings
  subscription should have rotated through `setupWebhook` thanks to
  the v1.4.25 OAuth-scope reconnect banner.

### Backward compatibility

Two-stage migration:

1. **v1.4.25 (this release):** new subscriptions go via the path-
   segment URL. Existing Withings subscriptions still target the
   legacy `/api/withings/webhook?secret=…` URL — they keep working,
   each delivery now emits a "migrate to /api/withings/webhook/[token]"
   warning to the Wide Event stream.
2. **v1.4.26 — v1.4.27:** every active user reconnects at least once
   thanks to W5d's scope upgrade. On reconnect, `setupWebhook`
   re-subscribes against the path-segment URL.
3. **v1.4.27:** delete the legacy route. The deprecation-breadcrumb
   count in monitoring is the gating signal.

`getWithingsWebhookCallbackUrl()` is the single point of truth for the
URL handed to both `subscribeWebhook` (on connect) and
`unsubscribeWebhook` (on disconnect). The disconnect path uses the
**current** URL form, which is correct: Withings keys subscription
records by the exact callback URL, so a stale subscription created
under the legacy URL stays attached to the legacy URL — that
mismatch is harmless because the disconnect call wraps each appli
unsubscribe in `try { … } catch {}` already.

## Quality gates

| Gate            | Result                            |
|-----------------|-----------------------------------|
| `pnpm typecheck`| pass                              |
| `pnpm lint`     | pass                              |
| `pnpm test`     | 4 files / 56 tests withings scope; 2665 / 1 skipped full suite |

## Follow-ups

- **Coolify/Caddy redaction rule (operational, not code):** add a
  log-format rewrite that masks the final segment of
  `/api/withings/webhook/<token>` before access lines leave the
  edge. Without this, the path-segment secret still appears in the
  request line — the change above stops it from landing in the
  separate `query_string` field, which was the bulk of the W10
  finding, but full defence-in-depth requires the proxy rule. Tracked
  as a v1.4.25 W17a-op follow-up.
- **v1.4.27 cleanup:** delete the legacy `/api/withings/webhook`
  route + its tests + the deprecation breadcrumb. Confirm
  monitoring shows zero `auth_method=webhook_secret` events on the
  legacy route over the prior 7 days before removal.
