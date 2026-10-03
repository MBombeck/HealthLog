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
3. **Re-encrypt the stored data under the new key.** Open **Admin →
   Encryption** and press **Rotate now**. The button needs an admin account
   with a second factor, confirmed recently; it queues one background run
   (`POST /api/admin/encryption/rotate`) on the app's own worker, so it
   works on the published image with nothing else installed. The same page
   shows the per-column counts and the result of the last run.

   Without a second factor on any admin account, run the rotation script
   instead. It imports the application code and the generated database
   client, so it runs from a source checkout of the same release, not
   inside the production container (the image has no package manager and
   does not contain `scripts/rotate-encryption-key.ts`). It needs the same
   `ENCRYPTION_KEYS` and `ENCRYPTION_ACTIVE_KEY_ID` as the app and a
   `DATABASE_URL` that reaches the database:

   ```
   git checkout vX.Y.Z   # the release the instance runs
   pnpm install && pnpm db:generate
   pnpm dlx tsx scripts/rotate-encryption-key.ts v2
   ```

   The bundled `db` service publishes no port. On a stock compose stack,
   either publish `5432` for the duration, or run the checkout in a
   throwaway `node:22` container attached to the compose network.

   Both paths are idempotent: running again is a no-op for rows already
   prefixed with `v2.`. Both rotate every column in the canonical registry
   (`src/lib/crypto/encrypted-columns.ts`), which covers the `*Encrypted`
   columns plus the ones whose names say nothing about their contents:
   `IntegrationStatus.lastError`, `CoachMessage.encryptedContent`,
   `NotificationChannel.config`, the OAuth `accessToken` / `refreshToken`
   columns, the web-push `p256dh` / `auth` secrets, the idempotent-replay
   `IdempotencyKey.responseBody`, and `DataBackup.data` — the whole-account
   backup blob.

   When you used the script, read three things off its output before going
   further:

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
   rather than the absence of complaints. Open **Admin → Encryption** and
   confirm the status view reports zero rows outside the active key, or
   re-run the script: a clean second pass reports `rotated=0`, `errors=0` and
   a full `Columns walked` line. Both read the same registry the rotation
   walks.

   A run that walked every column without an error also removes the boot
   key check's record of each previous key id that no longer holds a single
   value (`encryption_key_canaries`); the script prints which ids it removed
   and, for an id that still holds values, the columns that do. With the record
   gone, the id can later carry a different key without the start-up check
   refusing it.

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

> **The rows in the database are covered. The content of a backup is not.**
> Rotation re-encrypts every registered column, including `DataBackup.data`
> and the pieces in `DataBackupChunk`, so every stored copy opens under the
> new key. What it cannot change is what a disaster-recovery backup carries
> inside: the database's ciphertext as it was stored when the copy was taken,
> which a restore writes back verbatim. A copy taken before the rotation still
> needs the old key for its notes, documents and coach history, and so does
> every copy in the off-host bucket and every backup file you downloaded.
>
> So before step 4, also check **Admin → Encryption → Keys the backups still
> need**. It lists, per key id, the stored copies that need it with the oldest
> date, and when the last off-host copy needing it expires under the bucket's
> lifecycle rule. Keep the old key in `ENCRYPTION_KEYS` until it is no longer
> listed there (the weekly copy replaces itself within a week; delete old
> uploaded copies you no longer want, and wait out the off-host retention), or
> accept that those copies cannot be restored. Copies written before v1.39.3
> did not record their keys and are listed as such: treat them as needing
> every key that existed when they were written.
>
> Dropping the key early no longer fails silently: a restore, a restore
> preview or an upload of a copy that needs a missing key is refused with the
> key id named, and nothing is changed. Putting the key back makes the copy
> restorable again.
>
> If you rotated on a release before v1.38.6 and dropped the previous key,
> the stored backups themselves are encrypted under the key you removed: put
> that key back into `ENCRYPTION_KEYS` and re-run the rotation on this release
> before removing it again.

## Adding a third key (v2 → v3)

Same procedure, just shift the labels — keep `v2` in the map until a full
run (every registered column walked) reports zero `v2.`-prefixed rows
remaining.

```
ENCRYPTION_KEYS='{"v2":"<old>","v3":"<new>"}'
ENCRYPTION_ACTIVE_KEY_ID="v3"
# restart, then Admin → Encryption → Rotate now
# (or: pnpm dlx tsx scripts/rotate-encryption-key.ts v3 from a checkout)
ENCRYPTION_KEYS='{"v3":"<new>"}'
```

## Rollback

> **Important.** Once a rotation has run, ciphertexts in the
> database start with `v2.` (or whatever the active id is). The pre-PR
> v1.3.x image cannot read that prefix — it expects bare base64 — and
> calling `decrypt()` on those rows will throw.

If you need to revert to the pre-rotation image:

- Either keep the new image. The new code reads both formats, so most
  rollback scenarios don't need to undo rotation.
- Or, if you must run the old code, restore a database backup taken
  _before_ the rotation ran. There is no script to convert
  `v2.`-prefixed rows back to legacy format — by design, rotation is a
  forward-only operation.

This is why we recommend running the rotation in a window where you have a
fresh DB snapshot and the new image has been smoke-tested in production for
at least 24 hours.

## Troubleshooting

- `Encryption key id 'v1' is not configured` — the database still contains
  `v1.`-prefixed rows but `v1` was removed from `ENCRYPTION_KEYS`. Re-add
  the key, run the rotation again, then remove it.
- `Found a legacy-format ciphertext but no v1 key is configured` — same
  cause for legacy bare-base64 rows. Restore `ENCRYPTION_KEY` (or add a
  `v1` entry to `ENCRYPTION_KEYS`) and run the rotation again before
  removing it.
- `Refusing to rotate: argv key id ... does not match the currently active
id ...` — pass the same id you set in `ENCRYPTION_ACTIVE_KEY_ID`. The
  guard prevents accidental re-encryption to a non-current key.
