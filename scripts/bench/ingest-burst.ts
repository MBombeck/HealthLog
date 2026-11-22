/**
 * First-sync burst under the production heap ceiling: does one phone's first
 * Apple Health backfill stay inside the heap, and what does it leave behind?
 *
 *   DATABASE_URL=postgresql://… API_TOKEN_HMAC_KEY=… ENCRYPTION_KEYS=… \
 *   ENCRYPTION_ACTIVE_KEY_ID=… pnpm dlx tsx scripts/bench/ingest-burst.ts \
 *     [--heap-mb 524] [--batches 160] [--batch-concurrency 4] [--ecg 60] \
 *     [--ecg-concurrency 12] [--read-rounds 6] [--ceiling-mb 400] \
 *     [--out scripts/bench/results/<label>-burst] [--snapshot <file>]
 *
 * See docs/contributing/benchmarks.md. Never point it at a database that
 * holds real data: it creates an account, mints a token for it, writes under
 * it and deletes it again at the end.
 *
 * The script starts the production build itself (`next start` on `.next`,
 * every role, so the worker runs its post-ingest jobs in the same process as
 * production does) under `--max-old-space-size=<heap-mb>`, and reads the
 * server's heap through the inspector: a sample every 250 ms during the
 * burst, and the live heap after a forced full collection before and after.
 *
 * The burst is what a phone sends right after signing in to a fresh account:
 * `--batches` Apple Health batches of 500 entries (ten-minute heart-rate
 * buckets, HRV and resting-heart-rate samples, sleep stages and step-day
 * totals, reaching back through the years) over `--batch-concurrency`
 * connections, `--ecg` Apple Watch strips of 15 360 samples over
 * `--ecg-concurrency` connections, and `--read-rounds` dashboard loads of
 * twelve concurrent series reads plus the snapshot. A 429 is honoured the way
 * the native client honours it: wait for `Retry-After` (or
 * `X-RateLimit-Reset`) and send the same request again.
 *
 * Exit 1 when the server dies, when any request ends in a 5xx, or when the
 * peak used heap crosses `--ceiling-mb`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { Pool } from "pg";

import { hashToken } from "@/lib/auth/hmac";
import { issueApiToken } from "@/lib/auth/issue-token";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { prisma } from "@/lib/db";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const HEAP_MB = Number(arg("heap-mb", "524"));
const BATCHES = Number(arg("batches", "160"));
const BATCH_CONCURRENCY = Number(arg("batch-concurrency", "4"));
const ECG = Number(arg("ecg", "60"));
const ECG_CONCURRENCY = Number(arg("ecg-concurrency", "12"));
const READ_ROUNDS = Number(arg("read-rounds", "6"));
const CEILING_MB = Number(arg("ceiling-mb", "400"));
const PORT = Number(arg("port", "3110"));
const INSPECT_PORT = Number(arg("inspect-port", "9239"));
const OUT = arg("out", "");
const SNAPSHOT = arg("snapshot", "");
const WALK_PAGES = !process.argv.includes("--no-page-walk");
// Diagnostic: one heap snapshot during the burst, once the used heap first
// reaches this many MB (a snapshot collects first, so it shows what the
// requests in flight hold, not garbage).
const SNAPSHOT_AT_MB = Number(arg("snapshot-at-mb", "0"));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── the server and its inspector ─────────────────────────────────────────

function startServer(): ChildProcess {
  return spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(PORT),
        HOSTNAME: "127.0.0.1",
        HEALTHLOG_PROCESS_TYPE: "all",
        SESSION_COOKIE_SECURE: "false",
        NODE_OPTIONS: `--max-old-space-size=${HEAP_MB} --inspect=127.0.0.1:${INSPECT_PORT}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
}

async function waitForHealth(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`the server exited with code ${server.exitCode}`);
    }
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error("the server did not answer /api/health");
}

class Inspector {
  private ws!: WebSocket;
  private nextId = 1;
  private readonly waiting = new Map<number, (msg: unknown) => void>();
  private chunkSink: ((chunk: string) => void) | null = null;

  async connect(): Promise<void> {
    const list = (await (
      await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)
    ).json()) as Array<{ webSocketDebuggerUrl: string }>;
    this.ws = new WebSocket(list[0]!.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { chunk?: string };
      };
      if (msg.method === "HeapProfiler.addHeapSnapshotChunk") {
        this.chunkSink?.(msg.params?.chunk ?? "");
      } else if (msg.id !== undefined) {
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
      }
    };
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<{ result?: { result?: { value?: unknown } } }>(
      (resolve) => {
        this.waiting.set(id, resolve as (msg: unknown) => void);
        this.ws.send(JSON.stringify({ id, method, params }));
      },
    );
  }

  async usedHeapMb(): Promise<number> {
    const res = await this.send("Runtime.evaluate", {
      expression: "process.memoryUsage().heapUsed",
      returnByValue: true,
    });
    return Number(res.result?.result?.value ?? 0) / 1_048_576;
  }

  /** The live heap: used heap right after a forced full collection. */
  async liveHeapMb(): Promise<number> {
    await this.send("HeapProfiler.collectGarbage");
    await this.send("HeapProfiler.collectGarbage");
    return this.usedHeapMb();
  }

  /** Entries and serialised size of every server-cache bucket. */
  async cacheSizes(): Promise<unknown> {
    const res = await this.send("Runtime.evaluate", {
      expression: `(() => {
        const reg = globalThis[Symbol.for("healthlog.serverCaches")];
        if (!reg) return null;
        const out = {};
        for (const [name, cache] of Object.entries(reg)) {
          let bytes = 0;
          for (const entry of cache.map.values()) {
            try { bytes += JSON.stringify(entry.value)?.length ?? 0; } catch {}
          }
          out[name] = { entries: cache.map.size, jsonMb: Math.round(bytes / 1e5) / 10 };
        }
        return out;
      })()`,
      returnByValue: true,
    });
    return res.result?.result?.value ?? null;
  }

  async snapshot(file: string): Promise<void> {
    const out = createWriteStream(file);
    this.chunkSink = (chunk) => out.write(chunk);
    await this.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    this.chunkSink = null;
    await new Promise((resolve) => out.end(resolve));
  }

  close(): void {
    this.ws.close();
  }
}

