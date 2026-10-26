/**
 * #1220 — a Google Health history backfill over three years of heart rate,
 * driven through the admission drain slice by slice until it completes,
 * against Postgres.
 *
 * What went wrong. A backfill noted its progress only once a whole collection
 * was walked to the end. Three years of heart rate at one reading a minute is
 * some 1 600 pages, and an attempt that did not get through all of them (its
 * budget, a rate limit it could not wait out, one failed request among
 * thousands) started the next attempt from the newest page again. The account
 * never got past its first unfinished collection, every attempt failed with
 * "marker not stamped", and none of them left a line saying where it stopped,
 * because the drain ran the import outside any log event.
 *
 * What this pins, end to end:
 *   - the backfill completes, through as many slices as the history needs,
 *     and every slice after the first starts where the one before it stopped;
 *   - every reading is imported exactly once: the rows match the history, the
 *     slices' import counts add up to it, and no row was ever rewritten;
 *   - a server error, a lost request and a rate limit Google will not lift
 *     for an hour each cost a retry or a slice boundary, never the walk;
 *   - the hourly sync runs between slices (and beside one, by waiting for
 *     it) instead of being skipped for as long as the import runs;
 *   - every slice writes a log event naming its requests and where it got to;
 *   - over the full history, the heap does not grow with it (run it under
 *     the production ceiling: `NODE_OPTIONS=--max-old-space-size=524`);
 *   - and, in a second run over four years (a third longer than the first),
 *     a Google that refuses the resume
 *     edge's upper bound (`<=`): the backfill falls back to reading without
 *     it, notes the refusal so it is met only once, keeps its place in the
 *     unbounded list from slice to slice so the pages it reads stay linear in
 *     the history (before, every slice passed over everything the slices
 *     before it wrote), and still imports every reading exactly once.
 *
 * Google is replaced at the `safeFetch` seam by a generator that builds each
 * page on request from the filter and page token it is asked with, so the
 * fixture never sits in memory.
 *
 * How much history it walks is set by `HEALTHLOG_BACKFILL_TEST_DAYS`. What a
 * run costs is its heart-rate pages (a request, a thousand row writes and a
 * progress note each), so a shorter history only helps if the slices shrink
 * with it. Unset, the first run walks 120 days and the second 160, at one
 * reading a minute and a thousand a page, in slices of 50 pages instead of
 * 500, with the faults moved to the same places within them: the same
 * sequence of slices, boundaries, retries and rate limit, at about a tenth
 * of the pages. Two things differ. The light collections start out walked,
 * because the first slice walks them before heart rate (some hundred empty
 * requests here) and a 50-page slice would spend itself on them; and 120
 * days is a floor, not a choice: the first hourly sync reads the last 30
 * days, the first slice has to have written them already, as it has in the
 * full run, or the backfill's import counts no longer add up to the history,
 * and the history has to outlast four slices. The full three and four years
 * (some 3.7 million readings, every collection, production slices, over
 * twenty minutes) run when the variable is at least `1095`, which the
 * nightly `integration-long.yml` workflow does.
 */
import v8 from "node:v8";
import vm from "node:vm";

import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { WideEvent } from "@/lib/logging/types";
import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "gh-multi-year-owner";
const MINUTE = 60_000;
/** The newest reading: now, so the hourly sync's window lands on real data. */
const NOW = Math.floor(Date.now() / MINUTE) * MINUTE;

/**
 * How much the collected heap may grow over the second half of the history:
 * from the first sample taken inside a page request once the second slice is
 * over, to the most any later sample reaches. Every sample is taken mid-walk,
 * so each carries the same in-flight working set (one page, the ORM's and the
 * driver's buffers, some 35 MB here) and only growth is compared. The first
 * two slices are left out because the first hourly sync and the first
 * rate-limited slice load code paths once. Measured, not chosen: the line
 * stays within half a MB of flat. A backfill that kept what it read would
 * grow by hundreds of MB over the same stretch.
 */
