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
| `BACKUP_RETENTION_DAYS` | no       | defaults to `30`                                                     |

## Bucket permissions

The worker needs `PutObject`, `GetObject` and `AbortMultipartUpload`. It never
calls `DeleteObject` on a backup key, so a compromised worker cannot wipe the
history; `AbortMultipartUpload` only reaches an upload that same worker started
and is what clears the parts of a run that failed halfway. Without it, a failed
upload leaves parts that are billed and do not show in a bucket listing. On
Cloudflare R2 the **Object Read & Write** token already covers all three.

## Bucket lifecycle (recommended)

The worker prunes objects older than `BACKUP_RETENTION_DAYS`, but the
storage provider's lifecycle rule is the canonical safety net:

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

## The weekly in-database backup (`data-backup`)

Separate from the off-host job above, and easy to confuse with it. A second
pg-boss job writes one `WEEKLY_AUTO` row per user into `data_backups.data` —
the same JSON document, gzipped and then encrypted under `ENCRYPTION_KEY` /
`ENCRYPTION_KEYS`, staying inside the instance. It is what
`/api/admin/backups/<id>/restore` reads.

### Container memory

This is the part that bites. The job runs inside the app process, so V8's heap
limit is the app's heap limit, and a container capped at 1 GB gives Node a
524 MB old-space limit by default. A long-lived record is bigger than it looks:
several hundred thousand measurements serialise to a JSON document of a few
hundred megabytes, and the writer used to need the object graph and that
document resident at the same time. On a seeded account of 445 000 measurements
under a 546 MB limit that is `FATAL ERROR: Reached heap limit` about thirty
seconds in — and since the job shares the process, the whole instance restarted
and every signed-in session on it went with it.

Two things changed, and both matter to an operator:

- **The writer streams.** The three tables that grow without bound —
  measurements, intake events, mood entries — are read a page at a time and
  serialised straight into gzip and the cipher, and every other section is
  released as soon as its JSON exists. On the same fixture doubled to 890 000
  measurements, the pass completes inside a 296 MB heap limit; before the
  change, half that record did not fit in 546 MB.
- **It stops itself, on its own size.** The envelope writer counts the
  encrypted bytes it has produced for an account and gives up on the account
  whose stored copy would not fit this process — a fifth of V8's heap limit,
  which is 105 MB on the 524 MB limit a 1 GB container gets. That backup then
  fails for that one account, is counted in the run's `users_failed` and
  `records_oversized` meta, and the pass carries on with everybody else. A
  memory failure is a failed job rather than a restart for every user on the
  host.

If `records_oversized` is non-zero in `job.data_backup`, the answer is more
memory, not a retry: raise the container's limit, or set
`NODE_OPTIONS=--max-old-space-size=<MB>` to something under it. The limit is
derived from the heap limit, so it rises with it.

The check deliberately reads bytes it produced and not the process's heap. A
version that read the heap shipped in v1.38.6 and compared the whole process's
live usage — garbage included — against 80 % of the limit. A Next.js server
that has been up for a week sits at 400 MB of largely collectable heap, so the
weekly pass aborted every account on the first chunk, including one whose whole
stored copy is 1.2 MB, and reported success while doing it. If you are on
v1.38.6, a `data-backup` run that finishes in seconds having backed up nothing
is that defect and not your record.

### The stored column is the remaining ceiling

`data_backups.data` is a single `text` column, so the finished artifact has to
exist as one value before it can be written — that copy cannot be streamed
away. It is the only thing left in the job that grows with the record: at a
compressed blob of ~42 MB the pass peaks around 236 MB, and the growth from
there is roughly twice the blob's size (the base64 answer, plus the driver's
copy of it on the way to the wire). That is the ceiling the size check is set
against — a fifth of the heap limit, so two copies plus the process's own live
set still fit — and an account that reaches it fails as a job with a message
naming both numbers. The fix at that point is to stop storing the artifact in
one column: chunk it across rows, or keep only the off-host copy. Reading it back has the same
shape, and worse: a restore parses the whole document, so the read path needs
several times the blob in heap. An operator restoring a very large account
should give the container more memory for the duration.

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
