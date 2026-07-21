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
version = 0x01             (1 byte)
iv      = 12 random bytes  (AES-GCM nonce)
authTag = 16 bytes         (AES-GCM tag)
ciphertext = N bytes       (AES-256-GCM, key = BACKUP_ENCRYPTION_KEY)
plaintext  = JSON dump (UTF-8)
```

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
  "endpoint": "https://...r2.cloudflarestorage.com",
  "bucket": "healthlog-backups",
  "region": "auto",
  "putLatencyMs": 142,
  "getLatencyMs": 38,
  "ok": true
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
