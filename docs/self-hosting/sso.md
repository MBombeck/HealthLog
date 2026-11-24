# SSO login (OIDC)

HealthLog can delegate sign-in to a self-hosted OpenID Connect identity
provider — Authentik, Keycloak, Authelia, Pocket-ID, or anything else
that serves a standard discovery document. The flow is the OIDC
authorization-code flow with PKCE against a single, env-configured
provider; by default it is **additive** (the SSO button appears next to
password and passkey login), with an explicit opt-in to make it the only
way in.

## Setup

1. Register a **confidential** OIDC client at your IdP with the redirect
   URI

   ```
   ${NEXT_PUBLIC_APP_URL}/api/auth/oidc/callback
   ```

   The comparison at the IdP is byte-exact: scheme, host, port, and path
   all matter. `https://healthlog.example.com/api/auth/oidc/callback` and
   `http://healthlog.example.com/api/auth/oidc/callback` are different
   URIs, and a trailing slash breaks the match.

2. Set the three provider vars (all three together enable the login-page
   button; anything less keeps SSO fully disabled):

   ```env
   OIDC_ISSUER_URL="https://idp.example.com"
   OIDC_CLIENT_ID="healthlog"
   OIDC_CLIENT_SECRET="..."
   ```

   The issuer must serve
   `<issuer>/.well-known/openid-configuration`. Prefer HTTPS — the
   authorization code and the token response carrying the ID token cross
   this connection. Plain HTTP is defensible only on a fully trusted
   private network (IdP and app on the same box, a Tailscale mesh, a
   VPN); a LAN-only issuer is explicitly supported.

3. Optional tuning:

   ```env
   OIDC_SCOPES="openid email profile"     # default shown
   OIDC_BUTTON_LABEL="Single Sign-On"     # default shown
   OIDC_ONLY="false"                      # see below before changing
   ```

4. Remember the compose env whitelist: every `OIDC_*` var must appear
   under `environment:` in `docker-compose.yml` (the shipped file lists
   them) — vars not on the whitelist never reach the container even when
   `.env` has them.

`pnpm check-env` knows all six vars and flags a partially configured
provider group.

## Per-IdP notes

Client registration essentials only — the IdP's own docs cover the rest.

- **Authentik.** Create a _Provider_ of type OAuth2/OpenID (confidential
  client), bind it to an _Application_, and use the provider's issuer URL
  (shaped like `https://authentik.example.com/application/o/<app-slug>/`
  — the trailing slash is part of Authentik's issuer; the discovery
  check tolerates the difference). Signing key: any RSA/EC key; the
  default RS256 works.
- **Keycloak.** Create a client with _Client authentication_ ON and the
  _Standard flow_ enabled. The issuer is
  `https://keycloak.example.com/realms/<realm>`. Keep the default RS256
  signature algorithm; do not switch the client to `HS256` — HealthLog
  rejects HMAC-signed ID tokens.
- **Authelia.** Define a client under `identity_providers.oidc.clients`
  with `token_endpoint_auth_method: client_secret_post` (HealthLog sends
  the secret in the POST body) and the redirect URI above. The issuer is
  Authelia's root URL.
- **Pocket-ID.** Add an OIDC client, copy the generated ID and secret,
  and use the Pocket-ID base URL as the issuer. Pocket-ID authenticates
  users by passkey at the IdP; to HealthLog it is a provider like any
  other.

## Security model

- **Identity is pinned, not guessed.** The first OIDC sign-in either
  provisions a fresh account or links to an existing account with the
  same email, and only when the IdP asserts `email_verified: true` (an
  IdP that does not assert verification is rejected). An existing
  account is never linked on the email alone: HealthLog never verified
  that address, so anyone could have registered it or typed it into a
  profile. The browser is sent to the sign-in page instead, and the link
  is made when the person signs in to that account once with its own
  password (and second factor) or passkey, within ten minutes. Under
  `OIDC_ONLY` that password sign-in is allowed for exactly that account.
  The iOS app gets `oidc_link_required` and the person confirms once on
  the web. Either way the account is stamped with the provider's
  `(issuer, sub)` pair, and every later login matches on that pair
  alone. An email change at the IdP updates the
  displayed email; it can never re-point the login at a different
  account. An email that matches an account already pinned to a
  _different_ identity is rejected and audited.
- **SSO sessions never satisfy step-up.** Destructive actions (disabling
  MFA, rotating encryption keys, encrypted export, account deletion)
  require a _fresh_ second factor confirmed by HealthLog itself. An OIDC
  login is a delegated factor — whatever the IdP checked, this app did
  not see it — so an SSO session always has to confirm a native factor
  (or the password path) when it hits one of those gates.
- **Accounts with native 2FA keep it.** If the account has a confirmed
  TOTP secret or a registered security key, an OIDC login does not
  complete on its own: after the IdP round-trip the user lands in the
  same second-factor step password login uses. SSO never downgrades an
  account's own MFA.
- **MFA belongs at the IdP.** For SSO-provisioned accounts, enforce
  MFA in the IdP's policy engine — that is the point of delegating
  authentication. HealthLog-side 2FA remains available on top for the
  step-up gates above.
