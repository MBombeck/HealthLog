/**
 * Apple Health symptom samples against real Postgres and through the real
 * routes (migration 0510): `POST /api/symptoms/events/batch` and
 * `DELETE /api/symptoms/events/by-external-ids`.
 *
 * What only a real database can answer:
 *
 *   - a first sample creates the built-in definition for its code, labelled
 *     in the record owner's language, and lands on it; a renamed or hidden
 *     built-in still takes the next sample;
 *   - built-in definitions hold no slot of the eight-definition cap, in
 *     either direction;
 *   - the `(userId, source, externalId)` key answers a re-post `duplicate`,
 *     and so does a re-post of a deleted sample: the tombstone keeps it out;
 *   - the per-entry skips are terminal and leave the rest of the batch alone;
 *   - another account's externalId is a different sample, and its delete
 *     touches nothing here;
 *   - a deleted import leaves every reader: the list, the definitions'
 *     summary, the timeline;
 *   - a disaster-recovery backup carries the new columns and the tombstone.
 *
 * Mutation checks (each run, each seen red):
 *   - leave tombstones out of the stored-id lookup (`deletedAt: null`) AND
 *     drop `skipDuplicates` → "a re-post of a deleted sample stays deleted"
 *     goes red. Either one alone stays green: the unique index on
 *     `(userId, source, externalId)` still turns the insert into a duplicate,
 *     which is the second line of defence it is meant to be;
 *   - count built-in definitions in `countCappedSymptomDefinitions` → "holds
 *     no slot of the cap" goes red;
 *   - drop `deletedAt: null` from the events list → "leaves every reader"
 *     goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { NextRequest } from "next/server";

import { decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  buildSymptomsBackupSection,
  restoreSymptomsData,
} from "@/lib/export/symptoms-backup";
import type { RestoreSkipLog } from "@/lib/export/restore-skips";
import { loadSymptomSeries } from "@/lib/timeline/symptom-series";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const OWNER_ID = "ah-symptoms-owner";
const OTHER_ID = "ah-symptoms-other";

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

interface Envelope<T> {
  data: T;
  error: string | null;
  meta?: { errorCode?: string };
}

interface BatchResult {
  processed: number;
  inserted: number;
  updated: number;
  duplicates: number;
  failed: number;
  skipped: Array<{ index: number; reason: string }>;
  entries: Array<{ index: number; status: string; reason?: string }>;
}

async function call(
  handler: unknown,
  method: string,
  path: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<Response> {
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (handler as Handler)(request, { params: Promise.resolve(params) });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const HOUR = 3_600_000;

function sample(
  externalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    code: "FEVER",
    occurredAt: new Date(Date.now() - 2 * HOUR).toISOString(),
    intensity: 6,
    externalId,
    source: "APPLE_HEALTH",
    ...overrides,
  };
}

async function postBatch(entries: unknown[]): Promise<Response> {
  const { POST } = await import("@/app/api/symptoms/events/batch/route");
  return call(POST, "POST", "/api/symptoms/events/batch", { entries });
}

async function ingest(entries: unknown[]): Promise<BatchResult> {
  const response = await postBatch(entries);
  expect(response.status).toBe(200);
  return (await json<Envelope<BatchResult>>(response)).data;
}

async function deleteByExternalIds(externalIds: string[]): Promise<Response> {
  const { DELETE } =
    await import("@/app/api/symptoms/events/by-external-ids/route");
  return call(DELETE, "DELETE", "/api/symptoms/events/by-external-ids", {
    externalIds,
  });
}

async function listEvents(): Promise<
  Array<{ id: string; source: string; externalId: string | null }>
> {
  const { GET } = await import("@/app/api/symptoms/events/route");
  const response = await call(GET, "GET", "/api/symptoms/events");
  expect(response.status).toBe(200);
  return (
    await json<
      Envelope<{
        events: Array<{
          id: string;
          source: string;
          externalId: string | null;
        }>;
      }>
    >(response)
  ).data.events;
}

async function seedUsers() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: OWNER_ID,
      email: `${OWNER_ID}@example.test`,
      timezone: "Europe/Berlin",
      locale: "de",
    },
  });
  await prisma.user.create({
    data: {
      id: OTHER_ID,
      username: OTHER_ID,
      email: `${OTHER_ID}@example.test`,
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 86_400_000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedUsers();
  await signIn(OWNER_ID);
});

describe("POST /api/symptoms/events/batch", () => {
  it("creates the built-in definition in the owner's language and lands on it", async () => {
    const result = await ingest([
      sample("A0000000-0000-4000-8000-000000000001", {
        endAt: new Date(Date.now() - HOUR).toISOString(),
      }),
      sample("A0000000-0000-4000-8000-000000000002", { code: "COUGHING" }),
    ]);
    expect(result).toMatchObject({
      processed: 2,
      inserted: 2,
      duplicates: 0,
      failed: 0,
      skipped: [],
    });
    expect(result.entries).toEqual([
      { index: 0, status: "inserted" },
      { index: 1, status: "inserted" },
    ]);

    const definitions = await getPrismaClient().symptomDefinition.findMany({
      where: { userId: OWNER_ID },
      orderBy: { code: "asc" },
    });
    expect(definitions.map((d) => [d.code, d.icon])).toEqual([
      ["COUGHING", "Stethoscope"],
      ["FEVER", "Thermometer"],
    ]);
    expect(definitions.map((d) => decryptFromBytes(d.labelEncrypted))).toEqual([
      "Husten",
      "Fieber",
    ]);

    const fever = await getPrismaClient().symptomEvent.findFirstOrThrow({
      where: { externalId: "A0000000-0000-4000-8000-000000000001" },
    });
    expect(fever).toMatchObject({
      userId: OWNER_ID,
      source: "APPLE_HEALTH",
      intensity: 6,
      deletedAt: null,
    });
    expect(fever.endAt).not.toBeNull();

    const listed = await listEvents();
    expect(listed).toHaveLength(2);
    expect(listed.every((e) => e.source === "APPLE_HEALTH")).toBe(true);
  });

  it("lands on a renamed, hidden built-in by code", async () => {
    await ingest([sample("A0000000-0000-4000-8000-000000000010")]);
    const prisma = getPrismaClient();
    const fever = await prisma.symptomDefinition.findFirstOrThrow({
      where: { userId: OWNER_ID, code: "FEVER" },
    });
    const { PATCH } = await import("@/app/api/symptoms/definitions/[id]/route");
    const renamed = await call(
      PATCH,
      "PATCH",
      `/api/symptoms/definitions/${fever.id}`,
      { label: "Temperatur", isActive: false },
      { id: fever.id },
    );
    expect(renamed.status).toBe(200);

    const result = await ingest([
      sample("A0000000-0000-4000-8000-000000000011"),
    ]);
    expect(result.inserted).toBe(1);
    expect(
      await prisma.symptomDefinition.count({ where: { userId: OWNER_ID } }),
    ).toBe(1);
    const after = await prisma.symptomDefinition.findUniqueOrThrow({
      where: { id: fever.id },
    });
    expect(after.isActive).toBe(false);
    expect(after.code).toBe("FEVER");
    expect(decryptFromBytes(after.labelEncrypted)).toBe("Temperatur");
  });

  it("answers a re-post duplicate, and a sample repeated in one batch too", async () => {
    await ingest([sample("A0000000-0000-4000-8000-000000000020")]);
    const again = await ingest([
      sample("A0000000-0000-4000-8000-000000000020", { intensity: 9 }),
      sample("A0000000-0000-4000-8000-000000000021"),
      sample("A0000000-0000-4000-8000-000000000021"),
    ]);
    expect(again.entries.map((e) => e.status)).toEqual([
      "duplicate",
      "inserted",
      "duplicate",
    ]);
    expect(again).toMatchObject({ inserted: 1, duplicates: 2 });
    const stored = await getPrismaClient().symptomEvent.findFirstOrThrow({
      where: { externalId: "A0000000-0000-4000-8000-000000000020" },
    });
    // First write wins; the re-post never overwrites.
    expect(stored.intensity).toBe(6);
  });

  it("skips what it cannot take, terminally, and lands the rest", async () => {
    const result = await ingest([
      sample("A0000000-0000-4000-8000-000000000030", { code: "SNEEZING" }),
      sample("A0000000-0000-4000-8000-000000000031", { intensity: 11 }),
      sample("A0000000-0000-4000-8000-000000000032", { intensity: 2.5 }),
      sample("A0000000-0000-4000-8000-000000000033", {
        occurredAt: new Date(Date.now() + 2 * HOUR).toISOString(),
      }),
      sample("A0000000-0000-4000-8000-000000000034", {
        occurredAt: "1899-12-31T00:00:00.000Z",
      }),
      sample("A0000000-0000-4000-8000-000000000035", { source: "MANUAL" }),
      sample("<HKCategorySample: 0x600003a1c0f0>"),
      sample("A0000000-0000-4000-8000-000000000036", {
        endAt: new Date(Date.now() - 3 * HOUR).toISOString(),
      }),
      sample("A0000000-0000-4000-8000-000000000037"),
    ]);
    expect(result.entries.map((e) => e.reason ?? e.status)).toEqual([
      "unknown_code",
      "value_out_of_range",
      "value_out_of_range",
      "implausible_timestamp",
      "implausible_timestamp",
      "unsupported_source",
      "unstable_external_id",
      "implausible_timestamp",
      "inserted",
    ]);
    expect(result.skipped).toHaveLength(8);
    expect(result.inserted).toBe(1);
    expect(
      await getPrismaClient().symptomEvent.count({
        where: { userId: OWNER_ID },
      }),
    ).toBe(1);
  });

  it("refuses an over-long batch and a malformed one as a whole", async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) =>
      sample(`B0000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
    );
    const large = await postBatch(tooMany);
    expect(large.status).toBe(422);
    expect((await json<Envelope<null>>(large)).meta?.errorCode).toBe(
      "symptoms.batch.too_large",
    );
    const malformed = await postBatch([{ code: "FEVER" }]);
    expect(malformed.status).toBe(422);
    expect((await json<Envelope<null>>(malformed)).meta?.errorCode).toBe(
      "symptoms.batch.invalid",
    );
    expect(await getPrismaClient().symptomEvent.count()).toBe(0);
  });

  it("answers illness.disabled for the whole call with the module off", async () => {
    await getPrismaClient().user.update({
      where: { id: OWNER_ID },
      data: { modulePreferencesJson: { illness: false } },
    });
    const response = await postBatch([
      sample("A0000000-0000-4000-8000-000000000040"),
    ]);
    expect(response.status).toBe(403);
    expect((await json<Envelope<null>>(response)).meta?.errorCode).toBe(
      "illness.disabled",
    );
    const deleted = await deleteByExternalIds(["x"]);
    expect(deleted.status).toBe(403);
    expect(await getPrismaClient().symptomEvent.count()).toBe(0);
  });

  it("holds no slot of the cap, in either direction", async () => {
    const { POST } = await import("@/app/api/symptoms/definitions/route");
    for (let i = 0; i < 8; i += 1) {
      const created = await call(POST, "POST", "/api/symptoms/definitions", {
        label: `Own ${i}`,
      });
      expect(created.status).toBe(201);
    }
    // At the cap, a sample of a new code still lands.
    const result = await ingest([
      sample("A0000000-0000-4000-8000-000000000050", { code: "HEADACHE" }),
    ]);
    expect(result.inserted).toBe(1);
    // And the built-in does not block hiding-then-showing an own one.
    const own = await getPrismaClient().symptomDefinition.findFirstOrThrow({
      where: { userId: OWNER_ID, code: null },
    });
    const { PATCH } = await import("@/app/api/symptoms/definitions/[id]/route");
    const hide = await call(
      PATCH,
      "PATCH",
      `/api/symptoms/definitions/${own.id}`,
      { isActive: false },
      { id: own.id },
    );
    expect(hide.status).toBe(200);
    const show = await call(
      PATCH,
      "PATCH",
      `/api/symptoms/definitions/${own.id}`,
      { isActive: true },
      { id: own.id },
    );
    expect(show.status).toBe(200);
    // A ninth own one is still refused.
    const ninth = await call(POST, "POST", "/api/symptoms/definitions", {
      label: "Ninth",
    });
    expect(ninth.status).toBe(422);
  });

  it("keeps another account's sample of the same id apart", async () => {
    const shared = "A0000000-0000-4000-8000-000000000060";
    await ingest([sample(shared)]);
    // A fresh browser: the owner's locale cookie would otherwise follow.
    cookieJar.clear();
    await signIn(OTHER_ID);
    const theirs = await ingest([sample(shared)]);
    expect(theirs.entries).toEqual([{ index: 0, status: "inserted" }]);
    // Their delete does not reach the owner's row.
    const response = await deleteByExternalIds([shared]);
    expect(
      (await json<Envelope<{ deletedCount: number }>>(response)).data,
    ).toEqual({ deletedCount: 1 });
    const owners = await getPrismaClient().symptomEvent.findFirstOrThrow({
      where: { userId: OWNER_ID, externalId: shared },
    });
    expect(owners.deletedAt).toBeNull();
    // Their built-in is their own, labelled in their language.
    const label = await getPrismaClient().symptomDefinition.findFirstOrThrow({
      where: { userId: OTHER_ID, code: "FEVER" },
    });
    expect(decryptFromBytes(label.labelEncrypted)).toBe("Fever");
  });
});

describe("DELETE /api/symptoms/events/by-external-ids", () => {
  it("counts what it tombstones, once, and only imports", async () => {
    await ingest([
      sample("A0000000-0000-4000-8000-000000000070"),
      sample("A0000000-0000-4000-8000-000000000071"),
    ]);
    const prisma = getPrismaClient();
    const definition = await prisma.symptomDefinition.findFirstOrThrow({
      where: { userId: OWNER_ID },
    });
    // A manual occurrence that happens to carry the same id is never matched.
    await prisma.symptomEvent.create({
      data: {
        userId: OWNER_ID,
        definitionId: definition.id,
        occurredAt: new Date(Date.now() - HOUR),
        intensity: 3,
        externalId: "A0000000-0000-4000-8000-000000000070",
      },
    });

    const first = await deleteByExternalIds([
      "A0000000-0000-4000-8000-000000000070",
      "A0000000-0000-4000-8000-000000000070",
      "unknown-id",
    ]);
    expect(first.status).toBe(200);
    expect(
      (await json<Envelope<{ deletedCount: number }>>(first)).data,
    ).toEqual({ deletedCount: 1 });
    const again = await deleteByExternalIds([
      "A0000000-0000-4000-8000-000000000070",
    ]);
    expect(
      (await json<Envelope<{ deletedCount: number }>>(again)).data,
    ).toEqual({ deletedCount: 0 });
    const empty = await deleteByExternalIds([]);
    expect(
      (await json<Envelope<{ deletedCount: number }>>(empty)).data,
    ).toEqual({ deletedCount: 0 });

    // The manual one and the other import are untouched.
    expect(
      await prisma.symptomEvent.count({
        where: { userId: OWNER_ID, deletedAt: null },
      }),
    ).toBe(2);
    const tooMany = await deleteByExternalIds(
      Array.from({ length: 501 }, (_, i) => `id-${i}`),
    );
    expect(tooMany.status).toBe(422);
    expect((await json<Envelope<null>>(tooMany)).meta?.errorCode).toBe(
      "symptoms.delete.too_large",
    );
  });

  it("a re-post of a deleted sample stays deleted", async () => {
    const id = "A0000000-0000-4000-8000-000000000080";
    await ingest([sample(id)]);
    await deleteByExternalIds([id]);
    const replay = await ingest([sample(id)]);
    expect(replay.entries).toEqual([{ index: 0, status: "duplicate" }]);
    expect(
      await getPrismaClient().symptomEvent.count({
        where: { externalId: id },
      }),
    ).toBe(1);
    expect(await listEvents()).toEqual([]);
  });

  it("the person's own delete of an import tombstones it too", async () => {
    const id = "A0000000-0000-4000-8000-000000000090";
    await ingest([sample(id)]);
    const row = await getPrismaClient().symptomEvent.findFirstOrThrow({
      where: { externalId: id },
    });
    const { DELETE } = await import("@/app/api/symptoms/events/[id]/route");
    const removed = await call(
      DELETE,
      "DELETE",
      `/api/symptoms/events/${row.id}`,
      undefined,
      { id: row.id },
    );
    expect(removed.status).toBe(200);
    const replay = await ingest([sample(id)]);
    expect(replay.entries[0].status).toBe("duplicate");
    // A second delete finds nothing to delete.
    const twice = await call(
      DELETE,
      "DELETE",
      `/api/symptoms/events/${row.id}`,
      undefined,
      { id: row.id },
    );
    expect(twice.status).toBe(404);
  });

  it("leaves every reader once deleted", async () => {
    const id = "A0000000-0000-4000-8000-000000000100";
    await ingest([sample(id, { intensity: 8 })]);
    const definition =
      await getPrismaClient().symptomDefinition.findFirstOrThrow({
        where: { userId: OWNER_ID, code: "FEVER" },
      });
    await deleteByExternalIds([id]);

    expect(await listEvents()).toEqual([]);

    const { GET } = await import("@/app/api/symptoms/definitions/route");
    const definitions = await json<
      Envelope<{
        definitions: Array<{
          id: string;
          code: string | null;
          recent: unknown;
        }>;
      }>
    >(await call(GET, "GET", "/api/symptoms/definitions"));
    expect(definitions.data.definitions).toEqual([
      expect.objectContaining({
        id: definition.id,
        code: "FEVER",
        recent: { count30d: 0, maxIntensity30d: null, lastOccurredAt: null },
      }),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const series = await loadSymptomSeries({
      recordId: OWNER_ID,
      ids: [definition.id],
      from: "2026-01-01",
      to: today > "2026-01-01" ? today : "2030-01-01",
      tz: "Europe/Berlin",
      bucket: "day",
      access: {
        modules: { illness: true } as never,
        domainVisible: () => true,
        owner: true,
      },
    });
    expect(series[0]?.points ?? []).toEqual([]);
  });
});

describe("a session switched into another record", () => {
  /**
   * Apple Health sync belongs to the owner's own phone, like every other
   * HealthKit ingest and delete route: a delegate or guardian holding a
   * MANAGE grant is refused both routes, and nothing is written or
   * tombstoned in the record they are switched into.
   */
  it("can neither import into nor delete from that record", async () => {
    const id = "A0000000-0000-4000-8000-0000000000d1";
    await ingest([sample(id)]);

    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: OWNER_ID,
      granteeId: OTHER_ID,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: OTHER_ID });
    cookieJar.clear();
    const session = await getPrismaClient().session.create({
      data: {
        userId: OTHER_ID,
        expiresAt: new Date(Date.now() + 86_400_000),
        mfaVerifiedAt: new Date(),
      },
    });
    cookieJar.set("healthlog_session", session.id);
    await switchSessionTo(session.id, OWNER_ID);

    const write = await postBatch([
      sample("A0000000-0000-4000-8000-0000000000d2"),
    ]);
    expect(write.status).toBe(403);
    const remove = await deleteByExternalIds([id]);
    expect(remove.status).toBe(403);

    const prisma = getPrismaClient();
    expect(await prisma.symptomEvent.count()).toBe(1);
    expect(
      (
        await prisma.symptomEvent.findFirstOrThrow({
          where: { externalId: id },
        })
      ).deletedAt,
    ).toBeNull();
  });
});

