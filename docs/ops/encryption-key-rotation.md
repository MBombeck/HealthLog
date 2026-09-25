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
3. **Run the rotation script** to re-encrypt every registered encrypted column
   under the new active key:

   ```
   pnpm dlx tsx scripts/rotate-encryption-key.ts v2
   ```

   The script is idempotent — running it again is a no-op for rows already
   prefixed with `v2.`. It rotates every column in the canonical registry
   (`src/lib/crypto/encrypted-columns.ts`), which covers the `*Encrypted`
   columns plus the ones whose names say nothing about their contents:
   `IntegrationStatus.lastError`, `CoachMessage.encryptedContent`,
   `NotificationChannel.config`, the OAuth `accessToken` / `refreshToken`
   columns, the web-push `p256dh` / `auth` secrets, the idempotent-replay
   `IdempotencyKey.responseBody`, and `DataBackup.data` — the whole-account
   backup blob.

   Read three things off the output before going further:

   - the per-column line, `scanned` / `rotated` / `errors` / `dropped`.
     `scanned` counts the rows that hold ciphertext in that column, not every
     row of the table. Treat `errors > 0` as a hard failure and re-run after
     fixing the cause. A
     `dropped` count is only ever a cache row the run could not read and
     deleted rather than leave unreadable.
   - `Columns walked: N/M registered`. The two numbers must match.
   - a `NOT WALKED` block, if one appears. It lists registered columns this
     run skipped, and the run exits non-zero. Rotation is incomplete; do not
     go on to step 4.

   Two guard tests keep the registry honest in CI: one scans the schema for
   `*Encrypted` columns, the other derives the ciphertext-bearing columns from
   the Prisma write payloads, which is what catches a column that holds
   ciphertext under an ordinary name.

4. **Confirm nothing is left on the old key, THEN drop it.** This is the step
   that destroys data if it is taken on a bad signal, so check the corpus
   rather than the absence of complaints. Either re-run the script — a clean
   second pass reports `rotated=0`, `errors=0` and a full `Columns walked`
   line — or open **Admin → Encryption** and confirm the status view reports
   zero rows outside the active key. Both read the same registry the rotation
   walks.

   A zero only means "nothing left" when the run also says it walked every
   registered column. A zero from a run that skipped columns means "never
   looked", and dropping the old key on it makes those rows permanently
   undecryptable — `decrypt()` is fail-closed and there is no recovery path.
   Only once the corpus reads clean:

   ```
   ENCRYPTION_KEYS='{"v2":"<new key>"}'
   ENCRYPTION_ACTIVE_KEY_ID="v2"
   # ENCRYPTION_KEY can now be removed
   ```

   Restart. The legacy single-key fallback is now disconnected; only `v2`
   exists.

> **Backups are covered, and were not always.** `DataBackup.data` holds every
> weekly disaster-recovery snapshot and every uploaded pack, encrypted like
> everything else but under a column called `data`. It was outside the
> registry until v1.38.6, so a rotation before that release reported zero
> rows remaining without ever reading a backup. If you rotated on an older
> release and dropped the previous key, the stored backups are encrypted
> under the key you removed: put that key back into `ENCRYPTION_KEYS` and
> re-run the rotation on this release before removing it again.

## Adding a third key (v2 → v3)

Same procedure, just shift the labels — keep `v2` in the map until a full
run (every registered column walked) reports zero `v2.`-prefixed rows
remaining.

```
ENCRYPTION_KEYS='{"v2":"<old>","v3":"<new>"}'
ENCRYPTION_ACTIVE_KEY_ID="v3"
pnpm dlx tsx scripts/rotate-encryption-key.ts v3
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