- **Claiming a managed profile binds a fresh identity only.** When a
  person claims a managed profile through SSO, their `(issuer, sub)` is
  bound to that record, and only if no account on the instance already
  holds it, and the provider's address is used only when it is verified
  and not already taken. A claim can therefore never attach somebody's
  existing sign-in to a second record or take over an existing account.
- **Linking is once.** There is no unlink/relink flow in this cut; the
  pin is deliberately sticky. Moving an account to a new IdP identity is
  an operator decision (a manual `users.oidc_issuer` / `users.oidc_sub`
  update), not something a login can do.

## Sessions

A sign-in through the identity provider creates an ordinary HealthLog
session, and from then on the two sessions are independent:

- Signing out at the provider, or the provider's session expiring, does
  **not** end the HealthLog session. HealthLog does not take part in the
  provider's logout (no front- or back-channel logout).
- The HealthLog session ends on its own idle timeout and absolute lifetime
  (`SESSION_IDLE_TIMEOUT_DAYS`, `SESSION_MAX_LIFETIME_DAYS`; the app's
  refresh tokens on `REFRESH_TOKEN_MAX_LIFETIME_DAYS`), when the person signs
  out of HealthLog, or when the session is revoked in Settings, Security or by
  an admin. After that, the next sign-in goes to the provider again.
- Disabling a person at the provider stops new sign-ins, not existing
  sessions. To cut someone off at once, also end their HealthLog sessions
  (an admin password reset ends every sign-in, the app's included).

Details: [`docs/security/authentication.md`](../security/authentication.md#sessions).

## OIDC_ONLY

`OIDC_ONLY="true"` disables password and passkey login **server-side**
(the routes return 403; hiding the buttons is not the boundary).
Consequences to accept before turning it on:

- **The native iOS app needs a build that ships the SSO flow.** The app
  signs in via the native OIDC handoff (`GET /api/auth/oidc/login?client=native`
  with PKCE and the fixed `healthlog://` callback) or via password/passkey.
  `OIDC_ONLY` works with app builds that carry the handoff; older
  password/passkey-only builds are locked out.
- **Existing sessions survive.** The flag gates new sign-ins, not live
  sessions — nobody is thrown out at flip time, including
  password-authenticated sessions.
- **Self-disabling on half-config.** The flag only takes effect while
  the three provider vars are fully set, so a typo in the provider group
  can never lock every user out.
- **Managed profiles are still handed over** (v1.43). The person claims the
  record through the identity provider instead of setting a password; the
  password claim is refused. See
  [Handing a record over to its person](account-sharing.md#handing-a-record-over-to-its-person).

### Break-glass (IdP down or misconfigured)

1. Unset `OIDC_ONLY` (or set it to `"false"`) in `.env`, then
   `docker compose up -d`. Password and passkey login are live again
   immediately.
2. Accounts that were **provisioned** through SSO have no password. Set
   one from the host, per [docs/ops/password-reset.md](../ops/password-reset.md):

   ```sh
   docker compose exec app node scripts/reset-password.mjs <username-or-email>
   ```

## Troubleshooting

| Symptom                                                                                       | Cause / fix                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login page shows "Single sign-on failed", log says `discovery issuer mismatch`                | `OIDC_ISSUER_URL` must equal the `issuer` inside the discovery document. A single trailing slash either way is tolerated; anything else (scheme, host, port, path, `//`) is a hard reject.                                                                      |
| `discovery request failed: 3xx`                                                               | Discovery redirects are not followed (egress policy pins `redirect: "manual"`). Point `OIDC_ISSUER_URL` at the final URL — e.g. include the realm/application path, match `http` vs `https`, add/remove `www`.                                                  |
| IdP shows its own "invalid redirect URI" page                                                 | The mismatch happens **at the IdP**, before HealthLog is involved. Compare the registered URI against `${NEXT_PUBLIC_APP_URL}/api/auth/oidc/callback` byte for byte — scheme and port included.                                                                 |
| Sign-in loops back with "failed" and the log shows an `exp`/`nbf` claim error                 | Clock skew beyond the 60 s tolerance. Fix NTP on the IdP or app box.                                                                                                                                                                                            |
| "Your identity provider did not mark your email address as verified"                          | The IdP omits `email_verified` or sends `false`. Mark the address verified at the IdP (Keycloak: user → Email verified; Authentik: verify the email stage) — HealthLog will not link or provision without it.                                                   |
| "An account with this email address already exists here. Sign in to it once …"                | The IdP email matches a local account that is not linked yet. Sign in to that account with its password or passkey within ten minutes and the link is made. If nobody knows that account's password, an operator decides which account the identity belongs to. |
| "That email address belongs to an account that is already linked to a different SSO identity" | Deliberate: identities never re-bind silently. See "Linking is once" above.                                                                                                                                                                                     |
| SSO button missing                                                                            | One of the three provider vars is empty or not whitelisted in compose. `pnpm check-env` shows which.                                                                                                                                                            |
