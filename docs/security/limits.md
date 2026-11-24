# Limits

The rate limits, size caps, quotas and AI budgets the server enforces, per
account and per instance. Values are defaults; the ones an operator can change
name their variable. Upload limits per file type are in
[file handling](file-handling.md).

## How rate limits work

A limit is a fixed-window counter in Postgres (`rate_limits`), one atomic
upsert per check (`src/lib/rate-limit.ts`), so it holds across every web and
worker container. A refused request gets 429 with `Retry-After`; the bucket is
in the wide event's `rate_limit` field. Buckets are named
`<surface>:<identifier>`: the account (or the acting account under a grant)
for signed-in routes, the client address for anonymous ones, the token or
link hash for URL credentials.

Anonymous sign-in surfaces key on the client address resolved through the
trusted proxy chain. When that chain cannot be trusted, all anonymous callers
share one bucket of 100 per 15 minutes instead of each getting their own
([`self-hosting/reverse-proxy.md`](../self-hosting/reverse-proxy.md)).

## Every write

Every POST, PUT, PATCH and DELETE that resolves an account is charged to
`record-write:<account>`: **300 a minute** per account. A route is metered by
its guard, by a limiter of its own, or listed with a reason; the
structural test `src/__tests__/write-rate-limit-guard.test.ts` holds that. If
the counter cannot be read the write is let through (the auth surfaces below
fail closed instead).

## Sign-in and credentials

| Surface                                                  | Limit                                               | Keyed by                              |
| -------------------------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| Password sign-in                                         | 5 / 15 min, plus the per-account backoff            | address, account                      |
| Per-account backoff                                      | 5 failures a day free, then 30 s doubling to 15 min | account (or a hash of the typed name) |
| Registration                                             | 5 / 15 min                                          | address                               |
| Passkey sign-in (options, verify)                        | 10 / 15 min each                                    | address                               |
| Second-factor verify (TOTP, security key, recovery code) | 10 / 15 min; 5 attempts per ticket                  | address, ticket                       |
| Refresh, native hand-off token, SSO native token         | 10 / 15 min                                         | address                               |
| SSO start / callback; native hand-off completion         | 10 / 20 / 20 per 15 min                             | address                               |
| Step-up mint (re-proof)                                  | 20 / 15 min per address, 5 / 15 min per account     | address, account                      |
| Managed-profile claim / preview                          | 5 / 20 per 15 min                                   | address                               |
| Second-factor setup, confirm, disable, regenerate codes  | 5, 10, 5, 5 per 15 min                              | account                               |
| E-mail change                                            | 10 / hour                                           | account                               |
| Token mints (measurements, workouts, documents)          | 10 / min; at most 10 live tokens per kind           | account                               |
| MCP OAuth authorize / token / client registration        | 60 / 120 per 15 min, 20 / hour                      | address                               |
| Admin password reset                                     | 10 / min                                            | address                               |

## Data in and out

