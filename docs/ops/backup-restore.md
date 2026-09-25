# Off-host backup & restore

HealthLog ships with an optional daily off-host backup that ships every
user's JSON dump, encrypted with AES-256-GCM under a SEPARATE key
(`BACKUP_ENCRYPTION_KEY`), to any S3-compatible bucket — Cloudflare R2,
AWS S3, Backblaze B2, MinIO, etc.

The backup runs at **02:30 Europe/Berlin** every day from the worker
container (queue `data-backup-offhost`). Object key layout:

```
<bucket>/YYYY-MM-DD/user-<userId>.json.enc
```

## Wire format (binary)

```
magic   = "HLBK"           (4 bytes, ASCII)
version = 0x03             (1 byte)
iv      = 12 random bytes  (AES-GCM nonce)
ciphertext = N bytes       (AES-256-GCM over gzip(JSON dump), key = BACKUP_ENCRYPTION_KEY)
authTag = 16 bytes         (AES-GCM tag, trailing)
```

Three versions exist in the wild and all three restore. `0x01` encrypted the
JSON directly and `0x02` gzipped it first; both carry the tag in FRONT of the
ciphertext, which is what made them impossible to write a piece at a time —
GCM only produces the tag once the last block is in, so a leading tag means the
whole object has to exist before its first byte can be sent. `0x03` moves the tag to the end and changes nothing else: it still
covers every ciphertext byte, and the reader still verifies it before returning
a single byte of plaintext. Objects already in your bucket stay readable, and
the restore script needs no flag to tell them apart.

## Required env vars

| Var                     | Required | Notes                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY` | yes      | 64 hex chars or 32-byte base64. **Different from `ENCRYPTION_KEY`.** |
| `BACKUP_S3_ENDPOINT`    | yes      | e.g. `https://<account>.r2.cloudflarestorage.com`                    |
| `BACKUP_S3_BUCKET`      | yes      |                                                                      |
| `BACKUP_S3_ACCESS_KEY`  | yes      |                                                                      |
| `BACKUP_S3_SECRET_KEY`  | yes      |                                                                      |
| `BACKUP_S3_REGION`      | no       | defaults to `auto` (Cloudflare R2)                                   |
| `BACKUP_RETENTION_DAYS` | no       | not read by the app; the number for your bucket's lifecycle rule     |

## Bucket permissions

The worker needs `PutObject`, `GetObject` and `AbortMultipartUpload`. It never
calls `DeleteObject` on a backup key, so a compromised worker cannot wipe the
history; `AbortMultipartUpload` only reaches an upload that same worker started
and is what clears the parts of a run that failed halfway. Without it, a failed
upload leaves parts that are billed and do not show in a bucket listing. On
Cloudflare R2 the **Object Read & Write** token already covers all three.

## Bucket lifecycle (recommended)

The worker never deletes a backup object: its grant covers PutObject,
GetObject and AbortMultipartUpload only, so a compromised worker cannot
wipe the history, and nothing in the app reads `BACKUP_RETENTION_DAYS`.
Expiry is the storage provider's lifecycle rule, set to match the number
you wrote there:

```
Filter: "" (all objects)
Action: Expire after 30 days
```

For Cloudflare R2 add this from the bucket's **Settings → Lifecycle**.

## Smoke test

After deploying, hit `POST /api/admin/backup/test` (admin-only). It
performs a 1-byte PUT + GET round-trip and returns:

```json
{
  "data": {
    "endpoint": "https://...r2.cloudflarestorage.com",
    "bucket": "healthlog-backups",
    "region": "auto",
    "putLatencyMs": 142,
    "getLatencyMs": 38,
    "ok": true
  },
  "error": null
}
```

The credentials are never returned.

## Restore

Pick a key (e.g. `2026-05-08/user-clx123.json.enc`) from the bucket
and run the restore script with the same backup credentials and
encryption key the backup was written under — a freshly generated
`BACKUP_ENCRYPTION_KEY` cannot decrypt any existing object:

```bash
BACKUP_S3_ENDPOINT=https://...r2.cloudflarestorage.com       \
BACKUP_S3_BUCKET=healthlog-backups                           \
BACKUP_S3_ACCESS_KEY=...                                     \
BACKUP_S3_SECRET_KEY=...                                     \
BACKUP_S3_REGION=auto                                        \
BACKUP_ENCRYPTION_KEY=<the key the backup was written under> \
pnpm dlx tsx scripts/restore-backup.ts \
  2026-05-08/user-clx123.json.enc \
  /tmp/restored.json
```

