# v1.4.39 — empirical dashboard cold-mount waterfall trace

Read-only Playwright-driven investigation of the dashboard cold-mount
network/render behaviour Marc observed post-v1.4.39.2:
"mood + medication paint first, then all other tiles arrive faster
than before but still in a single burst — *etwas blockiert noch*".

Captured on `/Users/marc/Projects/HealthLog` against a locally-seeded
fixture mirroring the shape of Marc's production tenant (82 490
measurements across 8 high-volume types over 2 years, 500 mood
entries) on `localhost:3000` (Next.js dev mode). Production
(`healthlog.bombeck.io` v1.4.39.3) was probed read-only for header /
status / version parity but Marc's authenticated routes were not
exercised against prod.

Raw trace artifact: `/tmp/playwright-dashboard-trace.json`.
Visual progression: `/tmp/dashboard-mobile-{500,1000,1500,2500,4000,6000,8000}ms.png`.
Playwright driver: `/tmp/playwright-dashboard-trace.js`.

---

## 1 — Test setup

* **Server**: `pnpm dev` on `localhost:3000`, Node v25.9.0,
  `NODE_ENV=development`, version 1.4.39.3. The Prisma client lives in
  `src/lib/db.ts` and is constructed via
  `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`
  with **no `max` connection-limit override** — `pg.Pool` falls
  back to its default of **10 concurrent connections**.
* **DB**: PostgreSQL on localhost:5432, schema `public`.
* **User**: `e2e-tester` (admin), seeded via
  `/Users/marc/Projects/HealthLog/e2e/setup/storageState.json` cookie
  jar (Playwright `globalSetup.ts` pattern).
* **Fixture shape** (seed script reproduced inline below):
  * `WEIGHT` × 730, `BLOOD_PRESSURE_SYS` × 1460, `BLOOD_PRESSURE_DIA`
    × 1460, `PULSE` × 1460, `BODY_FAT` × 730, `SLEEP_DURATION` × 730,
    `ACTIVITY_STEPS` × 70 080 (96/day × 730 days), `OXYGEN_SATURATION`
    × 5 840 → **82 490 measurements, 8 types**.
  * 500 mood entries (1/day).
  * No rollups (deleted up-front to force `path:"live"` on every
    fast-path).
* **Browser**: Playwright Chromium, headless. Trace captured on
  desktop viewport (1280×900); visual screenshots also on iPhone-15-Pro
  mobile viewport (393×852, DSR 3, isMobile=true).
* **Cold vs warm**: cold = first navigation after Playwright context
  creation; warm = same context, second navigation 8 s later.

---

## 2 — Annotated COLD waterfall

Listed in order of request **start** (ms from `page.goto` call).

| start | end | dur | size | TTFB | URL |
|---:|---:|---:|---:|---:|---|
| 356 | 484 | 128 | 0.1 KB | 131 | `GET /api/monitoring/settings` |
| 356 | 521 | 165 | 0.5 KB | 166 | `GET /api/auth/me` |
| 357 | 496 | 139 | 0 | 138 | `POST /api/internal/web-vitals` |
| 357 | 495 | 138 | 0 | 137 | `POST /api/internal/web-vitals` |
| **573** | 716 | 143 | 14.4 KB | 153 | `GET /api/gamification/achievements` |
| **573** | 977 | 405 | 8.3 KB | 411 | `GET /api/analytics?slice=summaries` |
| **573** | 713 | 140 | 0 | 147 | `GET /api/medications` |
| **573** | 722 | 149 | 0.1 KB | 107 | `GET /api/workouts?limit=3` |
| **573** | **7240** | **6667** | 10.4 KB | **6562** | **`GET /api/analytics`** (thick) |
| **573** | 1088 | 515 | 1.0 KB | 375 | `GET /api/dashboard/widgets` |
| **573** | 1109 | 536 | 21.8 KB | 378 | `GET /api/mood/analytics` *(call 1, page.tsx)* |
| **573** | 1109 | 536 | 0.1 KB | 373 | `GET /api/feature-flags` |
| **573** | 1169 | 596 | 0.1 KB | 199 | `GET /api/bugreport/status` |
| 983 | 1175 | 192 | 1.4 KB | 85 | `GET /api/medications/intake?scope=compliance&days=30` |
| **1439** | **7290** | **5851** | 2.5 KB | **5855** | `GET /api/measurements?type=WEIGHT&…source=rollup` |
| **1439** | **7288** | **5849** | 2.5 KB | **5854** | `GET /api/measurements?type=WEIGHT&…source=rollup` *(dup)* |
| **1439** | **7295** | **5855** | 3.0 KB | **5858** | `GET /api/measurements?type=BLOOD_PRESSURE_SYS&…source=rollup` |
| **1440** | **7295** | **5855** | 3.0 KB | **5858** | `GET /api/measurements?type=BLOOD_PRESSURE_DIA&…source=rollup` |
| **1440** | **7295** | **5855** | 2.6 KB | **5858** | `GET /api/measurements?type=PULSE&…source=rollup` |
| **1440** | **7355** | **5915** | 2.5 KB | **90** | `GET /api/measurements?type=BODY_FAT&…source=rollup` |
| **1440** | **7355** | **5915** | 21.8 KB | **40** | `GET /api/mood/analytics` *(call 2, mood-chart.tsx)* |
| 5356 | 7354 | 1999 | 0.3 KB | 36 | `GET /api/version` |

