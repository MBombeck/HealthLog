# v1.4.x follow-up issues

Items identified by the v1.4.1 audit pass that warrant deeper work
than a hardening release should land. Each one carries enough context
that a future contributor can pick it up without re-running the audit.

## Security — deferred

### S-FOLLOW-1 — Idempotency-Key concurrent duplicate side-effects (HIGH)

Audit reference: `~/infra/reports/v14-security-audit.md` H1.

The `withIdempotency()` wrapper currently does
`findCached → handler → persistCached`. Two requests with the same
`Idempotency-Key` arriving in parallel both miss the SELECT, both
execute the handler (duplicate measurements / intake events), and
one INSERT loses on the unique constraint silently. The CLAUDE.md
contract ("retries with the same Idempotency-Key … replay the
original response — no second side-effect") is therefore violated
whenever a flaky mobile client double-sends.

**Fix shape**: acquire the slot before the handler runs.
`INSERT … ON CONFLICT DO NOTHING RETURNING id` reserving the
`(userId, key, method, path)` row with a sentinel
`responseStatus = 0`, then UPDATE on completion; concurrent losers
SELECT-loop with backoff for the row to be filled. Or wrap the
whole request in a Postgres advisory lock keyed by hash(userId, key)
via `pg_advisory_xact_lock`.

Why deferred: needs a careful integration test against the new
testcontainers suite (two concurrent inserts → exactly one handler
invocation) and a public-API contract check that the
sentinel-status row never bleeds into a 2xx replay. Fits a v1.4.2
PR scope on its own.

---

### S-FOLLOW-2 — Encryption key fallback NODE_ENV gate (MEDIUM)

Audit reference: `~/infra/reports/v14-security-audit.md` M1.

`src/lib/crypto.ts:61-74` only requires the 64-hex production key
when `process.env.NODE_ENV === "production"`. A fresh Docker run
that forgets to set `NODE_ENV=production` (raw `node …` invocations,
some operator setups) silently accepts a 32-character key and pads
it deterministically with a SHA-256 of itself, halving the entropy
and making the resulting key recoverable from any leaked partial.

**Fix shape**: invert the gate to `NODE_ENV !== "development" &&
NODE_ENV !== "test"` — fail-closed by default — or require an
explicit `ALLOW_WEAK_DEV_KEYS=1` opt-in.

Why deferred: needs a migration note for self-hosters whose `.env`
files lack `NODE_ENV` (default Coolify deploys do set it; bespoke
setups may not). Worth a release note + .env.example call-out.

---

### S-FOLLOW-3 — Refresh-token reuse-detection serialisation (MEDIUM)

Audit reference: `~/infra/reports/v14-security-audit.md` M2.

`src/lib/auth/refresh-token.ts` reuse-detection is a `findUnique`
followed by a non-transactional `findMany + updateMany`. Concurrent
first-time refreshes can briefly have both clients holding
unrevoked access tokens before the loser's are revoked, and a
parallel reuse attempt doubles the audit-log noise.

**Fix shape**: wrap the rotation in a single `prisma.$transaction`
with `Serializable` isolation, OR reorder to "claim first, mint
second": `prisma.refreshToken.update({ where: { id, usedAt: null } })`
fails atomically if the row was already consumed; only after the
update succeeds, call `issueAccessAndRefresh`.

Why deferred: needs an integration test that fires N parallel
refreshes for the same token and asserts exactly one new pair is
issued. The testcontainers suite is the right home; v1.4.2 PR.

---

### S-FOLLOW-4 — moodLog webhook HMAC lookup column (MEDIUM)

Audit reference: `~/infra/reports/v14-security-audit.md` M3.

`src/app/api/integrations/moodlog/webhook/route.ts` performs an
O(n) AES-GCM decrypt sweep across all enabled users for every
webhook hit. Side-channels: timing oracle for ordering, DoS
amplification (30/min IP rate-limit × n decrypts).

**Fix shape**: add a `moodLogWebhookSecretLookupHash` column on
`User` (HMAC-SHA-256 keyed by `API_TOKEN_HMAC_KEY`, populated
alongside the encrypted secret on every write). Webhook does a
single indexed `findUnique` on the lookup hash, bypassing the
candidate iteration. The encryption stays as defence-in-depth.

Why deferred: schema migration required. Backfill needs a one-off
script that decrypts every existing row and writes the lookup
hash. Owners need to approve the migration window. v1.4.2 or
v1.5.

---

### S-FOLLOW-5 — moodLog `readMoodLogSecret` legacy fallback (MEDIUM)

Audit reference: `~/infra/reports/v14-security-audit.md` M4.

If `decrypt()` throws inside `src/lib/moodlog-secret.ts:27-37`, the
function returns the stored value as-is. Intent: legacy plaintext
rows keep working. Side effect: an attacker with read access to
the DB obtains the ciphertext blob and can submit it as the literal
webhook secret.

**Fix shape**: detect "looks like a v1.4 envelope"
(`/^[A-Za-z0-9_-]{1,32}\..+$/`) and refuse the legacy fallback for
envelope-shaped values. Log a metric so the rotation-on-write
contract can be verified to drain.

Why deferred: needs a small data-audit run to confirm no production
row has a non-envelope value before the strict check goes live.

---

### S-FOLLOW-6 — Restore script writes decrypted JSON with default permissions (MEDIUM)

Audit reference: `~/infra/reports/v14-security-audit.md` M5.

`scripts/restore-backup.ts:73-122` writes the decrypted JSON via
`writeFileSync(out, plaintext, "utf8")` with default mode (0644
typical). The file contains decrypted PHI for the restored user.

**Fix shape**:
`writeFileSync(out, plaintext, { encoding: "utf8", mode: 0o600 })`.
Optional: warn if `out` is in a world-readable directory.

Why deferred: tiny one-line fix; bundling with the next ops-script
update keeps the PR coherent.

---

## Performance — deferred

### P-FOLLOW-1 — Recharts top-level import on `/insights` (P0)

Audit reference: `~/infra/reports/v14-performance-audit.md` P0.

`src/app/insights/page.tsx:42-50` static-imports
`{ ScatterChart, Scatter, XAxis, … } from "recharts"` even though
`HealthChart` and `MoodChart` 8 lines above are already wrapped in
`dynamic(…, { ssr: false })`. The static import pulls the whole
recharts bundle into the route's first JS payload, defeating the
dynamic split.

**Fix shape**: extract the BP-mood scatter into
`src/components/charts/bp-mood-scatter.tsx` and import it via
`dynamic(…, { ssr: false })` like the others.

Why deferred: trivial mechanical change but needs a Lighthouse
before/after to quantify the bundle-size win for the v1.4.2
release notes.

---

### P-FOLLOW-2 — `/api/insights/targets` unbounded glucose history scan (P0)

Audit reference: `~/infra/reports/v14-performance-audit.md` P0.

`src/app/api/insights/targets/route.ts:600-604` pulls every glucose
measurement the user ever logged (no `gte: thirtyDaysAgo`) and
filters in JS. Diabetic users with multi-year history will
materialise tens of thousands of rows on every targets fetch.

**Fix shape**: split into "latest per context"
(`distinct: ["glucoseContext"], orderBy: { measuredAt: "desc" }`)
and a `measuredAt: { gte: thirtyDaysAgo }` window query, mirroring
the pattern at lines 102-121 for `latestEverByType`.

Why deferred: needs a per-context test asserting the new query
returns the same payload shape. Pairs nicely with the MoodEntry
index migration (P-FOLLOW-3).

---

### P-FOLLOW-3 — `MoodEntry @@index` is on `(userId, date)` not `(userId, moodLoggedAt)` (P0)

Audit reference: `~/infra/reports/v14-performance-audit.md` P0.

`prisma/schema.prisma:438` declares `@@index([userId, date])`, but
active queries sort/filter by `moodLoggedAt`:

- `src/app/api/insights/targets/route.ts:495`
- `src/app/api/insights/comprehensive/route.ts:52`
- `src/app/api/export/route.ts:87`

The unique constraint `@@unique([userId, date, moodLoggedAt])` is
not selectable by Postgres for windowed `moodLoggedAt`-range reads.

**Fix shape**: add `@@index([userId, moodLoggedAt])` (do NOT drop
the existing index — the unique still serves the moodlog webhook
upsert path). New migration `0026_moodentry_moodloggedat_index`.

Why deferred: schema migration. Owner approval for the migration
window.

---

### P-FOLLOW-4 to -7 — P1 / P2 perf items

- N+1 count() per medication on admin reminder-check
  (`src/app/api/admin/notifications/reminder-check/route.ts:84`).
  Replace with `groupBy` on `medicationIntakeEvent`.
- `/api/analytics` 8-parallel full-history scan
  (`src/app/api/analytics/route.ts:20-40`). Single `findMany` with
  `type: { in: types }` and JS-side group.
- `/api/import` sequential `prisma.measurement.create` per row
  (`src/app/api/import/route.ts:77-96`). Replace with
  `createMany({ skipDuplicates: true })`.
- `pairByTimestamp` not used in `/api/analytics` BP correlation
  (`src/app/api/analytics/route.ts:80-86`). Replace the quadratic
  loop with the helper from `@/lib/analytics/correlations`.

---

## Test-quality polish (5 minor items)

Audit reference: `~/infra/reports/v14-test-theatre-audit.md`.

- `src/app/api/gamification/__tests__/ios-format.test.ts` L111-112:
  upgrade `toBeDefined()` to shape predicates.
- `src/lib/analytics/__tests__/classifications.test.ts` L169-170:
  add `toMatch(/60/)` body-content assertion to compliance-alert tests.
- `src/lib/__tests__/idempotency.test.ts` L145: upgrade bare
  `toHaveBeenCalled()` to `toHaveBeenCalledWith({ where: …key… })`.
- `src/app/api/telegram/webhook/__tests__/route.test.ts` L457: same
  shape — upgrade or drop.

---

## i18n hardcoded strings

Audit reference: `~/infra/reports/v14-i18n-drift-audit.md`.

35+ hardcoded strings in `src/components/settings/ai-section.tsx`
need to be moved into `messages/{en,de}.json` keys. The settings
section was extracted in #143 with strings inline as a known
follow-up; this is the cleanup PR.

Why deferred: low blast-radius (only the AI provider settings page
shows English to a German user; the dashboard, dialogs, and
critical UX paths all flow through `t(…)`). v1.4.x or v1.5.

---

## Notes

These are the items the v1.4.1 audit identified that the hardening
release deliberately did NOT take. The audit also found 0 hallucinated
medical claims, 0 i18n key-parity gaps, and the test theatre rate
across the entire codebase was low (5 minor patterns). The codebase
is in healthy shape; this list is the punch-list for the next
proactive iteration, not a backlog of bugs we know about and ignore.
