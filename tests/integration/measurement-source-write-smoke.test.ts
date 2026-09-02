import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { POST as postCsvImport } from "@/app/api/import/csv/route";
import { POST as postAppleHealthBatch } from "@/app/api/measurements/batch/route";
import { POST as postManualMeasurement } from "@/app/api/measurements/route";
import { hashToken } from "@/lib/auth/hmac";
import { encrypt } from "@/lib/crypto";
import { upsertFitbitMeasurements } from "@/lib/fitbit/sync-core";
import { upsertGoogleHealthMeasurements } from "@/lib/google-health/sync-core";
import { upsertScoreRow } from "@/lib/insights/score-row";
import { logMcpMeasurement } from "@/lib/mcp/writes";
import { logTelegramMeasurement } from "@/lib/measurements/create-from-telegram";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";
import { upsertNightscoutEntries } from "@/lib/nightscout/sync";
import { upsertOuraMeasurements } from "@/lib/oura/sync";
import { upsertPolarMeasurements } from "@/lib/polar/sync";
import { syncUserActivity } from "@/lib/withings/sync-activity";
import { upsertWhoopMeasurements } from "@/lib/whoop/sync-core";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// The factory is hoisted before static imports, so it resolves the shared jars
// inside the mock boundary rather than touching an uninitialised binding.
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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = "measurement-source-write-smoke";
const MEASURED_AT = new Date("2026-07-20T08:00:00.000Z");