Run this command from a source checkout with the production backup variables
exported. The script imports the full application dependency graph, which the
minimal production image does not expose as an operator scripting environment.

The script downloads the object, decrypts it, and writes the JSON dump
to disk. Importing the JSON back into a HealthLog instance is left to
the operator (use `prisma db seed` or a custom script).

Restoring is not streamed and does not need to be. It holds the whole document,
because the next thing anyone does with a backup is parse it as one JSON
object, and handing back plaintext the auth tag has not yet covered would trade
the authentication for memory. It runs on your machine rather than in the
container, so give it room: a record of several hundred thousand measurements
decompresses to a few hundred megabytes, and
`NODE_OPTIONS=--max-old-space-size=2048` in front of the command is enough for
a 445 000-measurement account.

### Restoring from the backups console

An admin can restore a stored snapshot from the browser instead of the shell.
`/admin/backups` lists one row per account and per backup type: **Backup now**
enqueues the `data-backup` pass for every account on the instance, **Download**
decrypts one snapshot and hands back the JSON, and **Restore** opens a dialog
that first shows what the file carries and then requires the word `RESTORE` to
be typed before it will run. The restore targets the account the snapshot was
taken for, never the admin running it, and it refuses a file whose declared
owner does not match the stored row. Instance-wide settings ride along only
when you tick _Also restore instance settings_ in the dialog; leave it clear to
restore the account alone.

A stored copy this instance can no longer open — the key that wrote it dropped
from `ENCRYPTION_KEYS` one rotation too early, or bytes that are not the ones
written — is refused by all three buttons with `422` and
`meta.errorCode = backup.payload.undecryptable`, before anything is read back.

### What a backup deliberately does not carry

Every credential-shaped row is left out, and this is not an oversight to fix:
API tokens, trusted devices, step-up elevations, known devices, clinician share
links, and the account grants behind shared record access. Restoring data is
rolling a record back to a known state. Restoring an authorization is different
in kind, because a grant the owner revoked on Tuesday would come back alive out
of Monday's file with nobody deciding it and neither person told.

What this means in practice depends on where you restore to.

**Onto the same instance.** Nothing changes. The restore replaces the account's
data tables and does not touch grants, tokens or devices, so shared access
carries on exactly as it was. Somebody who had read access before the restore
still has it afterwards, now looking at the restored data.

**Onto a fresh instance.** None of it comes with the file. Nobody has access to
anybody's record, every API token has to be reissued, every device re-trusted,
and both people have to invite and accept again before sharing works. That is
the fail-safe direction — access lost, never access resumed — and re-consenting
is the right amount of ceremony for handing someone your health record a second
time. Plan for it rather than discovering it.

The full per-model reasoning lives in `src/lib/export/backup-plan.ts`, where
every excluded model carries a written verdict and a structural test refuses to
let a new model land without one.

## Container memory (the nightly off-host job)

This is the part that bites, and it bit the nightly job a release after it bit
the weekly one. The job runs inside the app process, so V8's heap limit is the
app's heap limit, and a container capped at 1 GB gives Node a 524 MB old-space
limit by default. A long-lived Next.js server is already holding a large share
of that before the job starts.

The uploader used to build the whole backup JSON as one string, gzipped
that whole string, ran a whole-buffer cipher pass over the result and handed
the finished buffer to a single `PutObject` — four full copies of the record
alive at once. On an account of 445 000 measurements the JSON alone is 242 MB,
and the first configured run took the container down seventeen seconds in with
`FATAL ERROR: Reached heap limit`. Because the job shares the app process, one
account's size restarted the instance for everybody on it.

It streams now. The JSON is produced a page at a time, gzip and the cipher
consume it as it arrives, and the object goes up as a multipart upload that
holds two 8 MB parts. What the process holds is fixed by that pipeline's shape
rather than by the size of the record going through it: measured on the same
445 000-measurement account under `--max-old-space-size=450`, the old path
died and the new one finished holding tens of megabytes, writing a 9.1 MB
object that restores to the identical record.

One ceiling remains, and it is structural rather than a memory bound: a
multipart upload carries 10 000 parts, so 80 GB is the largest object one
account can produce. Past it the account's backup fails with a clear refusal,
is counted in the run's `offhost_backup_oversized` meta, and the pass carries
on with everybody else.

### Reading a failed run

A nightly run that could not upload for **anybody** now fails the pg-boss job
instead of reporting success. This is the case wrong credentials, a missing
bucket and an unreachable endpoint all land in, and the target's own sentence
rides out as the failure cause — `The request signature we calculated does not
match the signature you provided`, `The specified bucket does not exist`,
`connect ECONNREFUSED`. Check `offhost_backup_uploaded` against
`offhost_backup_total_users`: before this change a run where every single
upload failed still read `ok: true`, so a bucket could stay empty while the
jobs page looked healthy.

