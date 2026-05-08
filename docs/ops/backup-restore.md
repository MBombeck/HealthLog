# Off-host backup & restore (v1.4 G1)

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
and run:

```bash
BACKUP_S3_ENDPOINT=https://...r2.cloudflarestorage.com \
BACKUP_S3_BUCKET=healthlog-backups                     \
BACKUP_S3_ACCESS_KEY=...                               \
BACKUP_S3_SECRET_KEY=...                               \
BACKUP_S3_REGION=auto                                  \
BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)          \
pnpm tsx scripts/restore-backup.ts \
  2026-05-08/user-clx123.json.enc \
  /tmp/restored.json
```

The script downloads the object, decrypts it, and writes the JSON dump
to disk. Importing the JSON back into a HealthLog instance is left to
the operator (use `prisma db seed` or a custom script).