const GROWTH_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * The run's size (see the header): the full three years with production
 * slices when `HEALTHLOG_BACKFILL_TEST_DAYS` is at least 1095, else that
 * many days (120 unless set) with 50-page slices and heart rate the only
 * collection left to walk.
 */
const size = vi.hoisted(() => {
  const raw = process.env.HEALTHLOG_BACKFILL_TEST_DAYS;
  const days = raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : 120;
  const full = days >= 3 * 365;
  return { days, full, slicePages: full ? 500 : 50 };
});

/** Days of heart rate the first run walks; the second walks a third more. */
const DAYS = size.days;
/** One reading a minute. */
const POINTS = DAYS * 24 * 60;
/** Pages a slice reads, and the faults' places scaled to it. */
const SLICE_PAGES = size.slicePages;
const SCALE = SLICE_PAGES / 500;

vi.mock("@/lib/jobs/google-health-backfill", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/google-health-backfill")>();
  if (size.slicePages === actual.GOOGLE_HEALTH_BACKFILL_SLICE_PAGES) {
    return actual;
  }
  // The drain runs each slice with the production budget; a shorter run
  // gives it shorter slices through the job's own test seam.
  return {
    ...actual,
    runGoogleHealthBackfillForUser: (
      ...args: Parameters<typeof actual.runGoogleHealthBackfillForUser>
    ) =>
      actual.runGoogleHealthBackfillForUser(args[0], args[1], args[2], {
        ...args[3],
        slicePages: size.slicePages,
      }),
  };
});

const fake = vi.hoisted(() => ({
  now: 0,
  total: 0,
  /** Heart-rate requests seen, the backfill's among them, and readings served. */
  heartRateRequests: 0,
  backfillRequests: 0,
  servedPoints: 0,
  /** Faults to inject, keyed by the backfill request number they hit. */
  faults: new Map<number, "503" | "timeout" | "429-long">(),
  onRequest: null as (() => void) | null,
  /** Refuse any filter with an upper bound, and count the refusals. */
  refuseUpperBound: false,
  refused: 0,
  /** Backfill requests that carried an upper bound. */
  upperBoundRequests: 0,
}));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  const respond = (body: unknown, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  return {
    ...actual,
    // A plain function, not `vi.fn`: a mock records every result, and here
    // each result is a page of a thousand readings.
    safeFetch: async (url: string) => {
      const u = new URL(url);
      if (!u.pathname.endsWith("/dataTypes/heart-rate/dataPoints")) {
        // Every other collection is empty for this account.
        return respond({});
      }
      fake.heartRateRequests += 1;
      fake.onRequest?.();
      // The hourly sync always asks from a lower bound; the backfill never.
      const filter = u.searchParams.get("filter") ?? "";
      const fromBackfill = !filter.includes(">=");
      if (fromBackfill) fake.backfillRequests += 1;
      if (filter.includes("<=")) {
        fake.upperBoundRequests += 1;
        if (fake.refuseUpperBound) {
          fake.refused += 1;
          return respond(
            {
              error: {
                code: 400,
                status: "INVALID_ARGUMENT",
                message: "Invalid filter expression.",
              },
            },
            400,
          );
        }
      }
      const fault = fromBackfill
        ? fake.faults.get(fake.backfillRequests)
        : undefined;
      if (fault) {
        fake.faults.delete(fake.backfillRequests);
        if (fault === "timeout") {
          throw new actual.SafeFetchError("safeFetch aborted", "timeout");
        }
        if (fault === "503") {
          return respond({ error: { code: 503, status: "UNAVAILABLE" } }, 503);
        }
        return respond(
          { error: { code: 429, status: "RESOURCE_EXHAUSTED" } },
          429,
          { "retry-after": "3600" },
        );
      }

      // Newest first, one reading a minute: reading `g` is `g` minutes old.
      // The hourly sync asks from a lower bound (`>=`), a resumed backfill
      // up to its edge (`<=`).
      const from = /physical_time >= "([^"]+)"/.exec(filter)?.[1];
      const upTo = /physical_time <= "([^"]+)"/.exec(filter)?.[1];
      const newest = upTo
        ? Math.max(0, Math.ceil((fake.now - Date.parse(upTo)) / MINUTE))
        : 0;
      const oldest = from
        ? Math.min(
            fake.total - 1,
            Math.floor((fake.now - Date.parse(from)) / MINUTE),
          )
        : fake.total - 1;
      const pageSize = Number(u.searchParams.get("pageSize") ?? 1000);
      const page = Number(u.searchParams.get("pageToken") ?? 0);
      const start = newest + page * pageSize;
      const end = Math.min(oldest + 1, start + pageSize);
      const dataPoints = [];
      for (let g = start; g < end; g++) {
        dataPoints.push({
          name: `users/me/dataTypes/heart-rate/dataPoints/${7_000_000_000 + g}`,
          dataSource: { platform: "FITBIT" },
          heartRate: {
            beatsPerMinute: String(52 + (g % 61)),
            sampleTime: {
              physicalTime: new Date(fake.now - g * MINUTE).toISOString(),
            },
          },
        });
      }
      fake.servedPoints += dataPoints.length;
      return respond({
        dataPoints,
        ...(end <= oldest ? { nextPageToken: String(page + 1) } : {}),
      });
    },
  };
});