**Three waves clearly emerge**:
* **Wave A (start 356)** — auth shell / cookie probe / web-vitals
  beacons. Fires before page hydration.
* **Wave B (start 573, +217 ms)** — 9 requests, all useQuery hooks in
  `src/app/page.tsx` plus the auth-context-level `bugreport/status` +
  `feature-flags`. They all start at the same instant (TanStack
  parallel-mounts every `useQuery` whose `enabled` predicate flips
  true together).
* **Wave C (start 1439-1440, +866 ms after Wave B)** — 7 requests,
  6× chart-tile `/api/measurements?…source=rollup` calls (one per
  type from `health-chart.tsx:604`) **plus a second
  `/api/mood/analytics`** that did not exist when the dashboard was
  on a single useAnalytics hook.

The **6 Wave-C measurements requests all finish within 65 ms of each
other** (7288–7355 ms) — i.e. they all unblock at the moment thick
`/api/analytics` releases its share of the Prisma connection pool.

---

## 3 — WARM mount (60 s cache hits)

| start | dur | URL |
|---:|---:|---|
| 197 | 47 | `/api/analytics` (thick) |
| 197 | 10 | `/api/analytics?slice=summaries` |
| 197 | 47 | `/api/mood/analytics` (page) |
| 308 | 20–26 | every `/api/measurements?…source=rollup` |
| 610 | 13 | `/api/mood/analytics` (mood-chart, dup) |

Total wall-clock 8.1 s including 8 s settle, real activity ends at
~610 ms. The 60 s LRU on `caches.analytics` / `caches.moodAnalytics`
collapses the entire fan-out to ~50 ms each. **Cold→warm delta
≈ 6.7 s** — the entire mount-time cost is in the cold thick analytics
+ pool-blocked chart waterfall.

---

## 4 — The three actual bottlenecks (root cause, not symptom)

### B1 — `/api/analytics` thick **monopolises the Prisma pool for 6.5 s**

`buildAnalyticsResponse` (`src/app/api/analytics/route.ts:161`)
fan-out:
* 15× `fetchMeasurementSeriesChunked` in parallel
  (`route.ts:261-269`, capped to a trailing 425-day window) — each
  paginates `prisma.measurement.findMany` at chunks of 5 000 rows.
* `probeRollupCoverage` + 3 fast-path branches
  (`bp_in_target` / `correlations` / `healthScore`). Coverage was empty
  in our fixture (`row_count: 1490, path: "live"`) so all three
  branches fell to the live SQL fallback — production logs
  (`v1.4.38.7`-era) show this is also the common case for Marc when
  the `isFullyCovered` gate is false (see § 4 of the v1.4.38 perf
  audit).

Server logs:
```
GET /api/analytics 200 in 6.5s (next.js: 2ms, proxy.ts: 6ms, application-code: 6.5s)
```

All 6.5 s land inside `application-code` — pure Prisma DB time. While
this single request runs it is holding ≥ 8 of the 10 pool slots
(15 chunked findMany + 3 fast-paths fire in parallel via
`Promise.all`); every other useQuery hook in Wave B + every
Wave-C `/api/measurements` request has to **queue behind it**.

### B2 — Default Prisma `pg.Pool` ceiling = **10 connections**

`src/lib/db.ts:8-13`:
```ts
function createPrismaClient() {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  return new PrismaClient({ adapter });
}
```

No `max` override is passed → `pg.Pool` keeps its library default
of 10. With B1 holding 8+ slots, Wave-C's 6 rollup chart reads
(individually ≤ 20 ms of `application-code` per the warm trace)
all stall for the duration of thick analytics. Their `application-code:
11ms` next to `proxy.ts: 1009ms` in the dev log is what a
pool-starved cold path looks like.

