/**
 * v1.37.13 — Health Score GLYCAEMIA + LIPIDS pillars through a real
 * Postgres round trip of `GET /api/analytics`.
 *
 * The score reader joins each LabResult to its linked Biomarker for the
 * canonical name, unit and reference bounds. The Biomarker columns are
 * `lowerBound` / `upperBound`; a select that asks the relation for the
 * LabResult's own `referenceLow` / `referenceHigh` names is rejected by
 * the Prisma client at query-validation time — before any row is read —
 * which turns EVERY labs read into `read_failed` and parks both pillars
 * on "Data could not be loaded" permanently, Retry included. A mocked
 * client cannot catch that class, so these cases run the real join.
 *
 * Two contracts:
 *
 *   1. A linked HbA1c reading and a lipid reading whose reference range
 *      lives ONLY on the biomarker catalog row (the per-row bounds left
 *      NULL) score both pillars — the join delivers name, unit and the
 *      catalog bounds.
 *   2. A labs-enabled account with no lab rows reads as `not_tracked` —
 *      an honest "nothing recorded", never `read_failed`, which is
 *      reserved for a read that genuinely failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface PillarEnvelope {
  id: string;
  result: {
    status: "ok" | "insufficient";
    reason?: string;
    value?: { score: number; observed: { value: number } };
  };
}

interface AnalyticsEnvelope {
  data: {
    healthScore: { pillars: PillarEnvelope[] } | null;
  } | null;
}

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
      heightCm: 178,
      dateOfBirth: new Date("1985-07-09"),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

async function fetchScorePillars() {
  const { GET } = await import("@/app/api/analytics/route");
  const res = await (GET as (req: Request) => Promise<Response>)(
    new Request("http://localhost/api/analytics"),
  );
  expect(res.status).toBe(200);
  const env = (await res.json()) as AnalyticsEnvelope;
  const pillars = env.data!.healthScore!.pillars;
  return new Map(pillars.map((p) => [p.id, p]));
}

describe("GET /api/analytics — labs-fed score pillars (biomarker join)", () => {
  it("scores GLYCAEMIA and LIPIDS from lab rows joined to their biomarker", async () => {
    const user = await seedSession("hs-labs-join");
    const prisma = getPrismaClient();
    const takenAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const hba1c = await prisma.biomarker.create({
      data: {
        userId: user.id,
        name: "HbA1c",
        unit: "%",
        lowerBound: 5,
        upperBound: 5.6,
      },
    });
    await prisma.labResult.create({
      data: {
        userId: user.id,
        biomarkerId: hba1c.id,
        analyte: "HbA1c",
        value: 5.2,
        unit: "%",
        takenAt,
      },
    });

    // The lipid row deliberately carries NO per-row reference bounds: the
    // range the pillar grades against must arrive through the biomarker
    // join, which is exactly the leg the wrong select severed.
    const ldl = await prisma.biomarker.create({
      data: {
        userId: user.id,
        name: "LDL Cholesterol",
        unit: "mg/dL",
        upperBound: 130,
      },
    });
    await prisma.labResult.create({
      data: {
        userId: user.id,
        biomarkerId: ldl.id,
        analyte: "ldl",
        value: 110,
        unit: "mg/dL",
        takenAt,
      },
    });

    const byId = await fetchScorePillars();

    const glycaemia = byId.get("GLYCAEMIA")!;
    expect(glycaemia.result.reason).not.toBe("read_failed");
    expect(glycaemia.result.status).toBe("ok");
    expect(glycaemia.result.value!.observed.value).toBe(5.2);

    const lipids = byId.get("LIPIDS")!;
    expect(lipids.result.reason).not.toBe("read_failed");
    expect(lipids.result.status).toBe("ok");
    expect(lipids.result.value!.score).toBeGreaterThan(0);
  });

  it("reads not_tracked, never read_failed, when a labs account has no rows", async () => {
    await seedSession("hs-labs-empty");

    const byId = await fetchScorePillars();

    const glycaemia = byId.get("GLYCAEMIA")!;
    expect(glycaemia.result.status).toBe("insufficient");
    expect(glycaemia.result.reason).toBe("not_tracked");

    const lipids = byId.get("LIPIDS")!;
    expect(lipids.result.status).toBe("insufficient");
    expect(lipids.result.reason).toBe("not_tracked");
  });
});
