/**
 * The Android Health Connect sync against a real Postgres (v1.50.0).
 *
 * Pinned here: the pairing exchange and the token it mints; that a record
 * sent live lands on the row an export of the same record writes (the golden
 * comparison: every row the export import wrote, the live sync writes
 * identically, and re-sending it to the account the export filled changes
 * nothing); deletes by record id, series and stages included; the required
 * Idempotency-Key and its replay; the 429 with Retry-After; and that removing
 * the device locks the phone out.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { buildHealthConnectFixture } from "../fixtures/health-connect/build-fixture";
import { callRoute, anonymous } from "../kit/call-route";
import { makeSession, makeUser } from "../kit/factories";
import { importHealthConnectExport } from "@/lib/import/health-connect/import";
import { hcUuid } from "@/lib/import/health-connect/reader";
import { HC_INSTANT_RECORD_TABLES } from "@/lib/validations/health-connect-sync";
import { checkRateLimit } from "@/lib/rate-limit";
import { POST as mintPairing } from "@/app/api/health-connect/pairing/route";
import { POST as pair } from "@/app/api/health-connect/pair/route";
import { GET as readState } from "@/app/api/health-connect/state/route";
import { POST as postBatch } from "@/app/api/health-connect/batch/route";
import { DELETE as deleteDevice } from "@/app/api/auth/me/devices/[id]/route";

vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn().mockResolvedValue(undefined),
}));

const DAY = 86_400_000;
const scratch = mkdtempSync(join(tmpdir(), "hl-hc-sync-"));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Paired {
  userId: string;
  auth: {
    kind: "bearer";
    userId: string;
    token: string;
    tokenId: string;
    permissions: string[];
  };
  deviceId: string;
}

async function pairDevice(
  installId = "install-0123456789abcdef",
): Promise<Paired> {
  const user = await makeUser({ timezone: "Europe/Berlin" });
  const session = await makeSession(user);
  const minted = await callRoute<{ code: string; link: string }>(mintPairing, {
    method: "POST",
    route: "/api/health-connect/pairing",
    auth: session,
  });
  expect(minted.status).toBe(200);
  expect(minted.data.link).toContain(encodeURIComponent(minted.data.code));
  const paired = await callRoute<{ token: string; deviceId: string }>(pair, {
    method: "POST",
    route: "/api/health-connect/pair",
    auth: anonymous,
    body: {
      code: minted.data.code,
      installId,
      deviceModel: "Pixel 8",
      appVersion: "0.1.0",
    },
  });
  expect(paired.status).toBe(200);
  const row = await getPrismaClient().apiToken.findFirstOrThrow({
    where: {
      userId: user.id,
      revoked: false,
      permissions: { has: "health-connect:write" },
    },
  });
  return {
    userId: user.id,
    deviceId: paired.data.deviceId,
    auth: {
      kind: "bearer",
      userId: user.id,
      token: paired.data.token,
      tokenId: row.id,
      permissions: row.permissions,
    },
  };
}

type Result = { kind: string; index: number; status: string; reason?: string };

let keySeq = 0;
async function send(p: Paired, body: Record<string, unknown>, key?: string) {
  return callRoute<{ accepted: number; results: Result[] }>(postBatch, {
    method: "POST",
    route: "/api/health-connect/batch",
    auth: p.auth,
    headers: {
      "Idempotency-Key": key ?? `batch-key-${++keySeq}-${Date.now()}`,
    },
    body,
  });
}

// ── The fixture as the app would send it ─────────────────────────────────

const COMMON_COLUMNS = new Set([
  "row_id",
  "uuid",
  "last_modified_time",
  "client_record_id",
  "client_record_version",
  "device_info_id",
  "app_info_id",
  "recording_method",
  "dedupe_hash",
  "time",
  "zone_offset",
  "local_date",
  "local_date_time",
]);

/** Every record of the export database, serialised the way the app does. */
function recordsFromExport(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const deviceType = new Map(
      (
        db
          .prepare("SELECT row_id, device_type FROM device_info_table")
          .all() as Array<{
          row_id: number;
          device_type: number;
        }>
      ).map((r) => [r.row_id, r.device_type]),
    );
    const pkg = new Map(
      (
        db
          .prepare("SELECT row_id, package_name FROM application_info_table")
          .all() as Array<{
          row_id: number;
          package_name: string;
        }>
      ).map((r) => [r.row_id, r.package_name]),
    );
    const iso = (ms: number) => new Date(ms).toISOString();
    const base = (row: Record<string, unknown>) => ({
      id: hcUuid(row.uuid)!,
      package: pkg.get(row.app_info_id as number),
      ...(typeof row.device_info_id === "number"
        ? { deviceType: deviceType.get(row.device_info_id) }
        : {}),
    });
    const out: Array<Record<string, unknown>> = [];
    for (const [type, table] of Object.entries(HC_INSTANT_RECORD_TABLES)) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Array<
        Record<string, unknown>
      >) {
        const fields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
          if (COMMON_COLUMNS.has(k)) continue;
          if (typeof v === "number" || typeof v === "string") fields[k] = v;
        }
        out.push({
          ...base(row),
          type,
          time: iso(row.time as number),
          zoneOffsetSeconds: row.zone_offset,
          fields,
        });
      }
    }
    for (const row of db
      .prepare("SELECT * FROM heart_rate_record_table")
      .all() as Array<Record<string, unknown>>) {
      const samples = (
        db
          .prepare(
            "SELECT epoch_millis, beats_per_minute FROM heart_rate_record_series_table WHERE parent_key = ? ORDER BY epoch_millis",
          )
          .all(row.row_id as number) as Array<{
          epoch_millis: number;
          beats_per_minute: number;
        }>
      ).map((s) => ({ time: iso(s.epoch_millis), bpm: s.beats_per_minute }));
      out.push({
        ...base(row),
        type: "HeartRateRecord",
        start: iso(row.start_time as number),
        end: iso(row.end_time as number),
        samples,
      });
    }
    for (const row of db
      .prepare("SELECT * FROM sleep_session_record_table")
      .all() as Array<Record<string, unknown>>) {
      const stages = (
        db
          .prepare(
            "SELECT stage_start_time, stage_end_time, stage_type FROM sleep_stages_table WHERE parent_key = ?",
          )
          .all(row.row_id as number) as Array<{
          stage_start_time: number;
          stage_end_time: number;
          stage_type: number;
        }>
      ).map((s) => ({
        start: iso(s.stage_start_time),
        end: iso(s.stage_end_time),
        stage: s.stage_type,
      }));
      out.push({
        ...base(row),
        type: "SleepSessionRecord",
        start: iso(row.start_time as number),
        end: iso(row.end_time as number),
        stages,
      });
    }
    for (const row of db
      .prepare("SELECT * FROM exercise_session_record_table")
      .all() as Array<Record<string, unknown>>) {
      out.push({
        ...base(row),
        type: "ExerciseSessionRecord",
        start: iso(row.start_time as number),
        end: iso(row.end_time as number),
        exerciseType: row.exercise_type,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/** Send records in batches inside the item and sample caps. */
async function sendAll(p: Paired, records: Array<Record<string, unknown>>) {
  const results: Result[] = [];
  let chunk: Array<Record<string, unknown>> = [];
  let samples = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    const res = await send(p, { phase: "backfill", records: chunk });
    expect(res.status).toBe(200);
    results.push(...res.data.results);
    chunk = [];
    samples = 0;
  };
  for (const r of records) {
    const n = Array.isArray(r.samples) ? r.samples.length : 0;
    if (chunk.length >= 500 || samples + n > 5000) await flush();
    chunk.push(r);
    samples += n;
  }
  await flush();
  return results;
}

const ROW_SELECT = {
  type: true,
  externalId: true,
  value: true,
  valueMin: true,
  valueMax: true,
  unit: true,
  measuredAt: true,
  sleepStage: true,
  glucoseContext: true,
  deviceType: true,
} as const;

async function hcRows(userId: string) {
  const rows = await getPrismaClient().measurement.findMany({
    where: {
      userId,
      source: "HEALTH_CONNECT",
      deletedAt: null,
      externalId: { startsWith: "hc:" },
    },
    select: ROW_SELECT,
  });
  return new Map(rows.map((r) => [`${r.type}|${r.externalId}`, r]));
}

describe("pairing", () => {
  it("exchanges a code once for a narrow token bound to a device", async () => {
    const user = await makeUser();
    const session = await makeSession(user);
    const minted = await callRoute<{
      code: string;
      expiresAt: string;
      link: string;
    }>(mintPairing, {
      method: "POST",
      route: "/api/health-connect/pairing",
      auth: session,
    });
    expect(minted.data.code).toMatch(/^hcp_[0-9a-f]{32}$/);
    expect(minted.data.link).toMatch(/^healthlog-sync:\/\/pair\?server=/);
    const body = { code: minted.data.code, installId: "abcdefghijklmnop" };
    const first = await callRoute<{
      token: string;
      tokenExpiresAt: string;
      deviceId: string;
    }>(pair, {
      method: "POST",
      route: "/api/health-connect/pair",
      auth: anonymous,
      body,
    });
    expect(first.status).toBe(200);
    expect(first.data.token).toMatch(/^hlk_/);
    const lifetime = Date.parse(first.data.tokenExpiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(364 * DAY);
    const token = await getPrismaClient().apiToken.findFirstOrThrow({
      where: { userId: user.id, permissions: { has: "health-connect:write" } },
    });
    expect(token.permissions).toEqual(["health-connect:write"]);
    const device = await getPrismaClient().device.findUniqueOrThrow({
      where: { id: first.data.deviceId },
    });
    expect(device).toMatchObject({
      platform: "android",
      apiTokenId: token.id,
      userId: user.id,
    });

    const again = await callRoute(pair, {
      method: "POST",
      route: "/api/health-connect/pair",
      auth: anonymous,
      body,
    });
    expect(again.status).toBe(401);
    expect(again.meta?.errorCode).toBe("health-connect.pair.code_invalid");
  });

  it("re-pairing the same install revokes its previous token", async () => {
    const first = await pairDevice("same-install-000000");
    const session = await makeSession({ id: first.userId });
    const minted = await callRoute<{ code: string }>(mintPairing, {
      method: "POST",
      route: "/api/health-connect/pairing",
      auth: session,
    });
    const second = await callRoute<{ deviceId: string }>(pair, {
      method: "POST",
      route: "/api/health-connect/pair",
      auth: anonymous,
      body: { code: minted.data.code, installId: "same-install-000000" },
    });
    expect(second.data.deviceId).toBe(first.deviceId);
    const old = await getPrismaClient().apiToken.findUniqueOrThrow({
      where: { id: first.auth.tokenId },
    });
    expect(old.revoked).toBe(true);
  });

  it("answers state to the device token and refuses a session", async () => {
    const p = await pairDevice();
    const state = await callRoute<{
      wantedTypes: string[];
      rawHeartRateDays: number;
      types: Record<string, unknown>;
    }>(readState, {
      method: "GET",
      route: "/api/health-connect/state",
      auth: p.auth,
    });
    expect(state.status).toBe(200);
    expect(state.data.wantedTypes).toContain("WeightRecord");
    expect(state.data.rawHeartRateDays).toBe(90);
    expect(Object.keys(state.data.types)).toContain("SleepSessionRecord");

    const session = await makeSession({ id: p.userId });
    const refused = await callRoute(readState, {
      method: "GET",
      route: "/api/health-connect/state",
      auth: session,
    });
    expect(refused.status).toBe(403);
    expect(refused.meta?.errorCode).toBe(
      "health-connect.device_token_required",
    );
  });

  it("locks the phone out once the device is removed", async () => {
    const p = await pairDevice();
    const session = await makeSession({ id: p.userId });
    const removed = await callRoute(deleteDevice, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: p.deviceId },
      auth: session,
    });
    expect(removed.status).toBe(200);
    const after = await callRoute(readState, {
      method: "GET",
      route: "/api/health-connect/state",
      auth: p.auth,
      contract: { skip: "401 from the generic gate" },
    });
    expect(after.status).toBe(401);
  });
});

describe("one record, one row: export and live sync", () => {
  it("writes every row the export import wrote, identically", async () => {
    const path = join(scratch, "golden.db");
    buildHealthConnectFixture(path, { days: 3 });
    const exportUser = await makeUser({ timezone: "Europe/Berlin" });
    await importHealthConnectExport({
      prisma: getPrismaClient(),
      dbPath: path,
      userId: exportUser.id,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
    });
    const exported = await hcRows(exportUser.id);
    expect(exported.size).toBeGreaterThan(50);

    const p = await pairDevice();
    const results = await sendAll(p, recordsFromExport(path));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    const live = await hcRows(p.userId);
    const missing: string[] = [];
    const differ: string[] = [];
    for (const [key, row] of exported) {
      const twin = live.get(key);
      if (!twin) missing.push(key);
      else if (JSON.stringify(twin) !== JSON.stringify(row)) differ.push(key);
    }
    expect(missing).toEqual([]);
    expect(differ).toEqual([]);

    const workouts = (userId: string) =>
      getPrismaClient().workout.findMany({
        where: { userId, source: "HEALTH_CONNECT" },
        select: {
          externalId: true,
          sportType: true,
          startedAt: true,
          endedAt: true,
          durationSec: true,
          metadata: true,
        },
        orderBy: { externalId: "asc" },
      });
    const exportedWorkouts = await workouts(exportUser.id);
    const liveWorkouts = new Map(
      (await workouts(p.userId)).map((w) => [w.externalId, w]),
    );
    for (const w of exportedWorkouts)
      expect(liveWorkouts.get(w.externalId)).toEqual(w);
  });

  it("finds the export's rows already there and changes nothing", async () => {
    const path = join(scratch, "golden-same.db");
    buildHealthConnectFixture(path, { days: 2 });
    const p = await pairDevice();
    await importHealthConnectExport({
      prisma: getPrismaClient(),
      dbPath: path,
      userId: p.userId,
      userTimezone: "Europe/Berlin",
      connectedIntegrations: [],
    });
    const before = await hcRows(p.userId);
    const records = recordsFromExport(path);
    const results = await sendAll(p, records);
    const after = await hcRows(p.userId);
    for (const [key, row] of before) {
      expect(JSON.stringify(after.get(key))).toBe(JSON.stringify(row));
    }
    expect(results.filter((r) => r.status === "updated")).toEqual([]);

    // A day total the export wrote, sent as the aggregate Health Connect
    // computes: the same `stats:` row, unchanged.
    const steps = await getPrismaClient().measurement.findFirstOrThrow({
      where: {
        userId: p.userId,
        type: "ACTIVITY_STEPS",
        source: "HEALTH_CONNECT",
      },
      select: { externalId: true, value: true },
    });
    const day = steps.externalId!.slice(-10);
    const agg = await send(p, {
      phase: "live",
      aggregates: [{ metric: "STEPS_COUNT_TOTAL", day, value: steps.value }],
    });
    expect(agg.data.results).toEqual([
      { kind: "aggregate", index: 0, status: "unchanged" },
    ]);
    const overwrite = await send(p, {
      phase: "live",
      aggregates: [
        { metric: "STEPS_COUNT_TOTAL", day, value: steps.value + 100 },
      ],
    });
    expect(overwrite.data.results[0]!.status).toBe("updated");
  });
});

describe("batch", () => {
  const t0 = Date.now() - 2 * DAY;
  const uuid = (n: number) =>
    `${n.toString(16).padStart(8, "0")}-aaaa-4bbb-8ccc-${n.toString(16).padStart(12, "0")}`;
  const weight = (n: number, grams: number) => ({
    id: uuid(n),
    type: "WeightRecord",
    time: new Date(t0 + n * 60_000).toISOString(),
    zoneOffsetSeconds: 3600,
    fields: { weight: grams },
  });

  it("answers per item: written, malformed, unwanted, unmappable", async () => {
    const p = await pairDevice();
    const res = await send(p, {
      phase: "live",
      records: [
        weight(1, 81_250),
        { id: "not-a-uuid", type: "WeightRecord" },
        { id: uuid(2), type: "StepsCadenceRecord" },
        { ...weight(3, 0), fields: {} },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.data.results).toEqual([
      { kind: "record", index: 0, status: "inserted" },
      { kind: "record", index: 1, status: "rejected", reason: "malformed" },
      {
        kind: "record",
        index: 2,
        status: "skipped",
        reason: "type_not_wanted",
      },
      { kind: "record", index: 3, status: "skipped", reason: "no_value" },
    ]);
    expect(res.data.accepted).toBe(3);
    const row = await getPrismaClient().measurement.findFirstOrThrow({
      where: { userId: p.userId, externalId: `hc:${uuid(1)}` },
    });
    expect(row).toMatchObject({
      type: "WEIGHT",
      value: 81.25,
      source: "HEALTH_CONNECT",
    });
  });

  it("deletes a sleep session with its stages, and a second delete finds nothing", async () => {
    const p = await pairDevice();
    const start = t0;
    const session = {
      id: uuid(7),
      type: "SleepSessionRecord",
      start: new Date(start).toISOString(),
      end: new Date(start + 3 * 3_600_000).toISOString(),
      stages: [
        {
          start: new Date(start).toISOString(),
          end: new Date(start + 3_600_000).toISOString(),
          stage: 4,
        },
        {
          start: new Date(start + 3_600_000).toISOString(),
          end: new Date(start + 3 * 3_600_000).toISOString(),
          stage: 5,
        },
      ],
    };
    await send(p, { phase: "live", records: [session] });
    const live = () =>
      getPrismaClient().measurement.count({
        where: {
          userId: p.userId,
          externalId: { startsWith: `hc:${uuid(7)}` },
          deletedAt: null,
        },
      });
    expect(await live()).toBe(2);
    const del = await send(p, {
      phase: "live",
      deletes: [uuid(7).toUpperCase()],
    });
    expect(del.data.results).toEqual([
      { kind: "delete", index: 0, status: "deleted" },
    ]);
    expect(await live()).toBe(0);
    const again = await send(p, { phase: "live", deletes: [uuid(7)] });
    expect(again.data.results).toEqual([
      { kind: "delete", index: 0, status: "not_found" },
    ]);
    // A row deleted stays deleted when the record comes again.
    const back = await send(p, { phase: "live", records: [session] });
    expect(back.data.results[0]).toMatchObject({
      status: "skipped",
      reason: "deleted_in_healthlog",
    });
  });

  it("requires an Idempotency-Key and replays a retry", async () => {
    const p = await pairDevice();
    const none = await callRoute(postBatch, {
      method: "POST",
      route: "/api/health-connect/batch",
      auth: p.auth,
      body: { phase: "live", records: [weight(4, 80_000)] },
    });
    expect(none.status).toBe(400);
    expect(none.meta?.errorCode).toBe(
      "health-connect.batch.idempotency_key_required",
    );
    const body = { phase: "live", records: [weight(5, 80_000)] };
    const first = await send(p, body, "replay-key-0001");
    const second = await send(p, body, "replay-key-0001");
    expect(second.headers.get("x-idempotent-replay")).toBe("true");
    expect(second.data).toEqual(first.data);
  });

  it("answers 429 with Retry-After once the account's bucket is spent", async () => {
    const p = await pairDevice();
    for (let i = 0; i < 60; i++) {
      await checkRateLimit(`health-connect:batch:${p.userId}`, 60, 60_000);
    }
    const res = await send(p, { phase: "live", records: [weight(6, 80_000)] });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("refuses a batch over the caps before writing anything", async () => {
    const p = await pairDevice();
    const res = await send(p, {
      phase: "live",
      records: Array.from({ length: 300 }, (_, i) => weight(i + 10, 80_000)),
      deletes: Array.from({ length: 201 }, (_, i) => uuid(i + 1000)),
    });
    expect(res.status).toBe(422);
    expect(res.meta?.errorCode).toBe("health-connect.batch.too_large");
  });

  it("stamps the device for the stall rule on a live batch only", async () => {
    const p = await pairDevice();
    await send(p, { phase: "backfill", records: [weight(20, 80_000)] });
    let device = await getPrismaClient().device.findUniqueOrThrow({
      where: { id: p.deviceId },
    });
    expect(device.healthIngestAt).toBeNull();
    await send(p, { phase: "live", records: [weight(21, 80_500)] });
    device = await getPrismaClient().device.findUniqueOrThrow({
      where: { id: p.deviceId },
    });
    expect(device.healthIngestAt).not.toBeNull();
  });
});