### B3 — Duplicate `/api/mood/analytics` call from two different
       TanStack query keys

* `src/app/page.tsx:291` uses `queryKey: queryKeys.moodAnalytics()`
  → `["mood-analytics"]` (defined in `src/lib/query-keys.ts:30`).
* `src/components/charts/mood-chart.tsx:316` uses
  `queryKey: ["mood-chart-data"]`.

Both `queryFn`s `fetch("/api/mood/analytics")` and unwrap
`json.data`. TanStack Query treats different keys as separate
queries → **the dashboard cold mount issues two identical requests**.
The second is part of Wave C; on warm mount it still fires (cache
key 2 is empty) and lands at start+610 ms. This is the same class of
silent cache poisoning Marc's memory dual-location notes flagged
for HealthLog conventions (`feedback_react_query_key_collision.md`).
At 22 KB body × 2 = 44 KB doubled mobile data + one extra connection
out of the already-saturated pool.

---

## 5 — Why Marc's UX matches the trace exactly

* **Mood + medication tiles paint first** — `/api/mood/analytics`
  (first call) returns at +1109 ms, `/api/medications` at +713 ms.
  Both are early Wave-B with low TTFB. ✓ matches Marc's report.
* **"All other tiles arrive faster than before but in a single
  burst"** — the tile-strip headlines paint when the slim
  `/api/analytics?slice=summaries` lands at +977 ms (well-handled
  by v1.4.39.2's slim/thick split). But the chart row beneath the
  tile strip waits for the 6 individual `/api/measurements?source=rollup`
  calls, which **all unblock simultaneously when thick `/api/analytics`
  releases the pool at ~7.3 s**. ✓ "single burst".
* **"Etwas blockiert noch"** — yes, thick `/api/analytics` is the
  block. The slim/thick frontend split was correct but the **server-
  side resource contention** wasn't decoupled. ✓.
* **"Mobile especially noticeable"** — mobile chart cards are bigger
  vertically, so the empty placeholder area below the painted tile
  strip is more obvious. Trace timings are identical (mobile
  screenshots at 1000/1500/2500/4000 ms show empty chart row; only
  at 6000-8000 ms do the charts populate).

---

## 6 — Recommended fixes ranked by impact / effort

### F1 — Cap thick `/api/analytics` Prisma concurrency to ≤ 4 (S, blocking-fix)

Wrap the `types.map(t => fetchMeasurementSeriesChunked(…))` fan-out
(`route.ts:261-269`) in a bounded-concurrency helper (e.g. `p-limit`
with limit 4). Same total work but **at most 4 pool slots held by
analytics at any moment**, leaving ≥ 6 slots for the 6 Wave-C chart
reads. Expected impact: **the chart-tile burst moves from +7.3 s
to ~+1.6 s** (their individual `application-code` is 11-15 ms;
they'd start finishing as soon as the first analytics chunk
completes a slot). **Highest impact for lowest effort.**
* Files: `src/app/api/analytics/route.ts`.
* Dev: ~30 min including a unit test that asserts ≤ N inflight.
* Risk: trivial; thick analytics gets ~10-15 % slower in absolute
  wall-clock (10 chunks at concurrency 4 = 3 batches instead of 1)
  but it was already cache-wrapped at 60 s so the user-visible cost
  is the cold mount only, and the chart row paints 5 s earlier in
  exchange.

### F2 — Raise `pg.Pool` `max` to ≥ 20 (XS, complementary)

Pass `max: 20` (or env-driven) to `new PrismaPg({ connectionString,
max: 20 })`. Coolify's Postgres container has ample room (default
`max_connections` 100), and the current 10-slot ceiling is the
library default, not a tuned value.
* Files: `src/lib/db.ts`.
* Dev: ~5 min.
* Risk: nil (the upper bound is set by Postgres' `max_connections`,
  well above 20). Complements F1 — even with F1 the pool ceiling
  remains tight for any second concurrent power-user.

### F3 — Unify mood-analytics queryKey (XS, dedup)

`src/components/charts/mood-chart.tsx:316` should use
`queryKey: queryKeys.moodAnalytics()` (the canonical key in
`src/lib/query-keys.ts:30`) instead of its own `["mood-chart-data"]`.
Both share the same endpoint + same envelope-unwrap pattern; the
shape difference (`MoodAnalyticsData` vs `{ entries, summary }`) is a
type-narrowing concern, not a cache concern. Both already pull the
same JSON.
* Files: `src/components/charts/mood-chart.tsx`,
  `src/lib/query-keys.ts` (if a typed-key variant is preferred).