| Surface                                                                            | Limit                                                                                    | Keyed by         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| Batch ingest (measurements, workouts, mood, doses, cycle, nutrients, FHIR labs)    | 60 / min; at most 500 entries per request (workouts 100, FHIR labs 200); body 1 to 5 MiB | account          |
| ECG ingest                                                                         | 600 / min; 200 recordings, 32,768 samples each                                           | account          |
| Imports (JSON, CSV, labs CSV, medications CSV, dose history)                       | 5 / hour, shared; 16 MiB and 10,000 rows (labs 20,000, medications 500)                  | account          |
| Staged file imports (Apple Health, Health Connect, FIT, Gadgetbridge, FHIR bundle) | 5 / min per kind                                                                         | account          |
| Exports (every export route)                                                       | 10 / hour, shared                                                                        | account          |
| FHIR read face                                                                     | 120 / hour                                                                               | account          |
| Sync changes feed                                                                  | 120 / min                                                                                | account          |
| Document upload                                                                    | 60 / hour (browser), 120 / hour per scoped token (`DOCUMENT_UPLOAD_LIMIT_PER_HOUR`)      | account, token   |
| Document original download / thumbnails                                            | 240 / 3,000 per hour                                                                     | account          |
| Settings changes                                                                   | 60 / min per setting                                                                     | account          |
| Integration connect, sync, test, disconnect                                        | 5 to 20 / min; a full re-sync once an hour                                               | account          |
| Medication ingest endpoint                                                         | 60 / min per address and per token                                                       | address, token   |
| MCP requests / MCP writes                                                          | 120 / min, 60 / 5 min                                                                    | credential       |
| Share link create and change                                                       | 20 / hour; expiry at most 90 days, at most 50 documents per link                         | account          |
| Share link documents / report download                                             | 300 / 20 per hour                                                                        | link             |
| Calendar feeds, emergency card                                                     | 120 / hour per link; 600 / hour per address across these surfaces                        | link, address    |
| Notification quick answers                                                         | 20 / 10 min                                                                              | address, account |
| Sharing invitations / acceptances                                                  | 10 / hour, 30 / min                                                                      | account          |
| Webhooks (Withings, WHOOP, Telegram, deploy), CSP reports                          | 30 to 120 / min                                                                          | address          |

Request bodies pass the proxy only up to 1 MiB (`proxyClientMaxBodySize`,
`next.config.ts`); routes that take more stream their own bounded body, and
most routes set a smaller cap of their own (`parseJsonBody` with `maxBytes`,
413 beyond it).

## AI

| Limit                                          | Default                                        | Scope    | Setting                                       |
| ---------------------------------------------- | ---------------------------------------------- | -------- | --------------------------------------------- |
| Coach tokens a day, instance-paid key          | 200,000                                        | account  | fixed (`src/lib/ai/coach/budget.ts`)          |
| Coach tokens a day, the user's own key or plan | 2,000,000                                      | account  | fixed                                         |
| Share kept for interactive use                 | 20 % (background jobs may use 80 % of the day) | account  | fixed                                         |
| Coach messages / concurrent turns              | 20 / min, 2 at once                            | account  | fixed                                         |
| Insight generation                             | 10 / hour                                      | account  | `INSIGHTS_RATE_LIMIT_PER_HOUR`                |
| Insight output tokens                          | 2,500 (500 to 8,000)                           | instance | `INSIGHTS_MAX_TOKENS`                         |
| Regeneration after a sync                      | at most every 6 hours                          | instance | Admin setting, else `AI_SYNC_REGEN_GAP_HOURS` |
| Document AI reads                              | 6 / hour (1 to 1,000)                          | account  | `DOCUMENT_AI_LIMIT_PER_HOUR`                  |
| Document chat                                  | 20 / min                                       | account  | fixed                                         |
| Lab report and supplement label reading        | 6 / hour each                                  | account  | `LABS_OCR_LIMIT_PER_HOUR` (labs)              |
| Provider connection test                       | 5 / min, 50 / day                              | account  | fixed                                         |

Budgets are reserved before the provider call, so two parallel requests cannot
both spend the last tokens.

## Storage

| Limit                       | Default                      | Scope    | Setting                                |
| --------------------------- | ---------------------------- | -------- | -------------------------------------- |
| Document size per file      | 25 MiB (at most 100 MiB)     | instance | Admin, Documents                       |
| Document storage            | 1 GiB                        | account  | Admin, Documents; per-account override |
| Concurrent document uploads | 4 per process, 2 per account | process  | fixed                                  |
| Stored account copy         | 2,048 MB                     | copy     | `BACKUP_MAX_STORED_MB`                 |
| Local database dumps kept   | 7                            | instance | `DB_BACKUP_KEEP`                       |

Expensive work (imports, document reading, insight generation, backups,
rollup backfills) runs on the worker's queues rather than in the request; see
[`self-hosting/scaling.md`](../self-hosting/scaling.md).