describe("the manual routes", () => {
  it("cannot set source or externalId on a create", async () => {
    await ingest([sample("A0000000-0000-4000-8000-000000000110")]);
    const definition =
      await getPrismaClient().symptomDefinition.findFirstOrThrow({
        where: { userId: OWNER_ID },
      });
    const { POST } = await import("@/app/api/symptoms/events/route");
    const created = await call(POST, "POST", "/api/symptoms/events", {
      definitionId: definition.id,
      intensity: 4,
      source: "APPLE_HEALTH",
      externalId: "A0000000-0000-4000-8000-000000000111",
    });
    expect(created.status).toBe(201);
    const body = (
      await json<Envelope<{ source: string; externalId: string | null }>>(
        created,
      )
    ).data;
    expect(body).toMatchObject({ source: "MANUAL", externalId: null });
  });
});

describe("the backup", () => {
  it("carries the code, the provenance and the tombstone through a disaster-recovery round trip", async () => {
    await ingest([
      sample("A0000000-0000-4000-8000-000000000120", {
        endAt: new Date(Date.now() - HOUR).toISOString(),
      }),
      sample("A0000000-0000-4000-8000-000000000121"),
    ]);
    await deleteByExternalIds(["A0000000-0000-4000-8000-000000000121"]);
    const prisma = getPrismaClient();
    const before = await prisma.symptomEvent.findMany({
      where: { userId: OWNER_ID },
      orderBy: { externalId: "asc" },
    });

    const section = await buildSymptomsBackupSection(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const portable = await buildSymptomsBackupSection(prisma, OWNER_ID, {
      purpose: "portable-export",
    });
    // The portable file leaves the tombstone out, as it does every other one.
    expect(portable.symptomDefinitions[0].events).toHaveLength(1);
    expect(portable.symptomDefinitions[0].code).toBe("FEVER");

    const skips: RestoreSkipLog = [];
    await prisma.$transaction((tx) =>
      restoreSymptomsData(tx, OWNER_ID, section, new Set(), skips),
    );
    const after = await prisma.symptomEvent.findMany({
      where: { userId: OWNER_ID },
      orderBy: { externalId: "asc" },
    });
    const pick = (rows: typeof before) =>
      rows.map((r) => ({
        source: r.source,
        externalId: r.externalId,
        endAt: r.endAt?.toISOString() ?? null,
        deletedAt: r.deletedAt?.toISOString() ?? null,
      }));
    expect(pick(after)).toEqual(pick(before));
    expect(
      (
        await prisma.symptomDefinition.findFirstOrThrow({
          where: { userId: OWNER_ID },
        })
      ).code,
    ).toBe("FEVER");
    // The restored tombstone still keeps the replay out.
    const replay = await ingest([
      sample("A0000000-0000-4000-8000-000000000121"),
    ]);
    expect(replay.entries[0].status).toBe("duplicate");
  });
});