A run where SOME account got a copy still succeeds, with the rest counted in
`offhost_backup_failed`. Failing the whole queue over one account's object
would re-upload everybody's on every retry.

### Which account has no copy

The counts above say how many accounts were uploaded, never which. An account
whose object has failed every night for a month reads as `99 uploaded, 1
failed` each time, which looks like weather.

**Admin console → Backups → Off-host copies** answers it per account: when this
host last put that account's encrypted copy in the bucket, how big it was, and
how that compares with the nightly schedule. **Fresh** is inside one run,
**due** means one run produced nothing for that account, **stale** means two
did not, **never** means a run walked the account and no object has ever
landed for it, and **no record yet** means no run has recorded the account at
all. On a host without `BACKUP_S3_*` the card says off-host backup is not
configured and stops there.

The ledger starts empty on the release that adds it, so on a host that has
been uploading nightly for months every account reads **no record yet** until
the first run after the upgrade. That is the ledger having no history, not the
bucket being empty — which is why it is a separate word from **never**, and
why the row says so rather than claiming nothing has ever reached the bucket.

Each verdict carries six hours of slack on top of the schedule's own 24, and
that slack is load-bearing on two nights. The cron runs at 02:30 Europe/Berlin,
so on the DST fall-back Sunday two consecutive runs are 25 hours apart; and the
timestamp is when _that account's_ object landed, so on a cohort walked one
account at a time an account reached later tonight than last night drifts by
hours. Without the slack a healthy host would paint its whole cohort **due**
once a year.

The verdicts come from a ledger the worker writes when the object lands
(`offhost_backup_state`), not from a listing of the bucket. Keep the worker's
grant as documented — PutObject, GetObject, AbortMultipartUpload — and the card
still tells the truth. A row that goes stale while the run reports success is
that account's object being refused, and the reason is in the run's
`offhost_backup_failures` meta.

## The weekly in-database backup (`data-backup`)

Separate from the off-host job above, and easy to confuse with it. A second
pg-boss job writes one `WEEKLY_AUTO` copy per user into the database, the same
JSON document, gzipped and then encrypted under `ENCRYPTION_KEY` /
`ENCRYPTION_KEYS`, staying inside the instance. It is what
`/api/admin/backups/<id>/restore` reads, and an uploaded backup file is stored
the same way.

### How a copy is stored

From v1.39.2 a copy is kept as ordered pieces of about a megabyte in
`data_backup_chunks`, with the list of pieces on its `data_backups` row. The
writer produces the JSON a page at a time, gzips it as it goes and seals each
megabyte of gzip output on its own with AES-256-GCM. Reading it back (restore,
preview, download) takes the pieces one at a time. Nothing on either path holds
the whole copy, so the size of a copy has nothing to do with the app's memory.
Measured on an account of 2.6 million readings in the default 1 GB container,
with the web server and the worker in one process: the backup took 87 seconds
and stored 97 MB in 96 pieces, the preview 20 seconds, the download of the
1.4 GB file 25 seconds, and the restore 264 seconds, which gave back every
reading exactly. The container peaked at 567 MB and did not restart. What the
backup, preview and download hold on top of the running app stays at a few tens
of megabytes and does not grow with the account. A 512 MB container is too
small for the app itself: its heap limit is 259 MB and a backup of any account,
even one with 130 000 readings, runs it out of heap.

Each piece carries, inside its encryption, which copy it belongs to, its
position, and whether it is the last. Before a restore deletes anything, every
piece is checked: a piece that is missing, moved, altered, taken from another
copy, or a copy that stops short of its last piece is refused with
`backup.payload.undecryptable`, and the account is left as it was.

The write is one transaction. Until the new copy is complete the previous one
stays in place and readable; a run that fails halfway leaves it untouched. A
second backup of the same account started while one is running (a manual run
during the weekly one, say) waits for the first to finish and then replaces
its copy; neither leaves a partial copy behind.

While a restore of an account's copy is queued or running, the weekly and
manual backup leave that account's copy alone and back up everyone else. The
run's `users_skipped_restoring` meta counts such accounts; the next run
replaces the copy as usual. If a copy is replaced anyway while it is being
read (a download or preview in progress when the weekly run finishes), the
reader answers `409` with `backup_changed` and "The backup was replaced by a
newer one while it was being read", not the undecryptable error, and a restore
rolls back with nothing changed. Start it again to use the new copy. A
download already sending when this happens stops partway; download again.

