# Encryption-key rotation

HealthLog encrypts sensitive at-rest data (Withings tokens, AI provider keys,
notification channel configs, web-push subscription secrets, VAPID private
keys, etc.) with AES-256-GCM under a per-deployment key. v1.4 introduces a
versioned key format so the key can be rotated without downtime and without
re-encrypting every row by hand.

## Format

| Layout          | Marker                                          | Where                       |
| --------------- | ----------------------------------------------- | --------------------------- |
| Versioned (new) | `<keyId>.<base64(iv \|\| tag \|\| ciphertext)>` | All new writes              |
| Legacy (v1.3.x) | `<base64(iv \|\| tag \|\| ciphertext)>`         | Existing rows until rotated |

`<keyId>` matches `[A-Za-z0-9_-]{1,32}` and indexes into the `ENCRYPTION_KEYS`
JSON map. Decryption tries the versioned format first; if no `.` is present
or the prefix isn't a known id, the row is treated as legacy and decrypted
under `v1` (the synthetic id assigned to the existing `ENCRYPTION_KEY`).

> **Why a separate `v1` is required.** Legacy ciphertexts have no key id, so
> the only way to identify them is "no `.` in the value". If you remove the
> `v1` entry from `ENCRYPTION_KEYS` _before_ every legacy row has been
> rotated, those rows can't be decrypted any more — the active key won't
> match the original ciphertext. The decrypt path now refuses to silently
> fall back to the active key in that scenario; it throws a clear error.

## Rotating from v1.3.x to a new key

1. **Generate the new key** on a machine with `openssl`:
   ```
   openssl rand -hex 32
   ```
2. **Update environment variables.** Keep the existing `ENCRYPTION_KEY` in
   place — it's still needed to decrypt legacy rows during the transition:
   ```
   ENCRYPTION_KEY="<old key, unchanged>"
   ENCRYPTION_KEYS='{"v1":"<old key>","v2":"<new key>"}'
   ENCRYPTION_ACTIVE_KEY_ID="v2"
   ```
   Restart the app. New writes are now encrypted under `v2`; existing
   `v1`-keyed and legacy bare rows still decrypt because the `v1` entry is
   retained.
3. **Run the rotation script** to re-encrypt every existing encrypted column
   under the new active key:
   ```
   pnpm tsx scripts/rotate-encryption-key.ts v2
   ```
   The script is idempotent — running it again is a no-op for rows already
   prefixed with `v2.`. It rotates User, WithingsConnection, AppSettings,
   NotificationChannel, and PushSubscription rows. The summary line at the
   end shows `scanned`, `rotated`, and `errors` per table+field; treat
   `errors > 0` as a hard failure and re-run after fixing the cause.
4. **Drop the old key (optional, recommended).** Once the script has run
   cleanly:
   ```
   ENCRYPTION_KEYS='{"v2":"<new key>"}'
   ENCRYPTION_ACTIVE_KEY_ID="v2"
   # ENCRYPTION_KEY can now be removed
   ```
   Restart. The legacy single-key fallback is now disconnected; only `v2`
   exists.

## Adding a third key (v2 → v3)

Same procedure, just shift the labels — keep `v2` in the map until the
script reports zero `v2.`-prefixed rows remaining.

```
ENCRYPTION_KEYS='{"v2":"<old>","v3":"<new>"}'
ENCRYPTION_ACTIVE_KEY_ID="v3"
pnpm tsx scripts/rotate-encryption-key.ts v3
ENCRYPTION_KEYS='{"v3":"<new>"}'
```

## Rollback

> **Important.** Once the rotation script has run, ciphertexts in the
> database start with `v2.` (or whatever the active id is). The pre-PR
> v1.3.x image cannot read that prefix — it expects bare base64 — and
> calling `decrypt()` on those rows will throw.

If you need to revert to the pre-rotation image:

- Either keep the new image. The new code reads both formats, so most
  rollback scenarios don't need to undo rotation.
- Or, if you must run the old code, restore a database backup taken
  _before_ the rotation script ran. There is no script to convert
  `v2.`-prefixed rows back to legacy format — by design, rotation is a
  forward-only operation.

This is why we recommend running the rotation in a window where you have a
fresh DB snapshot and the new image has been smoke-tested in production for
at least 24 hours.

## Troubleshooting

- `Encryption key id 'v1' is not configured` — the database still contains
  `v1.`-prefixed rows but `v1` was removed from `ENCRYPTION_KEYS`. Re-add
  the key, run the rotation script, then remove again.
- `Found a legacy-format ciphertext but no v1 key is configured` — same
  cause for legacy bare-base64 rows. Restore `ENCRYPTION_KEY` (or add a
  `v1` entry to `ENCRYPTION_KEYS`) and run the rotation script before
  removing it.
- `Refusing to rotate: argv key id ... does not match the currently active
id ...` — pass the same id you set in `ENCRYPTION_ACTIVE_KEY_ID`. The
  guard prevents accidental re-encryption to a non-current key.
