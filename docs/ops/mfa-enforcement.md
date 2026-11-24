# Require a second factor (operator)

Three policies can require an account to have a second factor: an
authenticator app (TOTP), a security key, or a passkey (a passkey counts on
its own, since a passkey sign-in already proves possession).

| Policy                                  | Where                       | Default | Grace period |
| --------------------------------------- | --------------------------- | ------- | ------------ |
| Require a second factor for admins      | Admin > General settings    | on      | yes          |
| Require a second factor (every account) | Admin > General settings    | off     | yes          |
| Per-account enforcement                 | Admin > Users > the account | off     | none         |

## Grace period

An account a policy newly covers gets the **grace period** (Admin > General
settings, 14 days by default, 0 to 90) to add a factor. It counts from the
moment the policy took effect: switching a policy on starts it again, and on
an install updated to 1.50 it starts with the update. During it the account
works as before and the app shows a notice with the date. A per-account
enforcement set by an admin applies at once.

## After the grace period

- **Browser.** The account can still sign in, but its session reaches only
  what enrolment needs: the account payload, the second-factor and passkey
  enrolment routes, re-proof, and sign-out. Pages redirect to `/enroll-mfa`;
  every other API route answers `403` with `meta.errorCode`
  `auth.mfa.enrollment_required`. This is enforced on the server, from the
  session row (`sessions.mfa_enrollment_due_at`), not by the browser hint
  cookie. The moment a factor exists the session is whole again.
- **iPhone app and other native clients.** A sign-in (password, the native
  web hand-off, or the single sign-on token exchange) is refused with `403`
  `auth.mfa.enrollment_required` and no token is issued. The person adds a
  factor in a browser (Settings > Security) and signs in again. Tokens issued
  before the grace period ended keep working until their refresh family ends
  (at most `REFRESH_TOKEN_MAX_LIFETIME_DAYS`, 180 by default).
- **Personal API tokens** (Settings > API tokens) are not sign-ins and are not
  affected; revoke them if an account must lose access now.

Somebody who knows an account's password can enrol a factor of their own
during or after the grace period, as with any enrolment at sign-in. The
policy narrows what a password alone reaches; it does not replace a strong
password.

## The demo, and recovery

A public demo (`DEMO_MODE=true`) shares one account that cannot enrol a
factor, so no policy applies there.

If an admin is locked out (lost factor, no browser at hand), switch the
policies off directly in the database and add a factor before switching them
on again:

```sql
UPDATE app_settings SET mfa_required_for_admins = false, mfa_required = false;
```

See [security recovery](security-recovery.md) for a lost factor.