Copies written before v1.39.2 are a single value in `data_backups.data` and
still restore, preview and download as they did. The next weekly run replaces
the weekly copy in the new form, and a key rotation (below) converts every
remaining one, including uploaded copies. Until then those older copies are
read as one value, as before, which needs the memory they needed when they were
written.

Migration 0352 cannot be undone by going back to v1.39.1. That release reads
only the single value, so it finds a copy in pieces empty, and if it writes a
weekly copy into a row that has pieces, the row holds both forms. v1.39.2 then
refuses to read that row, because nothing says which of the two is current
("This backup holds both a single stored value and pieces ..."); the next
weekly backup replaces it. If you must go back, restore the database backup
you took before upgrading.

### The size limit

The one limit left is on storage: a copy of one account may take at most
`BACKUP_MAX_STORED_MB` megabytes (default 2048). It exists so a runaway copy
fails with a message instead of filling the database volume, which holds the
old and the new copy side by side while a backup runs. An account past it fails
for that account alone, is counted in the run's `users_failed` and
`records_oversized` meta, and keeps its previous copy; the pass carries on with
everybody else. The message names the setting. Raise it in `.env`, recreate the
app container, and make sure the database volume has room for two copies of
that size.

Before v1.39.2 the limit was a fifth of the app's heap, 105 MB in a 1 GB
container, because the copy had to pass through the app as one value. An
account with 1.75 million readings was past it, and the only way round was more
memory. That is no longer the case: `records_oversized` means the storage limit,
never memory.

The writer deliberately reads no heap gauge. A version that did shipped in
v1.38.6 and compared the whole process's live usage, garbage included, against
80 % of the limit. A Next.js server that has been up for a week sits at 400 MB
of largely collectable heap, so the weekly pass aborted every account on the
first chunk, including one whose whole stored copy is 1.2 MB, and reported
success while doing it. If you are on v1.38.6, a `data-backup` run that finishes
in seconds having backed up nothing is that defect and not your record.

### Key rotation

`scripts/rotate-encryption-key.ts` and the rotation in the admin console
re-seal every piece under the active key, in small batches, without reading
the backup inside. The link between a piece, its copy and its position is
inside the encryption, so it comes through rotation unchanged.

A copy still in the older single-value form (any of them, including the
`~hlgcm1.` form v1.38.6 to v1.39.1 wrote) is not re-sealed in place, which would need the
whole copy in memory several times over. Rotation converts it into pieces
under the active key instead, one copy at a time, reading the stored value a
few megabytes at a time; the copy keeps its date. The conversion of a copy is
one transaction, so a copy that fails its check is left exactly as it was and
counted as an error. Rotation up to v1.39.1 counted every `~hlgcm1.` copy
as an error; run it again after updating before retiring the old key.

### What a restore replaces

A restore replaces the account's data tables; it does not merge into them.
Every row the file carries is written back under its original id, and every row
the account gained after the snapshot was taken — readings, doses, mood
entries, documents — is deleted with the rest of the class before the file is
read back. Restoring Monday's copy on Wednesday therefore costs the account
everything it recorded on Tuesday. If the current state is worth keeping, take
a fresh snapshot from the backups console before restoring the old one.

## Monthly restore drill (automatic)

Since v1.16.4 a pg-boss job (`data-restore-drill`, cron `11 4 1 * *` —
04:11 on the 1st of each month) exercises the read path end-to-end:
fetch the most recent backup object from the bucket, decrypt it under
the current `BACKUP_ENCRYPTION_KEY`, JSON-parse it, and sanity-check
the payload shape. It performs **no database restore** — it validates
the artefact, not the import path.

Outcomes:

- **Success** — record counts, object age, and sizes land in the
  wide-event meta (`job.restore_drill`).
- **Stale chain** — the newest object is older than 3 days: the nightly
  uploader has stalled (or the lifecycle rule is too aggressive). The
  drill pages via the worker error reporter (stderr + GlitchTip).
- **Failure** — empty bucket, fetch error, decryption failure (wrong or
  rotated key), malformed JSON: pages the same way. A decryption
  failure right after a `BACKUP_ENCRYPTION_KEY` change means the new
  key cannot read the existing objects — re-encrypt or accept that
  pre-rotation backups are only readable with the retired key.
- **Not configured** — deployments without the `BACKUP_S3_*` vars skip
  silently (wide-event warning only).

The drill needs no IAM grant beyond the uploader's existing
`GetObject` + `ListBucket`.