/** Jobs the backfill and the hourly sync queue, recorded. */
const sent = vi.hoisted(() => ({
  jobs: [] as Array<{ queue: string; data: unknown }>,
}));
vi.mock("@/lib/jobs/boss-instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/boss-instance")>()),
  getGlobalBoss: () => ({
    send: async (queue: string, data: unknown) => {
      sent.jobs.push({ queue, data });
      return `job-${sent.jobs.length}`;
    },
  }),
}));

/** The log events the runs write, recorded instead of printed. */
const logged = vi.hoisted(() => ({ events: [] as WideEvent[] }));
vi.mock("@/lib/logging/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging/transports")>()),
  emitIfSampled: (event: WideEvent) => {
    logged.events.push(event);
  },
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const forceGc = ((): (() => void) => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  v8.setFlagsFromString("--no-expose-gc");
  return gc;
})();

function liveHeapBytes(): number {
  forceGc();
  forceGc();
  return process.memoryUsage().heapUsed;
}

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

function report(line: string): void {
  process.stderr.write(`[gh-multi-year] ${line}\n`);
}

/** A fresh account with `points` minutes of heart rate behind it. */
async function seed(points: number): Promise<void> {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { encrypt } = await import("@/lib/crypto");
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "Europe/Berlin" },
  });
  await prisma.googleHealthConnection.create({
    data: {
      userId: USER,
      googleUserId: `google-${USER}`,
      accessToken: encrypt("access"),
      refreshToken: encrypt("refresh"),
      tokenExpiresAt: new Date(Date.now() + 7 * 86_400_000),
      // A shorter run starts with every light collection walked, so its
      // short first slice goes to heart rate (see the header).
      ...(size.full
        ? {}
        : {
            backfillProgress: {
              done: (
                await import("@/lib/google-health/collection-keys")
              ).GOOGLE_HEALTH_COLLECTION_KEYS.filter(
                (k) => k !== "fetchHeartRate",
              ),
            },
          }),
    },
  });
  fake.now = NOW;
  fake.total = points;
  fake.heartRateRequests = 0;
  fake.backfillRequests = 0;
  fake.servedPoints = 0;
  fake.faults.clear();
  fake.onRequest = null;
  fake.refuseUpperBound = false;
  fake.refused = 0;
  fake.upperBoundRequests = 0;
}

beforeAll(async () => {
  await seed(POINTS);
}, 120_000);

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

type AdmissionPayload =
  import("@/lib/jobs/integration-backfill-admission").IntegrationBackfillAdmissionPayload;