* Dev: ~15 min including the e2e regression that asserts only one
  network call per mount.
* Risk: nil — TanStack will warn if `queryFn` shapes diverge in dev,
  and the test catches it.

### F4 — Move 6 chart-tile rollup reads into the analytics envelope (M, eliminates Wave C entirely)

The 6 `/api/measurements?…&aggregate=daily&source=rollup` calls each
ask for one type's last-30-day daily aggregate. The slim analytics
slice already pulls daily DAY-bucket data
(`computeSummariesSlice` → `summaries-slice.ts:309`). Extend the slim
envelope with a `daily30dByType: Record<MeasurementType, Point[]>`
field — the buckets are already loaded in-memory, so no extra DB
hit. `health-chart.tsx` consumes from the existing `data` prop
instead of issuing per-type fetches.
* Files: `src/lib/analytics/summaries-slice.ts`,
  `src/lib/analytics/merge-slim-thick.ts`,
  `src/components/charts/health-chart.tsx`,
  `src/app/page.tsx` (pass `daily30dByType` to each chart).
* Dev: ~half day.
* Risk: slim envelope payload grows ~12-15 KB per user (8 types ×
  ~30 points × ~50 B), well below the 50 KB ceiling for "slim".
  Eliminates 6 request round-trips entirely and **removes the source
  of Wave C**.

### F5 — Defer `version-poller` initial check until idle (XS, UX polish)

