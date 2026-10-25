# Account copies and restore

HealthLog keeps copies of each account so that one account can be rolled back
on this server. These copies are per account. They cannot rebuild a lost
server: a restore writes into an account that already exists here under the
same id, and refuses a copy whose account is gone. To recover a server, you
need a database dump and the encryption keys. That procedure is in
[disaster-recovery.md](disaster-recovery.md).

## What exists

| Copy                    | Where                     | When                                                           | Kept                                                                          |
| ----------------------- | ------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Weekly account rollback | this database             | Sundays 03:00, or **Backup now** in Admin → Backups            | one per account, replaced in place each week                                  |
| Copy before a data wipe | this database             | right before "Delete all data" deletes anything                | until `ACCOUNT_DELETION_GRACE_DAYS` has passed, then the purge job deletes it |
| Uploaded copy           | this database             | when an admin uploads a file in Admin → Backups                | until deleted                                                                 |
| Off-host copy           | your S3-compatible bucket | nightly at 02:30 Europe/Berlin, one object per account per day | as long as the bucket's lifecycle rule keeps it                               |
| Personal export         | the person's device       | Settings → Export, "Full backup"                               | wherever they keep it                                                         |

The weekly, pre-wipe and off-host copies carry the whole record, document
files and ECG traces included, with the database's ciphertext inside them as
stored. An uploaded copy holds whatever its file held. The personal
export is portable: readable values, and documents as metadata only. It is
meant for the person to keep and read. A restore refuses it when the file
lists any document, because it carries no document content to put back.

Two kinds of data are not in any account copy: workout GPS routes and sample
series. Credentials, devices, share links and account grants are left out on
purpose (see "What a restore does not touch").

The JSON import in Settings → Export & import is not a restore. It adds
measurements and mood entries, up to 16 MB and 10,000 entries per list.

## The deletion grace window

`ACCOUNT_DELETION_GRACE_DAYS` (14 by default, at most 30) sets how long an
erasure waits:

- **Deleting an account**, or a guardian deleting a **managed profile**, locks
  the account at once. Every session, refresh token, API token, connector and
  share link is revoked, sign-in is refused with the date the account is
  erased, and nothing runs for the account any more: no reminders, syncs,
  copies, scores or AI work. The record, its stored copies and its off-host
  objects stay as they are. **Admin → Users** shows the account with its
  erasure date and an **Undo deletion** button. When the window ends, the
  hourly `account-deletion-purge` job erases the account and asks the bucket to
  delete its off-host objects.
- **Delete all data** first stores the whole record as a copy of its own
  (shown as "Before all data was deleted" in Admin → Backups), then empties the
  record. An admin can restore that copy until the window ends. The off-host
  objects from before the wipe are kept until then too.

Database dumps are not purged per account: a deleted account stays in them
until they age out (`DB_BACKUP_KEEP` nights on the server, and the bucket's
lifecycle rule for `database/`). The deletion dialogs say so.

`0` erases immediately, as releases before 1.46 did. The Data & Privacy page
and the deletion dialogs state the configured number.

## Restoring an account

In **Admin → Backups**, every stored copy has **Restore**. The dialog first
shows what the copy holds, then asks you to type `RESTORE`. The restore runs
in the background and replaces the account's data tables: every row the copy
holds comes back under its original id, and every row the account gained
after the copy was taken is deleted. If the current state is worth keeping,
press **Backup now** first.

_Also restore instance settings_ writes the registration, MFA, locale, module,
notification and AI settings from the copy back for the whole server. Leave it
clear unless those settings themselves need to go back.

To restore from an **off-host object**, fetch and decrypt it from a source
checkout with the backup variables of the server that wrote it:

```bash
BACKUP_S3_ENDPOINT=... BACKUP_S3_BUCKET=... \
BACKUP_S3_ACCESS_KEY=... BACKUP_S3_SECRET_KEY=... \
BACKUP_ENCRYPTION_KEY=<the key the object was written under> \
pnpm dlx tsx scripts/restore-backup.ts 2026-05-08/user-<id>.json.enc /tmp/restored.json
```

Then upload `/tmp/restored.json` in Admin → Backups (up to 512 MB after
compression) and restore it from its row. The account `<id>` must exist on this
server.