function admissionJob(
  payload: AdmissionPayload,
  n: number,
): Job<AdmissionPayload> {
  return {
    id: `admission-${n}`,
    name: "integration-backfill-admission",
    data: payload,
    // The production expiry: sixteen hours.
    expireInSeconds: 16 * 60 * 60,
  } as unknown as Job<AdmissionPayload>;
}

function nextSlice(): AdmissionPayload | null {
  const next = sent.jobs.find(
    (j) => j.queue === "integration-backfill-admission",
  );
  return next ? (next.data as AdmissionPayload) : null;
}

describe(`Google Health backfill over ${DAYS} days of heart rate (#1220)`, () => {
  it("completes slice by slice, imports every reading once, and keeps the hourly sync running", async () => {
    const { drainIntegrationBackfillAdmission } =
      await import("@/lib/jobs/integration-backfill-drain");
    const { handleGoogleHealthSync } =
      await import("@/lib/jobs/reminder/google-health-sync");
    const { GOOGLE_HEALTH_TRANSIENT_RETRY } =
      await import("@/lib/google-health/request");
    GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs = 0;

    // A server error and a lost request in the first slice, and a rate limit
    // Google will not lift for an hour in the second.
    fake.faults.set(Math.round(40 * SCALE), "503");
    fake.faults.set(Math.round(80 * SCALE), "timeout");
    fake.faults.set(SLICE_PAGES + Math.round(120 * SCALE), "429-long");

    // Heap samples from inside the page requests, between two pages of the
    // work being measured, once the second slice is over (see the budget).
    let measuring = false;
    let anchor: number | null = null;
    let peak = 0;
    let samples = 0;
    fake.onRequest = () => {
      if (!measuring || fake.heartRateRequests % Math.round(50 * SCALE) !== 0) {
        return;
      }
      const live = liveHeapBytes();
      if (anchor === null) {
        anchor = peak = live;
        return;
      }
      samples++;
      peak = Math.max(peak, live);
    };

    const prisma = getPrismaClient();
    let payload: AdmissionPayload | null = {
      kind: "google-health-backfill",
      data: { userId: USER, enqueuedAt: new Date().toISOString() },
    };
    const slices: Array<{
      slice: number;
      imported: number;
      continued: number;
    }> = [];
    let hourlyBeside: Promise<unknown> | null = null;

    for (let n = 0; payload && n < 40; n++) {
      sent.jobs = [];
      logged.events = [];
      const drained = drainIntegrationBackfillAdmission([
        admissionJob(payload, n),
      ]);
      // Once, start the hourly sync while a slice is running: it waits for
      // the slice instead of skipping the account.
      if (n === 2) {
        hourlyBeside = handleGoogleHealthSync([] as never);
      }
      const outcome = await drained;
      expect(outcome.ok).toBe(true);
      const did = (outcome as { did: Record<string, number> }).did;
      slices.push({
        slice: payload.data.slice ?? 0,
        imported: did.imported,
        continued: did.continued,
      });

      // The slice wrote one log event, with its requests and where it got to.
      const runEvents = logged.events.filter(
        (e) => e.background?.task_name === "job.integration_backfill",
      );
      expect(runEvents).toHaveLength(1);
      const sliceMeta = runEvents[0]!.meta?.["googleHealth.backfill.slice"] as
        { pages: number; stopReason: string | null; edges: object } | undefined;
      expect(sliceMeta).toBeDefined();
      expect(
        runEvents[0]!.external_calls?.some((c) =>
          c.method.startsWith("fetchHeartRate(page="),
        ),
      ).toBe(true);
      report(
        `slice ${payload.data.slice ?? 0}: pages=${sliceMeta!.pages} ` +
          `stop=${sliceMeta!.stopReason} imported=${did.imported} ` +
          `edges=${JSON.stringify(sliceMeta!.edges)}`,
      );

      if (n === 1) measuring = true;
      payload = nextSlice();

      // Between slices the account is free, and the hourly sync runs.
      if (payload) {
        const hourly = await handleGoogleHealthSync([] as never);
        expect(hourly).toMatchObject({
          ok: true,
          did: { users_skipped: 0, users_failed: 0, users_parked: 0 },
        });
      }
    }

    expect(await hourlyBeside).toMatchObject({
      ok: true,
      did: { users_skipped: 0 },
    });

    // Completed, and the note of how far it got is gone with it.
    const connection = await prisma.googleHealthConnection.findUniqueOrThrow({
      where: { userId: USER },
      select: { backfillCompletedAt: true, backfillProgress: true },
    });
    expect(connection.backfillCompletedAt).toBeInstanceOf(Date);
    expect(connection.backfillProgress).toBeNull();
    expect(payload).toBeNull();

    // More than one slice, every one before the last continued, and the
    // rate-limited one among them.
    expect(slices.length).toBeGreaterThan(2);
    expect(slices.slice(0, -1).every((s) => s.continued === 1)).toBe(true);
    expect(fake.faults.size).toBe(0);
    expect(slices.map((s) => s.slice)).toEqual(slices.map((_, i) => i));

    // Every reading exactly once.
    const rows = await prisma.measurement.count({
      where: { userId: USER, type: "PULSE", source: "GOOGLE_HEALTH" },
    });
    expect(rows).toBe(POINTS);
    expect(slices.reduce((sum, s) => sum + s.imported, 0)).toBe(POINTS);
    const versions = await prisma.measurement.aggregate({
      where: { userId: USER, type: "PULSE", source: "GOOGLE_HEALTH" },
      _max: { syncVersion: true },
      _min: { syncVersion: true },
    });
    expect(versions._max.syncVersion).toBe(versions._min.syncVersion);
    // Each slice re-reads only the reading on its edge (plus the hourly
    // sync's own window), not the history before it.
    report(
      `requests=${fake.heartRateRequests} served=${fake.servedPoints} ` +
        `points=${POINTS} slices=${slices.length}`,
    );

    // The heap did not grow with the history.
    const growth = peak - (anchor ?? 0);
    report(
      `heap growth after the second slice: ${mb(growth)} MB over ${samples} ` +
        `samples (budget ${mb(GROWTH_BUDGET_BYTES)} MB, ceiling ` +
        `${mb(v8.getHeapStatistics().heap_size_limit)} MB, peak ${mb(peak)} MB)`,
    );
    expect(samples).toBeGreaterThan(5);
    // Only over the full history: a short run is still warming up (one
    // measured 47 MB of growth over 120 days with nothing held), and a walk
    // that held what it read would hold too little of a short history to
    // stand out. On every run the walk's memory is pinned by
    // google-health-dense-backfill-memory.test.ts.
    if (size.full) expect(growth).toBeLessThan(GROWTH_BUDGET_BYTES);
  }, 3_600_000);

  it("completes when Google refuses the resume edge's upper bound, meeting the refusal once", async () => {
    // A third longer than the first run (four years in the full run): the
    // first slice reads without an edge, the second resumes with the bound
    // and is refused, every later one reads without it. Long enough that
    // passing over everything already written on every slice would read the
    // history several times over.
    const points = Math.round((DAYS * 4) / 3) * 24 * 60;
    await seed(points);
    fake.refuseUpperBound = true;

    const { drainIntegrationBackfillAdmission } =
      await import("@/lib/jobs/integration-backfill-drain");
    const { handleGoogleHealthSync } =
      await import("@/lib/jobs/reminder/google-health-sync");
    const { GOOGLE_HEALTH_TRANSIENT_RETRY } =
      await import("@/lib/google-health/request");
    GOOGLE_HEALTH_TRANSIENT_RETRY.baseDelayMs = 0;

    const prisma = getPrismaClient();
    let payload: AdmissionPayload | null = {
      kind: "google-health-backfill",
      data: { userId: USER, enqueuedAt: new Date().toISOString() },
    };
    let hourlyRuns = 0;
    const slices: Array<{
      imported: number;
      continued: number;
      skippedPages: number;
      refusalNoted: unknown;
    }> = [];

    for (let n = 0; payload && n < 40; n++) {
      sent.jobs = [];
      logged.events = [];
      const outcome = await drainIntegrationBackfillAdmission([
        admissionJob(payload, n),
      ]);
      expect(outcome.ok).toBe(true);
      const did = (outcome as { did: Record<string, number> }).did;
      const runEvents = logged.events.filter(
        (e) => e.background?.task_name === "job.integration_backfill",
      );
      expect(runEvents).toHaveLength(1);
      const meta = runEvents[0]!.meta ?? {};
      const sliceMeta = meta["googleHealth.backfill.slice"] as {
        pages: number;
        skippedPages: number;
        stopReason: string | null;
      };
      slices.push({
        imported: did.imported,
        continued: did.continued,
        skippedPages: sliceMeta.skippedPages,
        refusalNoted: meta["googleHealth.backfill.edgeFilterUnsupported"],
      });
      report(
        `refusing slice ${payload.data.slice ?? 0}: pages=${sliceMeta.pages} ` +
          `skipped=${sliceMeta.skippedPages} stop=${sliceMeta.stopReason} ` +
          `imported=${did.imported}`,
      );
      payload = nextSlice();
      if (payload) {
        const hourly = await handleGoogleHealthSync([] as never);
        expect(hourly).toMatchObject({
          ok: true,
          did: { users_skipped: 0, users_failed: 0, users_parked: 0 },
        });
        hourlyRuns += 1;
      }
    }

    const connection = await prisma.googleHealthConnection.findUniqueOrThrow({
      where: { userId: USER },
      select: { backfillCompletedAt: true, backfillProgress: true },
    });
    expect(connection.backfillCompletedAt).toBeInstanceOf(Date);
    expect(connection.backfillProgress).toBeNull();
    expect(payload).toBeNull();
    expect(slices.slice(0, -1).every((s) => s.continued === 1)).toBe(true);
    // The hourly sync ran between every two slices.
    expect(slices.length).toBeGreaterThan(4);
    expect(hourlyRuns).toBe(slices.length - 1);

    // The pages read stay linear in the history: every page once, the one
    // pass over what the first slice wrote when the refusal was met, and a
    // page or two per slice where it picks up again. Passing over everything
    // already written on every slice read more than three times as many.
    const historyPages = Math.ceil(points / 1000);
    report(
      `refusing run: backfill requests=${fake.backfillRequests} ` +
        `history pages=${historyPages} slices=${slices.length}`,
    );
    expect(fake.backfillRequests).toBeLessThanOrEqual(
      historyPages + SLICE_PAGES + 2 * slices.length,
    );

    // The bound was asked for once, refused once, and never again: the
    // refusal was noted on the slice that met it and honoured after.
    expect(fake.upperBoundRequests).toBe(1);
    expect(fake.refused).toBe(1);
    expect(slices.filter((s) => s.refusalNoted !== undefined)).toEqual([
      expect.objectContaining({ refusalNoted: ["fetchHeartRate"] }),
    ]);
    // Only the slice that met the refusal passed over what the slice before
    // it wrote, and it still wrote its share; every later one went on from
    // where the last stopped.
    const skipping = slices.filter((s) => s.skippedPages > 0);
    expect(skipping).toHaveLength(1);
    expect(skipping.every((s) => s.imported > 0)).toBe(true);

    // Every reading exactly once, none of them rewritten.
    const rows = await prisma.measurement.count({
      where: { userId: USER, type: "PULSE", source: "GOOGLE_HEALTH" },
    });
    expect(rows).toBe(points);
    expect(slices.reduce((sum, s) => sum + s.imported, 0)).toBe(points);
    const versions = await prisma.measurement.aggregate({
      where: { userId: USER, type: "PULSE", source: "GOOGLE_HEALTH" },
      _max: { syncVersion: true },
      _min: { syncVersion: true },
    });
    expect(versions._max.syncVersion).toBe(versions._min.syncVersion);
  }, 3_600_000);
});