// ── the account ───────────────────────────────────────────────────────────

const USER_ID = `burst-${Date.now().toString(36)}`;

async function createAccount(): Promise<string> {
  await pool.query(
    `INSERT INTO users (id, username, timezone, onboarding_completed_at, updated_at)
     VALUES ($1, $1, 'Europe/Berlin', now(), now())`,
    [USER_ID],
  );
  return (
    await issueApiToken({
      userId: USER_ID,
      name: "ingest burst",
      permissions: ["*"],
      expiresInDays: 1,
    })
  ).token;
}

/**
 * A browser session for the page walk: the walk renders every page once, as
 * a person clicking through the app does, so the burst runs on a process
 * that holds every route's modules, not on a freshly started one.
 */
async function createSessionCookie(): Promise<string> {
  const secret = `hls_${randomBytes(32).toString("hex")}`;
  await prisma.session.create({
    data: {
      userId: USER_ID,
      tokenHash: hashToken(secret),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return `${sessionCookieName()}=${secret}`;
}

/** Every page of the build without a dynamic segment. */
function pagePaths(): string[] {
  const manifest = JSON.parse(
    readFileSync(".next/server/app-paths-manifest.json", "utf8"),
  ) as Record<string, string>;
  return Object.keys(manifest)
    .filter((k) => k.endsWith("/page") && !k.includes("[") && !k.includes("_"))
    .map((k) => k.slice(0, -"/page".length).replace(/\/\([^)]+\)/g, "") || "/");
}

async function walkPages(cookie: string): Promise<number> {
  const paths = pagePaths();
  await lanes(paths, 4, async (path) => {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { cookie },
        redirect: "manual",
      });
      await res.arrayBuffer();
    } catch {
      // a page that fails to render still loaded its modules
    }
  });
  return paths.length;
}

// ── the requests ──────────────────────────────────────────────────────────

interface Tally {
  sent: number;
  byStatus: Record<string, number>;
  retryAfterMissing: number;
  maxMs: number;
}
const tallies = new Map<string, Tally>();
let token = "";

