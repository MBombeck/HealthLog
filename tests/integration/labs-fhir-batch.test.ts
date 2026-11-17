/**
 * `POST /api/labs/fhir-batch` against a real Postgres (#1400):
 *
 *   - a batch is written, a panel's members carry its name, and sending the
 *     same batch again writes nothing;
 *   - a result already imported from an Apple Health export is recognised
 *     here by its identity;
 *   - a narrow Bearer token is refused, the login token admitted;
 *   - more than 200 records, or a `userId` field, is refused with 422;
 *   - an Idempotency-Key replays the first answer.
 *
 * Every fixture is synthetic.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { importAppleHealthClinicalLabs } from "@/lib/apple-health/clinical-labs-import";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-labs-fhir-batch-integration-32-bytes-min-123456";

const { hashToken } = await import("@/lib/auth/hmac");

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));
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

const prisma = getPrismaClient();
const USER_ID = "user-labs-fhir-batch";
const SOURCE_URL = "https://fhir.example-clinic.test/api/FHIR/R4";

function observation(
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    resourceType: "Observation",
    id,
    status: "final",
    category: [{ coding: [{ code: "laboratory" }] }],
    code: { text: `Analyte ${id}` },
    effectiveDateTime: "2025-05-01T07:00:00Z",
    valueQuantity: { value: 5, unit: "mmol/L" },
    ...extra,
  };
}

function record(resource: Record<string, unknown>) {
  return {
    resource,
    fhirVersion: "4.0.1",
    identifier: String(resource.id),
    sourceURL: SOURCE_URL,
    sourceName: "Example Clinic",
  };
}

function post(
  body: unknown,
  opts: { idempotencyKey?: string; bearer?: string } = {},
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest("http://localhost/api/labs/fhir-batch", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface BatchBody {
  data: {
    results: Array<{ index: number; status: string; reason?: string }>;
    inserted: number;
    duplicate: number;
    skipped: number;
    failed: number;
    outcome: string;
  };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: USER_ID,
      username: "labs-fhir-batch",
      email: "labs-fhir-batch@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + 3_600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

describe("POST /api/labs/fhir-batch", () => {
  it("writes a batch with its panel, and a resend writes nothing", async () => {
    const { POST } = await import("@/app/api/labs/fhir-batch/route");
    const body = {
      records: [
        record(
          observation("panel", {
            code: { text: "Electrolytes" },
            valueQuantity: undefined,
            hasMember: [{ reference: "Observation/na" }],
          }),
        ),
        record(observation("na", { code: { text: "Sodium" } })),
        record(observation("vital", { category: [{ text: "vital-signs" }] })),
        record(observation("nounit", { valueQuantity: { value: 1 } })),
      ],
    };
    const first = await POST(post(body));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as BatchBody;
    expect(firstJson.data).toMatchObject({
      inserted: 1,
      duplicate: 0,
      skipped: 2,
      failed: 1,
      outcome: "partial",
    });
    expect(firstJson.data.results).toEqual([
      { index: 0, status: "skipped", reason: "panel_header" },
      { index: 1, status: "inserted" },
      { index: 2, status: "skipped", reason: "not_lab" },
      { index: 3, status: "failed", reason: "missing_unit" },
    ]);
    const sodium = await prisma.labResult.findFirstOrThrow({
      where: { userId: USER_ID, analyte: "Sodium" },
    });
    expect(sodium).toMatchObject({
      source: "APPLE_HEALTH",
      panel: "Electrolytes",
      value: 5,
      unit: "mmol/L",
    });

    const second = await POST(post(body));
    const secondJson = (await second.json()) as BatchBody;
    expect(secondJson.data).toMatchObject({ inserted: 0, duplicate: 1 });
    expect(await prisma.labResult.count({ where: { userId: USER_ID } })).toBe(
      1,
    );
  });

  it("recognises a result an export already imported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "healthlog-fhir-batch-"));
    const path = join(dir, "export.zip");
    const resource = observation("shared", {
      code: { text: "Potassium" },
      valueQuantity: { value: 4.2, unit: "mmol/L" },
    });
    writeFileSync(
      path,
      zipSync({
        "apple_health_export/clinical-records/Observation-shared.json": strToU8(
          JSON.stringify(resource),
        ),
      }),
    );
    const fromExport = await importAppleHealthClinicalLabs({
      archivePath: path,
      userId: USER_ID,
      tz: "Europe/Berlin",
      references: [
        {
          path: "/clinical-records/Observation-shared.json",
          identifier: "shared",
          sourceURL: `${SOURCE_URL}/`,
          sourceName: "Example Clinic",
          fhirVersion: "4.0.1",
        },
      ],
    });
    expect(fromExport.imported).toBe(1);

    // The phone sends the same result, its value since corrected: the
    // identity still recognises it (first write wins).
    const { POST } = await import("@/app/api/labs/fhir-batch/route");
    const res = await POST(
      post({
        records: [
          record({
            ...resource,
            status: "corrected",
            valueQuantity: { value: 4.4, unit: "mmol/L" },
          }),
        ],
      }),
    );
    const json = (await res.json()) as BatchBody;
    expect(json.data.results).toEqual([{ index: 0, status: "duplicate" }]);
    const rows = await prisma.labResult.findMany({
      where: { userId: USER_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(4.2);
  });

  it("refuses a narrow token and admits the login token", async () => {
    const { POST } = await import("@/app/api/labs/fhir-batch/route");
    cookieJar.delete("healthlog_session");
    const narrow = "hlk_narrow_scope_labs_fhir_batch_token_value_0001";
    await prisma.apiToken.create({
      data: {
        userId: USER_ID,
        name: "narrow",
        tokenHash: hashToken(narrow),
        permissions: ["fhir:read"],
      },
    });
    headerJar.set("authorization", `Bearer ${narrow}`);
    const denied = await POST(
      post({ records: [record(observation("a"))] }, { bearer: narrow }),
    );
    expect(denied.status).toBe(403);
    expect(await prisma.labResult.count()).toBe(0);

    const full = "hlk_full_scope_labs_fhir_batch_token_value_00000002";
    await prisma.apiToken.create({
      data: {
        userId: USER_ID,
        name: "login",
        tokenHash: hashToken(full),
        permissions: ["*"],
      },
    });
    headerJar.set("authorization", `Bearer ${full}`);
    const admitted = await POST(
      post({ records: [record(observation("a"))] }, { bearer: full }),
    );
    expect(admitted.status).toBe(200);
    expect(await prisma.labResult.count()).toBe(1);
  });

  it("refuses more than 200 records and an unknown userId field", async () => {
    const { POST } = await import("@/app/api/labs/fhir-batch/route");
    const tooMany = await POST(
      post({
        records: Array.from({ length: 201 }, (_, i) =>
          record(observation(`r${i}`)),
        ),
      }),
    );
    expect(tooMany.status).toBe(422);

    const withUser = await POST(
      post({ userId: "someone-else", records: [record(observation("a"))] }),
    );
    expect(withUser.status).toBe(422);
    expect(await prisma.labResult.count()).toBe(0);
  });

  it("replays the first answer for a reused Idempotency-Key", async () => {
    const { POST } = await import("@/app/api/labs/fhir-batch/route");
    const body = { records: [record(observation("idem"))] };
    const key = "ios-labs-fhir-batch-0001";
    const first = await POST(post(body, { idempotencyKey: key }));
    expect(((await first.json()) as BatchBody).data.inserted).toBe(1);
    const second = await POST(post(body, { idempotencyKey: key }));
    expect(second.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(((await second.json()) as BatchBody).data.inserted).toBe(1);
    expect(await prisma.labResult.count()).toBe(1);
  });
});