type SourceCase = {
  expectedType: MeasurementType;
  expectedExternalId: string | null;
  write: () => Promise<void>;
};

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SOURCE_CASES = {
  MANUAL: {
    expectedType: "WEIGHT",
    expectedExternalId: null,
    write: async () => {
      const response = await postManualMeasurement(
        jsonRequest("http://localhost/api/measurements", {
          type: "WEIGHT",
          value: 72.4,
          measuredAt: MEASURED_AT.toISOString(),
        }),
      );
      expect(response.status).toBe(201);
    },
  },
  WITHINGS: {
    expectedType: "ACTIVITY_STEPS",
    expectedExternalId: `withings:activity:${USER_ID}:2026-07-20:steps`,
    write: async () => {
      await getPrismaClient().withingsConnection.create({
        data: {
          userId: USER_ID,
          withingsUserId: "withings-source-smoke",
          accessToken: encrypt("synthetic-access-token"),
          refreshToken: encrypt("synthetic-refresh-token"),
          tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
          scope: "user.metrics,user.activity",
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          status: 200,
          json: async () => ({
            status: 0,
            body: {
              activities: [{ date: "2026-07-20", steps: 7_654 }],
              more: false,
              offset: 0,
            },
          }),
        })),
      );
      await syncUserActivity(USER_ID);
      vi.unstubAllGlobals();
    },
  },
  IMPORT: {
    expectedType: "WEIGHT",
    expectedExternalId: "source-smoke-import",
    write: async () => {
      const csv = [
        "type,value,unit,measuredAt,glucoseContext,notes,externalId",
        "WEIGHT,71.8,kg,2026-07-20T08:02:00.000Z,,,source-smoke-import",
      ].join("\n");
      const response = await postCsvImport(
        new NextRequest("http://localhost/api/import/csv", {
          method: "POST",
          headers: { "content-type": "text/csv" },
          body: csv,
        }),
      );
      expect(response.status).toBe(200);
    },
  },
  APPLE_HEALTH: {
    expectedType: "WEIGHT",
    expectedExternalId: "source-smoke-apple-health",
    write: async () => {
      const response = await postAppleHealthBatch(
        jsonRequest("http://localhost/api/measurements/batch", {
          entries: [
            {
              hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
              value: 72.1,
              unit: "kg",
              startDate: "2026-07-20T08:03:00.000Z",
              endDate: "2026-07-20T08:03:00.000Z",
              externalId: "source-smoke-apple-health",
            },
          ],
        }),
      );
      expect(response.status).toBe(200);
    },
  },
  COMPUTED: {
    expectedType: "RECOVERY_SCORE",
    expectedExternalId: "source-smoke-computed:2026-07-20",
    write: async () => {
      await upsertScoreRow(getPrismaClient(), {
        userId: USER_ID,
        type: "RECOVERY_SCORE",
        externalIdPrefix: "source-smoke-computed:",
        score: 74,
        now: new Date("2026-07-21T08:00:00.000Z"),
      });
    },
  },
  WHOOP: {
    expectedType: "HRV_RMSSD",
    expectedExternalId: "source-smoke-whoop:hrv",
    write: async () => {
      await upsertWhoopMeasurements(USER_ID, [
        {
          type: "HRV_RMSSD",
          value: 58,
          unit: "ms",
          measuredAt: new Date("2026-07-20T08:04:00.000Z"),
          externalId: "source-smoke-whoop:hrv",
        },
      ]);
    },
  },
  FITBIT: {
    expectedType: "PULSE",
    expectedExternalId: "source-smoke-fitbit:pulse",
    write: async () => {
      await upsertFitbitMeasurements(USER_ID, [
        {
          type: "PULSE",
          value: 67,
          unit: "bpm",
          measuredAt: new Date("2026-07-20T08:05:00.000Z"),
          externalId: "source-smoke-fitbit:pulse",
        },
      ]);
    },
  },
  NIGHTSCOUT: {
    expectedType: "BLOOD_GLUCOSE",
    expectedExternalId: "ns:source-smoke-nightscout",
    write: async () => {
      await upsertNightscoutEntries(USER_ID, [
        {
          id: "source-smoke-nightscout",
          sgv: 101,
          date: new Date("2026-07-20T08:06:00.000Z").getTime(),
        },
      ]);
    },
  },
  POLAR: {
    expectedType: "HRV_RMSSD",
    expectedExternalId: "source-smoke-polar:hrv",
    write: async () => {
      await upsertPolarMeasurements(USER_ID, [
        {
          type: "HRV_RMSSD",
          value: 61,
          unit: "ms",
          measuredAt: new Date("2026-07-20T08:07:00.000Z"),
          externalId: "source-smoke-polar:hrv",
        },
      ]);
    },
  },
  OURA: {
    expectedType: "HRV_RMSSD",
    expectedExternalId: "source-smoke-oura:hrv",
    write: async () => {
      await upsertOuraMeasurements(USER_ID, [
        {
          type: "HRV_RMSSD",
          value: 63,
          unit: "ms",
          measuredAt: new Date("2026-07-20T08:08:00.000Z"),
          externalId: "source-smoke-oura:hrv",
        },
      ]);
    },
  },
  TELEGRAM: {
    expectedType: "WEIGHT",
    expectedExternalId: "telegram:source-smoke",
    write: async () => {
      const result = await logTelegramMeasurement({
        userId: USER_ID,
        type: "WEIGHT",
        rawText: "72.7",
        tz: "UTC",
        externalId: "telegram:source-smoke",
      });
      expect(result.status).toBe("ok");
    },
  },
  MCP: {
    expectedType: "WEIGHT",
    expectedExternalId: `mcp:measure:${createHash("sha256")
      .update("source-smoke-mcp")
      .digest("hex")}`,
    write: async () => {
      const result = await logMcpMeasurement({
        userId: USER_ID,
        type: "WEIGHT",
        value: 72.9,
        measuredAt: new Date("2026-07-20T08:10:00.000Z"),
        idempotencyKey: "source-smoke-mcp",
      });
      expect(result.status).toBe("written");
    },
  },
  GOOGLE_HEALTH: {
    expectedType: "PULSE",
    expectedExternalId: "source-smoke-google-health:pulse",
    write: async () => {
      await upsertGoogleHealthMeasurements(USER_ID, [
        {
          type: "PULSE",
          value: 69,
          unit: "bpm",
          measuredAt: new Date("2026-07-20T08:11:00.000Z"),
          externalId: "source-smoke-google-health:pulse",
        },
      ]);
    },
  },
  // Strava's provider sync writes Workout rows only. There is no dedicated
  // Strava Measurement writer, so this case uses the shared external-
  // measurement reconciliation service, the narrowest production write path.
  STRAVA: {
    expectedType: "PULSE",
    expectedExternalId: "source-smoke-strava:pulse",
    write: async () => {
      const verdict = await getPrismaClient().$transaction((tx) =>
        reconcileExternalMeasurement(tx, {
          userId: USER_ID,
          type: "PULSE",
          source: "STRAVA",
          value: 66,
          unit: "bpm",
          measuredAt: new Date("2026-07-20T08:12:00.000Z"),
          externalId: "source-smoke-strava:pulse",
        }),
      );
      expect(verdict.status).toBe("inserted");
    },
  },
  // v1.38.x — the third-party ingest token. Written through the ordinary
  // single-entry POST, because that IS the production path: the route reads
  // the credential and resolves the source itself. The body names none — one
  // that did would be refused 422.
  EXTERNAL: {
    expectedType: "PULSE",
    expectedExternalId: null,
    write: async () => {
      // The trap in this suite: `beforeEach` seeds a session cookie and the
      // caller resolver is cookie-first, so arming only the `authorization`
      // header would resolve as that session and quietly write MANUAL — the
      // case would then fail on a row it never actually tested. Clear the
      // cookie for the duration, then put it back: this is the last case
      // today, but nothing stops one being appended after it.
      const prisma = getPrismaClient();
      const session = cookieJar.get("healthlog_session");
      cookieJar.clear();

      const raw = `hlk_external_${"0".repeat(48)}`;
      await prisma.apiToken.create({
        data: {
          userId: USER_ID,
          name: "source-smoke-external",
          tokenHash: hashToken(raw),
          permissions: [MEASUREMENTS_WRITE_SCOPE],
        },
      });
      headerJar.set("authorization", `Bearer ${raw}`);

      try {
        const response = await postManualMeasurement(
          jsonRequest("http://localhost/api/measurements", {
            type: "PULSE",
            value: 61,
            measuredAt: MEASURED_AT.toISOString(),
          }),
        );
        expect(response.status).toBe(201);
      } finally {
        headerJar.delete("authorization");
        if (session) cookieJar.set("healthlog_session", session);
      }
    },
  },
} satisfies Record<MeasurementSource, SourceCase>;

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "measurement-source-smoke",
      email: "measurement-source-smoke@example.test",
      timezone: "UTC",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MeasurementSource write paths against real Postgres", () => {
  it("commits and rereads exactly one Measurement for every source", async () => {
    const prisma = getPrismaClient();
    const sourceCases = Object.entries(SOURCE_CASES) as Array<
      [MeasurementSource, SourceCase]
    >;

    for (const [source, sourceCase] of sourceCases) {
      await sourceCase.write();

      const rows = await prisma.measurement.findMany({
        where: { userId: USER_ID, source },
      });
      expect(rows, `${source} committed row`).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source,
        type: sourceCase.expectedType,
        externalId: sourceCase.expectedExternalId,
      });
    }

    expect(sourceCases).toHaveLength(15);
    expect(await prisma.measurement.count({ where: { userId: USER_ID } })).toBe(
      15,
    );
  });
});