async function call(
  label: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<void> {
  const tally = tallies.get(label) ?? {
    sent: 0,
    byStatus: {},
    retryAfterMissing: 0,
    maxMs: 0,
  };
  tallies.set(label, tally);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  for (let attempt = 0; attempt < 30; attempt++) {
    const started = Date.now();
    tally.sent += 1;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": "HealthLog-iOS/burst",
          ...(payload ? { "content-type": "application/json" } : {}),
        },
        body: payload,
      });
      await res.arrayBuffer();
    } catch {
      tally.byStatus.network = (tally.byStatus.network ?? 0) + 1;
      return;
    }
    tally.maxMs = Math.max(tally.maxMs, Date.now() - started);
    tally.byStatus[res.status] = (tally.byStatus[res.status] ?? 0) + 1;
    if (res.status !== 429) return;
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Date.parse(res.headers.get("x-ratelimit-reset") ?? "");
    if (!Number.isFinite(retryAfter) && !Number.isFinite(reset)) {
      tally.retryAfterMissing += 1;
    }
    const waitMs = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Number.isFinite(reset)
        ? Math.max(0, reset - Date.now())
        : 2000;
    await sleep(Math.min(waitMs, 60_000) + Math.random() * 500);
  }
}

const DAY = 86_400_000;
const NOW = Date.now();

/** One 500-entry batch, `index` days of history further back than the last. */
function batch(index: number): unknown {
  const entries: unknown[] = [];
  // Each batch covers two days, `index * 2` days back.
  const dayStart = Math.floor((NOW - (index * 2 + 1) * DAY) / DAY) * DAY;
  for (let i = 0; i < 288; i++) {
    const at = new Date(dayStart + i * 600_000).toISOString();
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
      value: 55 + (i % 40),
      valueMin: 50 + (i % 40),
      valueMax: 70 + (i % 40),
      unit: "count/min",
      startDate: at,
      endDate: at,
      externalId: `stats:HKQuantityTypeIdentifierHeartRate:${at}`,
    });
  }
  for (let i = 0; i < 120; i++) {
    const at = new Date(dayStart + i * 720_000).toISOString();
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
      value: 30 + (i % 25),
      unit: "ms",
      startDate: at,
      endDate: at,
      externalId: `${USER_ID}-hrv-${index}-${i}`,
    });
  }
  for (let i = 0; i < 88; i++) {
    const start = dayStart - 8 * 3_600_000 + i * 300_000;
    entries.push({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 5,
      unit: "category",
      startDate: new Date(start).toISOString(),
      endDate: new Date(start + 300_000).toISOString(),
      sleepStage: [3, 4, 5, 2][i % 4],
      externalId: `${USER_ID}-sleep-${index}-${i}`,
    });
  }
  for (let d = 0; d < 2; d++) {
    const day = new Date(dayStart + d * DAY).toISOString().slice(0, 10);
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierStepCount",
      value: 6000 + index,
      unit: "count",
      startDate: new Date(dayStart + d * DAY).toISOString(),
      endDate: new Date(dayStart + d * DAY + DAY - 1).toISOString(),
      externalId: `stats:HKQuantityTypeIdentifierStepCount:${day}`,
    });
    entries.push({
      hkIdentifier: "HKQuantityTypeIdentifierRestingHeartRate",
      value: 52 + (index % 6),
      unit: "count/min",
      startDate: new Date(dayStart + d * DAY + 3_600_000).toISOString(),
      endDate: new Date(dayStart + d * DAY + 3_600_000).toISOString(),
      externalId: `${USER_ID}-rhr-${index}-${d}`,
    });
  }
  return { entries: entries.slice(0, 500), syncTrigger: "backfill" };
}

function ecg(index: number): unknown {
  return {
    externalRecordingId: `${USER_ID}-ecg-${index}`,
    recordedAt: new Date(NOW - index * 7 * DAY).toISOString(),
    samplingFrequency: 512,
    samples: Array.from(
      { length: 15_360 },
      (_, i) => Math.round(Math.sin(i / 20) * 400_000) + (i % 97),
    ),
    lead: "appleWatchSimilarToLeadI",
    averageHeartRate: 64.7,
    classification: "NOT_DETECTED",
    source: "APPLE_HEALTH",
  };
}

const READS = [
  "/api/dashboard/snapshot",
  ...[
    "pulse",
    "heartRateVariability",
    "restingHeartRate",
    "sleep",
    "steps",
    "weight",
  ].flatMap((kind) => [
    `/api/measurements/series?kind=${kind}&days=30`,
    `/api/measurements/series?kind=${kind}&days=3650`,
  ]),
];

async function lanes<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const item = items[next++]!;
        await run(item);
      }
    }),
  );
}

