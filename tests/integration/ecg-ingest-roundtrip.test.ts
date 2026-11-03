/**
 * `POST /api/insights/ecg` end to end against real Postgres.
 *
 * Everything here goes through the actual route handlers — the ingest, the
 * metadata list, and the waveform detail — because the thing worth proving is
 * the assembly between them, not that each end works in isolation. What a
 * client receives is read out of the real GET responses, never rebuilt from a
 * fixture.
 *
 * The cross-door case is the point of the second unique index: the same
 * physical recording reaching the export-archive importer and the live route
 * carries two different source ids, and must still be one row.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

import {
  GET as getEcgList,
  POST as postEcg,
} from "@/app/api/insights/ecg/route";
import { GET as getEcgDetail } from "@/app/api/insights/ecg/[id]/route";
import { importAppleHealthEcg } from "@/lib/apple-health/ecg-import";

const USER_ID = "ecg-ingest-roundtrip";
const OTHER_USER_ID = "ecg-ingest-roundtrip-other";
const RECORDED_AT = "2026-07-18T08:14:03+02:00";
const SAMPLES = [12, -7, 3, 240, -180, 60];

type IngestBody = Record<string, unknown>;

function ingestPayload(overrides: IngestBody = {}): IngestBody {
  return {
    externalRecordingId: "8E1F3B0C-0000-4000-8000-000000000001",
    recordedAt: RECORDED_AT,
    samplingFrequency: 512,
    samples: [...SAMPLES],
    lead: "I",
    averageHeartRate: 64,
    classification: "NOT_DETECTED",
    source: "APPLE_HEALTH",
    ...overrides,
  };
}

async function ingest(body: IngestBody): Promise<{
  status: number;
  data: {
    id: string;
    status: string;
    recordedAt: string;
    sampleCount: number;
    durationSeconds: number | null;
  };
}> {
  const response = await postEcg(
    new NextRequest("http://localhost/api/insights/ecg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    data: (await response.json()).data,
  };
}

async function readList(): Promise<{
  recordings: Array<Record<string, unknown>>;
  hasRecordings: boolean;
}> {
  // The list handler declares no parameters; the wrapper still receives the
  // request, so hand it one the way the route's own unit test does.
  const callList = getEcgList as unknown as (
    request: NextRequest,
  ) => Promise<Response>;
  const response = await callList(
    new NextRequest("http://localhost/api/insights/ecg"),
  );
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

async function readDetail(
  id: string,
  full = false,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const url = full
    ? `http://localhost/api/insights/ecg/${id}?full=1`
    : `http://localhost/api/insights/ecg/${id}`;
  const response = await getEcgDetail(new NextRequest(url), {
    params: Promise.resolve({ id }),
  });
  return { response, body: (await response.json()).data };
}

async function signIn(userId: string): Promise<void> {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.createMany({
    data: [
      {
        id: USER_ID,
        username: "ecg-roundtrip",
        email: "ecg-roundtrip@example.test",
        timezone: "Europe/Berlin",
      },
      {
        id: OTHER_USER_ID,
        username: "ecg-roundtrip-other",
        email: "ecg-roundtrip-other@example.test",
        timezone: "Europe/Berlin",
      },
    ],
  });
  await signIn(USER_ID);
});

describe("POST /api/insights/ecg — round trip through the real routes", () => {
  it("stores a posted recording and serves it back through the list and the detail", async () => {
    const posted = await ingest(ingestPayload());
    expect(posted.status).toBe(201);
    expect(posted.data.status).toBe("inserted");
    expect(posted.data.sampleCount).toBe(SAMPLES.length);
    expect(posted.data.durationSeconds).toBeCloseTo(SAMPLES.length / 512, 10);

    const list = await readList();
    expect(list.hasRecordings).toBe(true);
    expect(list.recordings).toHaveLength(1);
    expect(list.recordings[0]).toMatchObject({
      id: posted.data.id,
      samplingFrequency: 512,
      sampleCount: SAMPLES.length,
      averageHeartRate: 64,
      lead: "I",
      classification: "NOT_DETECTED",
      source: "APPLE_HEALTH",
      hasWaveform: true,
    });
    expect(
      new Date(list.recordings[0].recordedAt as string).toISOString(),
    ).toBe(new Date(RECORDED_AT).toISOString());

    const detail = await readDetail(posted.data.id, true);
    expect(detail.response.status).toBe(200);
    expect(detail.body.samples).toEqual(SAMPLES);
    expect(detail.body.decimated).toBe(false);
    expect(detail.body.classification).toBe("NOT_DETECTED");
  });

  it("accepts the fractional heart rate and frequency HealthKit reports and rounds them (#1060)", async () => {
    // HealthKit hands both over as doubles; a watch's average heart rate is
    // often fractional. Requiring integers refused those recordings outright.
    const posted = await ingest(
      ingestPayload({ averageHeartRate: 64.7, samplingFrequency: 511.96 }),
    );
    expect(posted.status).toBe(201);
    expect(posted.data.status).toBe("inserted");

    const list = await readList();
    expect(list.recordings[0]).toMatchObject({
      averageHeartRate: 65,
      samplingFrequency: 512,
    });
    expect(posted.data.durationSeconds).toBeCloseTo(SAMPLES.length / 512, 10);
  });

  it("takes a whole sweep of recordings in one go (#1060)", async () => {
    // The app posts every recording its sweep has not consumed and restarts
    // the sweep after a 429; a limit below the sweep's size refused the same
    // last recording on every sync. Seventy distinct strips must all land.
    const statuses: number[] = [];
    for (let i = 0; i < 70; i += 1) {
      const posted = await ingest(
        ingestPayload({
          externalRecordingId: `sweep-${i}`,
          recordedAt: new Date(Date.UTC(2026, 5, 1, 8, i)).toISOString(),
        }),
      );
      statuses.push(posted.status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(await getPrismaClient().ecgRecording.count()).toBe(70);
  });

  it("never writes the waveform as plaintext", async () => {
    const posted = await ingest(ingestPayload());
    const row = await getPrismaClient().ecgRecording.findUniqueOrThrow({
      where: { id: posted.data.id },
    });
    const stored = Buffer.from(row.waveformEncrypted).toString("utf8");
    // The column holds the `<keyId>.<base64>` envelope and nothing else. A
    // serialised sample array cannot satisfy that shape — it carries
    // brackets, commas and minus signs — so this rules plaintext out without
    // asking whether some digit happens to appear in a base64 blob, which it
    // routinely does.
    expect(stored).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain(JSON.stringify(SAMPLES));
  });

  it("reports a re-post as updated and does not grow the table", async () => {
    const first = await ingest(ingestPayload());
    const second = await ingest(ingestPayload());

    expect(second.status).toBe(200);
    expect(second.data.status).toBe("updated");
    expect(second.data.id).toBe(first.data.id);
    expect(
      await getPrismaClient().ecgRecording.count({
        where: { userId: USER_ID },
      }),
    ).toBe(1);
    expect((await readList()).recordings).toHaveLength(1);
  });

  it("overwrites the stored recording in place when a re-post revises it", async () => {
    const first = await ingest(ingestPayload());
    const revised = [1, 2, 3, 4];
    const second = await ingest(
      ingestPayload({ samples: revised, classification: "IRREGULAR" }),
    );

    expect(second.data.status).toBe("updated");
    expect(second.data.id).toBe(first.data.id);
    const detail = await readDetail(first.data.id, true);
    expect(detail.body.samples).toEqual(revised);
    expect(detail.body.classification).toBe("IRREGULAR");
  });

  it("keeps one row when the same recording also arrives through the export archive", async () => {
    const posted = await ingest(ingestPayload());

    // The archive importer identifies the strip by a hash of its content, so
    // it arrives under a completely different externalRecordingId.
    const outcome = await importAppleHealthEcg({
      userId: USER_ID,
      ecg: {
        recordedAt: new Date(RECORDED_AT),
        samplingFrequency: 512,
        samples: [...SAMPLES],
        lead: "I",
        averageHeartRate: 64,
        rhythmClassification: "NOT_DETECTED",
      },
      prisma: getPrismaClient(),
    });

    expect(outcome).toBe("skipped");
    const rows = await getPrismaClient().ecgRecording.findMany({
      where: { userId: USER_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(posted.data.id);
    expect((await readList()).recordings).toHaveLength(1);
  });

  it("reports duplicate when the export archive got there first", async () => {
    await importAppleHealthEcg({
      userId: USER_ID,
      ecg: {
        recordedAt: new Date(RECORDED_AT),
        samplingFrequency: 512,
        samples: [...SAMPLES],
        lead: "I",
        averageHeartRate: 64,
        rhythmClassification: "NOT_DETECTED",
      },
      prisma: getPrismaClient(),
    });
    const archived = await getPrismaClient().ecgRecording.findFirstOrThrow({
      where: { userId: USER_ID },
    });

    const posted = await ingest(ingestPayload());
    expect(posted.status).toBe(200);
    expect(posted.data.status).toBe("duplicate");
    expect(posted.data.id).toBe(archived.id);
    expect(
      await getPrismaClient().ecgRecording.count({
        where: { userId: USER_ID },
      }),
    ).toBe(1);
    // Nothing was written: the archive's own external id still owns the row.
    expect(
      (
        await getPrismaClient().ecgRecording.findUniqueOrThrow({
          where: { id: archived.id },
        })
      ).externalRecordingId,
    ).toBe(archived.externalRecordingId);
  });

  it("stores distinct recordings distinctly", async () => {
    await ingest(ingestPayload());
    const other = await ingest(
      ingestPayload({
        externalRecordingId: "8E1F3B0C-0000-4000-8000-000000000002",
        recordedAt: "2026-07-19T08:14:03+02:00",
      }),
    );
    expect(other.data.status).toBe("inserted");
    expect((await readList()).recordings).toHaveLength(2);
  });

  it("writes to the session's user and cannot reach another account's rows", async () => {
    const mine = await ingest(ingestPayload());

    cookieJar.clear();
    await signIn(OTHER_USER_ID);
    // Same recording id, same instant — a different account entirely.
    const theirs = await ingest(ingestPayload());
    expect(theirs.status).toBe(201);
    expect(theirs.data.status).toBe("inserted");
    expect(theirs.data.id).not.toBe(mine.data.id);

    expect((await readList()).recordings).toHaveLength(1);
    const foreign = await readDetail(mine.data.id, true);
    expect(foreign.response.status).toBe(404);

    const owners = await getPrismaClient().ecgRecording.findMany({
      select: { userId: true },
    });
    expect(owners.map((r) => r.userId).sort()).toEqual(
      [USER_ID, OTHER_USER_ID].sort(),
    );
  });

  it("refuses a source a client is not allowed to claim", async () => {
    const response = await postEcg(
      new NextRequest("http://localhost/api/insights/ecg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ingestPayload({ source: "WITHINGS" })),
      }),
    );
    expect(response.status).toBe(422);
    expect(await getPrismaClient().ecgRecording.count()).toBe(0);
  });

  it("refuses a userId in the body rather than honouring it", async () => {
    const response = await postEcg(
      new NextRequest("http://localhost/api/insights/ecg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ingestPayload({ userId: OTHER_USER_ID })),
      }),
    );
    expect(response.status).toBe(422);
    expect(await getPrismaClient().ecgRecording.count()).toBe(0);
  });

  it("refuses an event verdict that cannot occur on an ECG", async () => {
    const response = await postEcg(
      new NextRequest("http://localhost/api/insights/ecg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ingestPayload({ classification: "VERY_LOW" })),
      }),
    );
    expect(response.status).toBe(422);
    expect(await getPrismaClient().ecgRecording.count()).toBe(0);
  });
});