Every restore, preview and upload checks first that this server holds every
application key the copy's content was written under, and refuses with the key
id named if not. Nothing is changed by a refused restore.

### What a restore does not touch

API tokens, trusted devices, step-up elevations, known devices, clinician share
links and account grants are not in any copy. A restore on this server leaves
them as they are, so shared access carries on. The reasoning per model is in
`src/lib/export/backup-plan.ts`.

## Off-host copies

| Variable                          | Required | Notes                                                                 |
| --------------------------------- | -------- | --------------------------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY`           | yes      | 64 hex chars or 32-byte base64; not the same as `ENCRYPTION_KEY`      |
| `BACKUP_S3_ENDPOINT`              | yes      | e.g. `https://<account>.r2.cloudflarestorage.com`                     |
| `BACKUP_S3_BUCKET`                | yes      |                                                                       |
| `BACKUP_S3_ACCESS_KEY`            | yes      |                                                                       |
| `BACKUP_S3_SECRET_KEY`            | yes      |                                                                       |
| `BACKUP_S3_REGION`                | no       | defaults to `auto` (Cloudflare R2)                                    |
| `BACKUP_RETENTION_DAYS`           | no       | not read by the app; the number to put in the bucket's lifecycle rule |
| `BACKUP_ENCRYPTION_PREVIOUS_KEYS` | no       | retired off-host keys, comma-separated, used for reading only         |

Objects are named `YYYY-MM-DD/user-<id>.json.enc`: the record as JSON,
gzipped and sealed with AES-256-GCM under `BACKUP_ENCRYPTION_KEY`, with the
object's own name as associated data and the key's id in the header.

The nightly database dump goes into the same bucket, as
`database/healthlog-<time>-daily.dump.enc` with its manifest beside it, sealed
the same way. It is the copy that rebuilds a lost server
([disaster-recovery.md](disaster-recovery.md)).

**Permissions.** The worker needs `PutObject`, `GetObject`, `ListBucket`,
`DeleteObject` and `AbortMultipartUpload` (R2's Object Read & Write token covers
them). It deletes only two things: the objects of an account that was erased or
wiped, once the grace window has ended, and its own connection-test object. A
deletion the bucket refuses is retried every night and shown in Admin →
Backups → Off-host. The admin wipe of every account deletes nothing in the
bucket.

**Retention.** The app never expires objects by age. Set a lifecycle rule on
the bucket that covers both the account objects and `database/` (for example,
expire all objects after 30 days); Admin → Backups says when there is none.

**Checking it works.** Admin → Backups → Off-host shows, per account, when the
last object landed: fresh, due (one night missed), stale (two missed), never,
or no record yet. A night that uploaded nothing for anybody fails the job with
the bucket's own error. Accounts pending deletion are not uploaded and are not
listed. On the 1st of each month at 04:11, a drill downloads the newest object
of every account, decrypts it and checks its shape and keys. It restores
nothing.

**Rotating the off-host key.** Put the new key in `BACKUP_ENCRYPTION_KEY`, move
the old one to `BACKUP_ENCRYPTION_PREVIOUS_KEYS`, restart. Remove the old key
once the lifecycle rule has expired every object written under it.

## Keys a copy needs

A copy carries the database's ciphertext as stored, so it needs the
application keys it was written under, also after a rotation. Keep a retired
`ENCRYPTION_KEYS` entry until no copy you may still restore needs it. **Admin →
Encryption → Keys the backups still need** lists them, the database dumps
included: a dump needs the key that was active when it was taken, for as long
as it is kept on this server or in the bucket. Off-host objects also need
`BACKUP_ENCRYPTION_KEY` (or the previous key that wrote them).

## Size and memory

Writing, reading and restoring a copy streams: the record goes through a page
at a time, documents one at a time, and a stored copy is kept as sealed pieces
of about a megabyte. Memory does not grow with the record. Give the app
container at least 1 GB.

`BACKUP_MAX_STORED_MB` (default 2048) caps one account's stored copy. An account
past it fails alone, keeps its previous copy, and is counted as
`records_oversized`; the message names the setting.

Both backup passes note which account they are on. An account whose last
attempt never finished (the process died under it) is taken last on the next
run and named in Admin → Backups, so one record too large for the container
cannot keep everyone else from a copy.