async function pendingJobs(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pgboss.job
     WHERE state IN ('created', 'retry', 'active')
       AND data->>'userId' = $1`,
    [USER_ID],
  );
  return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  token = await createAccount();
  const server = startServer();
  let serverLog = "";
  server.stderr?.on("data", (d: Buffer) => {
    serverLog = (serverLog + d.toString()).slice(-20_000);
  });
  const inspector = new Inspector();
  let failed = false;
  const result: Record<string, unknown> = { heapLimitMb: HEAP_MB };
  try {
    await waitForHealth(server);
    await inspector.connect();
    // Let the worker's boot passes finish before the baseline.
    await sleep(20_000);
    const fresh = await inspector.liveHeapMb();
    console.log(`live heap after boot: ${fresh.toFixed(0)} MB`);
    result.liveAfterBootMb = Math.round(fresh);
    if (WALK_PAGES) {
      const pages = await walkPages(await createSessionCookie());
      result.pagesWalked = pages;
    }
    const before = await inspector.liveHeapMb();
    console.log(`live heap before the burst: ${before.toFixed(0)} MB`);
    if (SNAPSHOT && process.argv.includes("--snapshot-before")) {
      await inspector.snapshot(`${SNAPSHOT}.before.heapsnapshot`);
    }

    let peak = 0;
    let sampling = true;
    const sampler = (async () => {
      let snapped = false;
      while (sampling && server.exitCode === null) {
        const used = await inspector.usedHeapMb();
        peak = Math.max(peak, used);
        if (SNAPSHOT_AT_MB > 0 && !snapped && used >= SNAPSHOT_AT_MB) {
          snapped = true;
          await inspector.snapshot(`${SNAPSHOT || "burst"}.peak.heapsnapshot`);
          result.liveAtSnapshotMb = Math.round(await inspector.usedHeapMb());
        }
        await sleep(250);
      }
    })();

    const started = Date.now();
    await Promise.all([
      lanes(
        Array.from({ length: BATCHES }, (_, i) => i),
        BATCH_CONCURRENCY,
        (i) => call("batch", "POST", "/api/measurements/batch", batch(i)),
      ),
      lanes(
        Array.from({ length: ECG }, (_, i) => i),
        ECG_CONCURRENCY,
        (i) => call("ecg", "POST", "/api/insights/ecg", ecg(i)),
      ),
      (async () => {
        for (let round = 0; round < READ_ROUNDS; round++) {
          await sleep(4_000);
          await Promise.all(READS.map((path) => call("read", "GET", path)));
        }
      })(),
    ]);
    const burstMs = Date.now() - started;

    // The post-ingest jobs the burst left queued run next; wait for them.
    const settleDeadline = Date.now() + 90_000;
    while (Date.now() < settleDeadline && server.exitCode === null) {
      if ((await pendingJobs()) === 0) break;
      await sleep(1_000);
    }
    const settleMs = Date.now() - started - burstMs;
    sampling = false;
    await sampler;
    if (server.exitCode !== null) throw new Error("the server died");
    const after = await inspector.liveHeapMb();
    result.caches = await inspector.cacheSizes();
    if (SNAPSHOT) await inspector.snapshot(SNAPSHOT);

    const fivexx = [...tallies.values()].reduce(
      (n, t) =>
        n +
        Object.entries(t.byStatus)
          .filter(([s]) => s.startsWith("5") || s === "network")
          .reduce((m, [, c]) => m + c, 0),
      0,
    );
    Object.assign(result, {
      liveBeforeMb: Math.round(before),
      peakUsedMb: Math.round(peak),
      liveAfterMb: Math.round(after),
      burstSeconds: Math.round(burstMs / 100) / 10,
      settleSeconds: Math.round(settleMs / 100) / 10,
      requests: Object.fromEntries(tallies),
    });
    console.log(JSON.stringify(result, null, 2));
    if (fivexx > 0) {
      console.error(`${fivexx} requests failed with a 5xx or no answer`);
      failed = true;
    }
    if (peak > CEILING_MB) {
      console.error(
        `peak used heap ${peak.toFixed(0)} MB crossed the ${CEILING_MB} MB ceiling`,
      );
      failed = true;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(serverLog.slice(-4_000));
    result.error = err instanceof Error ? err.message : String(err);
    failed = true;
  } finally {
    try {
      inspector.close();
    } catch {
      // never connected
    }
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => server.once("exit", r)),
        sleep(20_000),
      ]);
      if (server.exitCode === null) server.kill("SIGKILL");
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await pool.end();
    await prisma.$disconnect();
  }
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(`${OUT}.json`, `${JSON.stringify(result, null, 2)}\n`);
  }
  process.exit(failed ? 1 : 0);
}

void main();