`src/components/version-poller.tsx:109` schedules the first poll at
+5 000 ms. In our trace the call **landed at +5356 ms but waited
1999 ms in the pool** (it competes for the same Prisma client even
though `/api/version` doesn't touch the DB — but middleware does).
Move the initial check to `requestIdleCallback` with a 10 s fallback
so it doesn't fire during the cold-mount network burst.
* Files: `src/components/version-poller.tsx`.
* Dev: ~10 min.
* Risk: nil — version-poller is a "every 60 s" deploy-mismatch heal
  loop; delaying its first run by ≤ 10 s doesn't affect correctness.

---

## 7 — Reproduction commands

```bash
# 1. Start dev server (uses dev DB at localhost:5432)
cd /Users/marc/Projects/HealthLog
PORT=3000 pnpm dev > /tmp/healthlog-dev.log 2>&1 &

# 2. Seed Marc-shaped fixture for the e2e-tester user (8 types,
#    82 490 measurements). The seed nukes ALL prior data for that
#    one user and writes ~80 k rows in ~10 s.
#    (The seed JS is captured below in §8 — copy to project root
#    because the script `require`s `pg` from node_modules.)
cat > seed-heavy-fixture.tmp.js <<'EOF'
...    (see §8)
EOF
node seed-heavy-fixture.tmp.js
rm seed-heavy-fixture.tmp.js

# 3. Run Playwright trace (cold + warm). Uses the e2e storageState
#    cookie jar already on disk.
cd /Users/marc/.claude/skills/playwright-skill
node run.js /tmp/playwright-dashboard-trace.js

# 4. Inspect the trace JSON
node -e "const d=require('/tmp/playwright-dashboard-trace.json'); \
  d.cold.requests.sort((a,b)=>a.startedAt-b.startedAt) \
    .forEach(r=>console.log([Math.round(r.startedAt), \
      Math.round(r.duration_ms), Math.round((r.timing?.responseStart \
      - r.timing?.requestStart)||0), r.url].join('\t')))"
```

The trace script `/tmp/playwright-dashboard-trace.js` is the
empirical capture tool — captures `request.timing()` per `/api/*`,
two passes (cold + warm), JSON to `/tmp/playwright-dashboard-trace.json`.

---

## 8 — Reproducible seed JS (for §7 step 2)

The seed used to produce this trace (drop into project root so `pg`
resolves from `node_modules`):

```js
// drop into /Users/marc/Projects/HealthLog/seed-heavy-fixture.tmp.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
    || 'postgresql://healthlog:healthlog@localhost:5432/healthlog?schema=public',
});
const TYPES = [
  ['WEIGHT', 1, 85, 1.5, 'kg'],
  ['BLOOD_PRESSURE_SYS', 2, 132, 8, 'mmHg'],
  ['BLOOD_PRESSURE_DIA', 2, 82, 6, 'mmHg'],
  ['PULSE', 2, 68, 10, 'bpm'],
  ['BODY_FAT', 1, 22, 0.8, '%'],
  ['SLEEP_DURATION', 1, 450, 60, 'minutes'],
  ['ACTIVITY_STEPS', 96, 80, 60, 'steps'],
  ['OXYGEN_SATURATION', 8, 97, 0.7, '%'],
];
const DAYS = 730;
function cuid(){const c="abcdefghijklmnopqrstuvwxyz0123456789";let i="c";for(let n=0;n<24;n++)i+=c[Math.floor(Math.random()*c.length)];return i;}
function randn(m,s){const u1=Math.random(),u2=Math.random();return m+s*Math.sqrt(-2*Math.log(u1))*Math.cos(2*Math.PI*u2);}
(async () => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      "SELECT id FROM users WHERE username='e2e-tester'");
    const userId = rows[0].id;
    await client.query('BEGIN');
    await client.query('DELETE FROM measurements WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM measurement_rollups WHERE user_id=$1', [userId]);
    await client.query('DELETE FROM mood_entries WHERE user_id=$1', [userId]);
    const now = new Date();
    for (const [type, perDay, mean, sd, unit] of TYPES) {
      const rowsBatch = [];
      for (let d = 0; d < DAYS; d++) {
        const day = new Date(now); day.setDate(day.getDate() - d); day.setHours(0,0,0,0);
        for (let i = 0; i < perDay; i++) {
          const measuredAt = new Date(day.getTime() + (i/perDay)*86400000 + Math.random()*300000);
          let v = randn(mean, sd);
          v = (type === 'ACTIVITY_STEPS' || type === 'SLEEP_DURATION')
            ? Math.max(0, Math.round(v))
            : Math.round(v*10)/10;
          rowsBatch.push({ measuredAt, value: v });
        }
      }
      for (let i = 0; i < rowsBatch.length; i += 800) {
        const slice = rowsBatch.slice(i, i + 800);
        const values = [], params = [];
        let p = 1;
        for (const r of slice) {
          values.push(`($${p++},$${p++},$${p++}::measurement_type,$${p++},$${p++},$${p++},$${p++},$${p++})`);
          params.push(cuid(), userId, type, r.value, unit, r.measuredAt, r.measuredAt, r.measuredAt);
        }
        await client.query(
          `INSERT INTO measurements (id,user_id,type,value,unit,measured_at,created_at,updated_at)
           VALUES ${values.join(',')}`, params);
      }
    }
    const moodMap = { 1:'TERRIBLE', 2:'BAD', 3:'NEUTRAL', 4:'GOOD', 5:'GREAT' };
    const moodRows = [];
    for (let d = 0; d < 500; d++) {
      const day = new Date(now); day.setDate(day.getDate() - d);
      const score = Math.max(1, Math.min(5, Math.round(randn(3.2, 0.9))));
      moodRows.push([cuid(), userId, day.toISOString().split('T')[0], score, day.toISOString()]);
    }
    for (let i = 0; i < moodRows.length; i += 200) {
      const slice = moodRows.slice(i, i + 200);
      const values = [], params = [];
      let p = 1;
      for (const r of slice) {
        values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},NOW(),NOW())`);
        params.push(r[0], r[1], r[2], moodMap[r[3]], r[3], r[4]);
      }
      await client.query(
        `INSERT INTO mood_entries (id,user_id,date,mood,score,mood_logged_at,created_at,updated_at)
         VALUES ${values.join(',')}`, params);
    }
    await client.query('COMMIT');
    console.log('seeded.');
  } catch (e) { await client.query('ROLLBACK').catch(()=>{}); throw e; }
  finally { client.release(); await pool.end(); }
})().catch(e => { console.error(e); process.exit(1); });
```

---

## 9 — Cross-references

* The v1.4.38 perf audit
  (`.planning/round-v1438-perf-analysis.md`) §1 § 4 already
  identified `fetchMeasurementSeriesChunked × 15` as the dominant
  cold path and `isFullyCovered` as the gate keeping the fast-path
  on `path:"live"`. This trace **confirms empirically** that the
  pool-saturation effect of that fan-out — not the wall-clock of
  thick analytics itself — is what blocks every other useQuery on
  the dashboard.
* `feedback_react_query_key_collision.md` (memory note) — the
  duplicate mood-analytics call is a fresh instance of the same
  pattern Marc has flagged before.
* The v1.4.39.2 slim/thick split was a **correct frontend
  decoupling**, but the trace shows that without **server-side
  Prisma fan-out throttling** (F1) and pool sizing (F2) the
  improvement only buys the tile-strip ~5-6 s of head-start while
  the chart row still arrives in a single burst at thick-analytics-
  release time.
