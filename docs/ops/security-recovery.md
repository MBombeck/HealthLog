# Security recovery and credential revocation

A password reset is an account-recovery event, not just a password-hash
change. The operator reset CLI revokes every access path for the target
account so a stolen session, native refresh token, long-lived API token,
trusted device, or temporary step-up proof cannot survive the new password.

Use the operator procedure in [Password reset](password-reset.md) and prefer
its hidden stdin prompt:

```sh
docker compose exec app node scripts/reset-password.mjs <username-or-email>
```

Do not put the new password in shell history, a ticket, chat, or logs.

## What a successful operator reset revokes

The CLI performs one serialized database transaction for exactly one matched
user. It:

1. locks the target account and writes the new password hash;
2. deletes every web session;
3. revokes every API access token;
4. revokes every native refresh token;
5. deletes every trusted device; and
6. deletes every live step-up elevation.

The safe completion message reports only the username and affected row counts.
It never prints the password, password hash, tokens, cookies, or health data.
Unrelated users are not changed.

The in-app administrative reset follows the same target-user revocation
policy for sessions, API tokens, native refresh tokens, and trusted device
records. Operators should still use the CLI recovery path when rollback-safe
direct recovery is required.

## Rollback guarantee

The operator CLI wraps identity resolution, password rotation, and every
revocation above in `BEGIN`/`COMMIT`. Any error issues `ROLLBACK` before the
database connection closes. A failed reset therefore does not leave a new
password paired with old credentials, or old password state paired with only
some credentials revoked.

Treat any non-zero exit as “nothing committed.” Correct the operational
problem and run the whole command again; do not manually complete a subset of
the SQL statements.

## After recovery

- Have the user sign in with the new password and enroll replacement trusted
  devices intentionally.
- Expect every browser and native client to require a fresh login.
- Reissue only the minimum API or MCP scopes each integration needs.
- Review security activity without copying credential material into the
  incident record.
- If compromise is suspected beyond one account, rotate the affected
  instance-level secrets using the relevant operator runbooks before
  restoring integrations.

## A second factor is lost

The person's own way back comes first: a recovery code replaces the second
factor at sign-in, once per code, and from there they can enrol a new factor.
The steps below are for an account whose owner has neither the factor nor a
recovery code.

### Verify the person first

Clearing a second factor lowers the account to one factor, so do it only on
evidence as strong as what the factor protected. Ask for the same proof the
account was set up with, never less:

- On a household instance, where the operator knows the person, confirm in
  person or on a call where you can see and hear them. A message from their
  e-mail address or chat account is not enough: if the second factor was
  needed, the attacker may hold exactly those.
- Where the operator does not know the person, ask for what was checked when
  the account was created (the invitation it came from, the identity document
  the organisation keeps), and have the request arrive through a channel
  other than the one the person is asking from.
- If the person can still sign in with the password, have them do so on a
  device you can watch; that proves the first factor too.
- Write down who asked, how you verified it and when, outside the instance.

### Clear the factor

From a source checkout of the running release, after `pnpm install` and `pnpm db:generate`, with a
`DATABASE_URL` that reaches the database as the owner (the script is not part
of the image):

```sh
DATABASE_URL='postgres://…' pnpm dlx tsx scripts/disable-mfa.ts <username-or-email>
```

In one transaction it clears the TOTP secret, deletes every recovery code,
deletes every web session and trusted device, revokes every native refresh
token, and writes an `auth.mfa.disabled` audit row with
`{"source":"cli","factor":"totp"}` on the account. The account then signs in
with its password alone and, where a policy requires a second factor
([`mfa-enforcement.md`](mfa-enforcement.md)), is sent straight to enrolment.

What the script does not do, and how to finish the job:

- **Security keys.** It looks only at the TOTP factor. An account whose only
  second factor is a security key gets "no active second factor, nothing to
  do". Remove the keys as the owner and record it yourself:

  ```sql
  BEGIN;
  DELETE FROM webauthn_mfa_credentials WHERE user_id = '<user id>';
  DELETE FROM mfa_recovery_codes WHERE user_id = '<user id>';
  DELETE FROM sessions WHERE user_id = '<user id>';
  DELETE FROM trusted_devices WHERE user_id = '<user id>';
  UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = '<user id>' AND revoked_at IS NULL;
  INSERT INTO audit_logs (id, user_id, action, details, created_at)
    VALUES (gen_random_uuid()::text, '<user id>', 'auth.mfa.disabled',
            '{"source":"cli","factor":"webauthn"}', now());
  COMMIT;
  ```

- **API tokens and step-up elevations** survive. If the factor was lost to
  theft rather than to a broken phone, follow with a password reset
  ([above](#what-a-successful-operator-reset-revokes)), which revokes those
  too, and let the person choose a new password.

Afterwards the person enrols a new factor and generates new recovery codes.
