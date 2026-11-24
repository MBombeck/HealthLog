# Authentication and sessions

Every way into a HealthLog account, how strong each one is, what stops
guessing, how long a sign-in lasts, and the rules for the first account and
for second factors. Values are as of 1.50.0. The structural tests named in the
last column fail the build when a pathway is added or widened without being
listed.

## Pathways

"Step-up" means the pathway can satisfy the fresh-factor gates that guard
destructive actions ([Step-up](#step-up)). Per-IP limits are per 15 minutes
unless stated.

| Pathway                                                                                    | Factors                                                                                                                                                           | Limits                                                                                        | Step-up                                    | Frozen by                                |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------- |
| Password (`POST /api/auth/login`)                                                          | password, then the second factor when one is enrolled                                                                                                             | 5 per IP; per-account backoff ([below](#guessing-and-credential-stuffing))                    | password: first factor only                | `auth-guards-entry-guard.test.ts`        |
| Passkey (`/api/auth/passkey/login-*`)                                                      | possession plus user verification (required); counts as two factors                                                                                               | 10 per IP                                                                                     | yes                                        | `auth-guards-entry-guard.test.ts`        |
| TOTP (`/api/auth/mfa/verify`)                                                              | second factor after the password; 6 digits, 30 s, replays refused                                                                                                 | 10 per IP; 5 attempts per sign-in ticket, then the ticket is burned; ticket lives 5 minutes   | yes                                        |                                          |
| Security key (`/api/auth/mfa/webauthn/*`)                                                  | second factor after the password                                                                                                                                  | as TOTP                                                                                       | yes                                        |                                          |
| Recovery code (`/api/auth/mfa/verify`)                                                     | replaces the second factor once; each code is single use                                                                                                          | as TOTP                                                                                       | no                                         |                                          |
| Trusted device (cookie, 30 days)                                                           | skips the second factor on a browser that completed it before; the password is still required                                                                     | as password                                                                                   | never                                      |                                          |
| SSO, web (`/api/auth/oidc/*`)                                                              | whatever the identity provider checked; HealthLog's own second factor too when enrolled                                                                           | login 10, callback 20 per IP                                                                  | no; an SSO sign-in is one delegated factor | `session-surface-guard.test.ts`          |
| SSO, native (`GET /api/auth/oidc/login?client=native`, `POST /api/auth/oidc/native/token`) | as SSO web, then a one-time `hlh_` code bound to the app's PKCE verifier                                                                                          | 10 per IP; code lives 90 seconds                                                              | no (Bearer)                                | `session-surface-guard.test.ts`          |
| Native web hand-off (`/api/auth/native/login`, `/complete`, `/token`)                      | the web sign-in above, inside the app's browser sheet, then a PKCE-bound one-time code                                                                            | 10, 20, 10 per IP; the session must be newer than the hand-off start                          | no (Bearer)                                | `session-surface-guard.test.ts`          |
| Native password or passkey (`POST /api/auth/login` from the app)                           | as password or passkey; returns a 1-day access token and a refresh token                                                                                          | as password                                                                                   | no (Bearer)                                |                                          |
| Refresh (`POST /api/auth/refresh`)                                                         | the refresh token; one-time use, reuse revokes the device's token family                                                                                          | 10 per IP                                                                                     | no                                         |                                          |
| Personal API tokens (`hlk_`)                                                               | the token; minted behind a recent proof, each with one narrow scope: `measurements:write`, `workouts:write`, `documents:write`, or the per-medication ingest pair | per-route limits; at most 10 live tokens per kind                                             | never                                      | `bearer-scope-enforcement-guard.test.ts` |
| MCP connector                                                                              | an OAuth connection (PKCE S256, consent in a signed-in browser) or a token minted in Settings; scope `health:read`, optionally `health:write`                     | 120 requests a minute, 60 writes per 5 minutes per credential; authorize 60, token 120 per IP | never                                      | `bearer-scope-enforcement-guard.test.ts` |
| Invite (`hlv_`)                                                                            | admits a registration while registration is closed; use-limited, expiring                                                                                         | as registration                                                                               | n/a                                        | `session-surface-guard.test.ts`          |
| Managed-profile handover (`hlp_`)                                                          | lets a person claim the record kept for them, by password or SSO                                                                                                  | 5 claims, 20 previews per IP                                                                  | n/a                                        | `session-surface-guard.test.ts`          |
| Registration (`POST /api/auth/register`)                                                   | creates an account; the first one needs the setup token ([below](#first-account))                                                                                 | 5 per IP                                                                                      | n/a                                        |                                          |
| Admin password reset                                                                       | an admin sets a password for another account; revokes all of that account's sign-ins                                                                              | per admin                                                                                     | n/a                                        |                                          |
| Operator CLI (`scripts/reset-password.mjs`)                                                | host access; [`ops/password-reset.md`](../ops/password-reset.md)                                                                                                  | none (host access)                                                                            | n/a                                        |                                          |

The identity of a native transport is fixed at the server: a 60-day refresh
token is never issued into a browser context (a `Mozilla/` user agent or a
session cookie on the request suppresses it, `src/lib/auth/native-client.ts`),
and the hand-off token endpoints refuse a browser outright.

### URL credentials

A few surfaces authenticate by a value in the URL, because the caller cannot
send a header. The set is frozen by `src/__tests__/session-surface-guard.test.ts`
and `url-credential-miss-guard.test.ts`. Each path segment is removed from logs
(`PATH_SECRET_PATHS`) and every one is rate limited before its lookup.

| Surface                                                       | Credential                                                                                                                       | Reaches                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Clinician share link `/c/<token>`                             | `hls_` link token, optionally plus an 80-bit passphrase (unlock cookie, 30 minutes); expiry at most 90 days                      | the shared selection of one record, read only |
| Emergency card `/e/<token>`                                   | `hlm_` link token; each access is audited on the owner's trail                                                                   | the items frozen into the card                |
| Cycle and care calendar feeds                                 | `hlf_` token                                                                                                                     | dates only                                    |
| Notification quick answer `/api/notifications/action/<token>` | signed token bound to user and answer, 6 hours, single use                                                                       | one mood entry                                |
| Withings and WHOOP webhooks                                   | the instance's webhook secret in the path (WHOOP also signs the body); the legacy `?secret=` form for old Withings subscriptions | a sync of the account named in the payload    |
| Apple Wallet pass web service                                 | `ApplePass` header and the device library id                                                                                     | the pass's registration                       |
| Invite and handover landings                                  | shape check only, then a redirect; nothing is resolved                                                                           | nothing                                       |
| Native return page                                            | carries the one-time code to the app; reads nothing                                                                              | nothing                                       |

## Guessing and credential stuffing

| Control                                         | Value                                                                                                                                                                                                                                                                                                              | Where                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Per-IP limit on every anonymous sign-in surface | the numbers in the table above, a Postgres counter shared by every container                                                                                                                                                                                                                                       | `checkAuthSurfaceRateLimit`, `src/lib/rate-limit.ts`         |
| Broken proxy trust                              | when the forwarded-address chain cannot be trusted, every anonymous caller shares one bucket of 100 per 15 minutes, instead of each getting its own                                                                                                                                                                | `src/lib/rate-limit.ts`                                      |
| Per-account backoff                             | 5 failures a day are free; each further failure doubles the wait, from 30 seconds to at most 15 minutes. A browser holding the account's trusted-device cookie, or an app presenting a device id the account's refresh token was issued to, is neither counted nor slowed, so a guesser cannot lock the owner out. | `src/lib/auth/login-throttle.ts`                             |
| Unknown accounts                                | the same backoff runs on an HMAC of the typed identifier, and an Argon2id verify runs against a dummy hash, so neither the wait nor the timing says whether an account exists; the error body is the same                                                                                                          | `src/lib/auth/login-throttle.ts`, `src/lib/auth/password.ts` |
| Second-factor ticket                            | 5 wrong codes and the ticket is burned; 5 minutes                                                                                                                                                                                                                                                                  | `src/lib/auth/mfa/challenge.ts`                              |
| Re-proof                                        | 5 per account per 15 minutes                                                                                                                                                                                                                                                                                       | `src/lib/auth/existing-factor-proof.ts`                      |
| Password quality                                | at least 12 characters, no composition rules, no maximum; zxcvbn score 3 or better, with the username and e-mail address passed as context words; refused when found in Have I Been Pwned (k-anonymity, fails open when unreachable, `PASSWORD_BREACH_CHECK_DISABLED` turns it off)                                | `src/lib/auth/password.ts`, `src/lib/auth/hibp.ts`           |

The forwarded-address settings that make the per-IP limits mean anything are
the operator's: [`self-hosting/reverse-proxy.md`](../self-hosting/reverse-proxy.md#pre-flight--env-vars-the-proxy-interacts-with).

## First account

On an instance with no account, the first account (by password registration
or by the first SSO sign-in) can only be created with the setup token. It is
`SETUP_TOKEN` from the environment (at least 32 characters, also accepted as
`SETUP_TOKEN_FILE`), or, when that is unset, a token derived from
`API_TOKEN_HMAC_KEY` that the web process prints to its log at every start for
as long as no account exists. Whoever can read the container log or the
environment is already the operator; whoever merely reaches a fresh instance
first is not.

The first account becomes the administrator. From then on the token has no
use, and registration is closed by default. An admin can open it (Admin,
General); invitations work while it is closed.

## Second factors

A second factor is a TOTP authenticator or a security key. A passkey sign-in
counts as two factors on its own (possession plus user verification).

**Policy** (Admin, General):

- **Require two-factor sign-in for administrators**: on by default, existing
  installs included.
- **Require it for everyone**: off by default.
- **Grace period**: 14 days by default, 0 to 90, counted from when a policy took
  effect (for an install upgraded to 1.50.0, from that upgrade).
- **Per account**: an admin can require it for one account; that applies at
  once, without a grace period.

During the grace period the person is prompted after signing in. After it, a
web session of an account without a second factor is confined on the server
to enrolling one and signing out, and native sign-in (password, the web
hand-off and the SSO token exchange) is refused with 403
`auth.mfa.enrollment_required`. A refresh token issued before the policy took
effect keeps working until its family lifetime ends ([Sessions](#sessions)).

**SSO accounts.** HealthLog cannot see what the identity provider checked, so
an SSO sign-in counts as one factor: put the second factor in the provider's
policy, and use HealthLog's own for the step-up gates
([`self-hosting/sso.md`](../self-hosting/sso.md#security-model)).

**A lost factor.** Recovery codes replace it once each. Without them, the
operator clears the factor after verifying the person's identity:
[`ops/security-recovery.md`](../ops/security-recovery.md#a-second-factor-is-lost).

## Step-up

Destructive and credential-changing acts need a factor proven within the last
five minutes. In a browser the proof is stamped on the session. The app has
no session, so it mints a step-up elevation instead (`POST /api/auth/step-up`
against a re-proved factor, 5 per 15 minutes): an `hle_` value bound to the
calling token, single use, five minutes, sent in the `X-Step-Up` header. Only
the gates marked below accept it; the set is frozen by
`src/__tests__/step-up-elevation-guard.test.ts`.

| Gate                                            | Asks for                                                                        | App (elevation)                      | Used by                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requireMfaManagementAuth`                      | a fresh second factor or passkey                                                | yes                                  | TOTP and security-key setup and removal, recovery-code regeneration, passkey removal                                                                                                                                                     |
| `requireFreshMfaOrElevationIfEnrolled`          | a fresh second factor, when the account has one                                 | yes                                  | account deletion, data reset                                                                                                                                                                                                             |
| `requireFreshMfaIfEnrolled`                     | a fresh second factor, when the account has one                                 | no                                   | password change, sharing grants                                                                                                                                                                                                          |
| `requireFreshMfa`                               | a fresh second factor or passkey, always                                        | no                                   | encryption key rotation, managed profiles, their guardians and handover                                                                                                                                                                  |
| `requireRecentProof`, `assertRecentCookieProof` | the password, a fresh SSO sign-in or a passkey; the second factor when enrolled | per route, `requireRecentProof` only | exports, the encrypted archive, share links, API and MCP token mints, calendar feeds, emergency-card links, MCP consent, admin user deletion and password reset, backup download, upload and restore, the push-relay sender-key rotation |

A password-proved elevation never stands in for a second factor, a
trusted-device cookie never satisfies step-up, and neither does an SSO sign-in
on an account with its own second factor. Guards: `src/lib/auth/guards/`.

## Sessions

| Credential           | Lifetime                                                                                                                                                           | Setting     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| Web session          | ends after `SESSION_IDLE_TIMEOUT_DAYS` without use (sliding, default 30) and at the latest `SESSION_MAX_LIFETIME_DAYS` after sign-in (absolute, default 90)        | environment |
| Native access token  | 1 day                                                                                                                                                              | fixed       |
| Native refresh token | 60 days, renewed on each rotation, and at the latest `REFRESH_TOKEN_MAX_LIFETIME_DAYS` after the sign-in that started its family (default 180)                     | environment |
| MCP OAuth connection | access token 60 minutes; refresh 30 days, renewed on use, and at the latest `REFRESH_TOKEN_MAX_LIFETIME_DAYS` after consent; the consent screen states the maximum | environment |
| Trusted device       | 30 days                                                                                                                                                            | fixed       |
| Step-up proof        | 5 minutes                                                                                                                                                          | fixed       |

When a lifetime ends, the browser is sent to sign-in; the iOS app's refresh is
answered 401 `auth.refresh.invalid`, and the app signs out and shows its
sign-in; an MCP client gets `invalid_grant` and runs consent again.

**Why these numbers.** HealthLog is installed as an app on a personal phone or
computer and used briefly most days; a short idle timeout would mostly train
people to keep a password in reach of the screen. The protection against a
stolen or unlocked device is in what a session can do: everything destructive
or credential-changing needs a fresh factor (above), and every session is
visible and revocable. The absolute lifetime puts an upper bound on a session
that is used every day, so that a forgotten or stolen sign-in ends on its own.
Operators who want stricter values set them lower.

**Cookie.** The session cookie is `__Host-healthlog_session` (`healthlog_session`
on a plain-HTTP install, which cannot hold a `__Host-` cookie), `HttpOnly`,
`Secure`, `Path=/`, `SameSite=Lax` (`src/lib/auth/session-cookie.ts`). It
carries a 32-byte random secret; the database holds only its HMAC. `Lax`
rather than `Strict`, because an SSO sign-in returns from the identity
provider as a cross-site navigation, and so do links into the app from a
notification or a calendar; under `Strict` they would arrive signed out.
Cross-site and same-site-but-cross-origin writes are refused by the server
regardless (`src/lib/http/cross-site-guard.ts`, 403 `request.cross_site`).

**Concurrent sessions.** There is no limit on how many sessions or devices an
account has. Settings, Security lists each web session and app sign-in with
device, coarse place and masked address; each can be ended, or all others at
once. A sign-in from a device the account has not used before writes
`auth.login.new_device` and sends a notification. A password change, adding or
removing a second factor, and a password reset end the other sessions. An
admin's force sign-out (`/api/admin/users/[id]/force-logout`) ends the
account's web sessions; an admin password reset ends every sign-in, the app's
refresh tokens, API tokens and trusted devices included.

**Identity provider sessions.** A HealthLog session is independent of the
session at the identity provider. Signing out at the provider, or the
provider ending its session, does not end a HealthLog session; the HealthLog
session ends on its own lifetime, by signing out in HealthLog, or when it is
revoked in Settings, Security or by an admin. Disabling the account at the
provider stops new sign-ins only. See
[`self-hosting/sso.md`](../self-hosting/sso.md#sessions).

## Related

- [Authorization](authorization.md): what an authenticated caller may reach.
- [Key management](key-management.md): the keys behind the hashes and tokens.
- [Logging](logging.md#security-events): the events every pathway writes.
- [`ops/mfa-enforcement.md`](../ops/mfa-enforcement.md),
  [`ops/security-recovery.md`](../ops/security-recovery.md),
  [`ops/password-reset.md`](../ops/password-reset.md),
  [`self-hosting/mcp.md`](../self-hosting/mcp.md),
  [`self-hosting/account-sharing.md`](../self-hosting/account-sharing.md).
