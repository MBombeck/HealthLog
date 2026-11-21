/**
 * `/api/medications/{id}/side-effects` and `/{logId}` — list, log and remove
 * side-effect entries, against the real database and through the real API
 * kit.
 *
 * Pinned here:
 *   - the list carries this medication's entries of this record only, newest
 *     first, with the note decrypted; `from` is inclusive, `to` exclusive,
 *     and `limit` cuts the page and says so in `meta`;
 *   - the POST derives the category from the entry whatever the client
 *     sends, stores the note encrypted with the plaintext column empty,
 *     defaults `occurredAt` to now, and writes an audit row;
 *   - 30 writes a minute per account, the 31st refused with 429 and nothing
 *     stored, while another account's allowance is untouched;
 *   - the DELETE is a hard delete whose audit row keeps the entry, the
 *     severity and the date; an entry of another account or filed under
 *     another medication is 404 and stays;
 *   - malformed queries and bodies answer the multi-issue 422 and store
 *     nothing; another account's medication is 404; anonymous is 401.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { GET, POST } from "@/app/api/medications/[id]/side-effects/route";
import { DELETE } from "@/app/api/medications/[id]/side-effects/[logId]/route";
import { encryptNote, readNote } from "@/lib/crypto/note-cipher";

import { anonymous, callRoute } from "../../kit/call-route";
import { makeMedication, makeSession, makeUser } from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";
import { expectSanitisedIssue } from "../zod-issue-shape";

const prisma = getPrismaClient();
const ROUTE = "/api/medications/{id}/side-effects";
const ITEM_ROUTE = "/api/medications/{id}/side-effects/{logId}";

interface SideEffect {
  id: string;
  userId: string;
  medicationId: string;
  occurredAt: string;
  category: string;
  entry: string;
  severity: number;
  notes: string | null;
}

interface ListBody {
  items: SideEffect[];
  meta: { total: number };
}

interface ValidationBody {
  details: { issues: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

async function logSideEffect(
  userId: string,
  medicationId: string,
  overrides: Partial<
    Omit<
      Prisma.MedicationSideEffectUncheckedCreateInput,
      "userId" | "medicationId"
    >
  > = {},
) {
  return prisma.medicationSideEffect.create({
    data: {
      userId,
      medicationId,
      category: "GI",
      entry: "NAUSEA",
      severity: 2,
      occurredAt: new Date("2026-05-10T08:00:00Z"),
      ...overrides,
    },
  });
}

describe("GET /api/medications/{id}/side-effects", () => {
  it("lists this medication's entries newest first with the note decrypted, and nobody else's", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const med = await makeMedication(owner);
    const sibling = await makeMedication(owner);
    const theirs = await makeMedication(other);
    const older = await logSideEffect(owner.id, med.id, {
      occurredAt: new Date("2026-05-01T08:00:00Z"),
      notesEncrypted: encryptNote("after breakfast"),
    });
    const newer = await logSideEffect(owner.id, med.id, {
      entry: "DIARRHEA",
      severity: 3,
      occurredAt: new Date("2026-05-12T08:00:00Z"),
    });
    await logSideEffect(owner.id, sibling.id);
    await logSideEffect(other.id, theirs.id);

    const res = await callRoute<ListBody>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(res.data.items.map((i) => [i.id, i.entry, i.notes])).toEqual([
      [newer.id, "DIARRHEA", null],
      [older.id, "NAUSEA", "after breakfast"],
    ]);
    expect(res.data.meta.total).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain("notesEncrypted");
  });

  it("treats `from` as inclusive and `to` as exclusive, and cuts the page at `limit`", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const session = await makeSession(owner);
    const atFrom = await logSideEffect(owner.id, med.id, {
      occurredAt: new Date("2026-05-01T00:00:00Z"),
    });
    const inside = await logSideEffect(owner.id, med.id, {
      occurredAt: new Date("2026-05-07T00:00:00Z"),
    });
    await logSideEffect(owner.id, med.id, {
      occurredAt: new Date("2026-05-14T00:00:00Z"),
    });
    await logSideEffect(owner.id, med.id, {
      occurredAt: new Date("2026-04-30T23:59:59Z"),
    });

    const windowed = await callRoute<ListBody>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      query: { from: "2026-05-01T00:00:00Z", to: "2026-05-14T00:00:00Z" },
      auth: session,
    });
    expect(windowed.status).toBe(200);
    expect(windowed.data.items.map((i) => i.id)).toEqual([
      inside.id,
      atFrom.id,
    ]);
    expect(windowed.meta).toMatchObject({ truncated: false, limit: 50 });

    const capped = await callRoute<ListBody>(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      query: { limit: 3 },
      auth: session,
    });
    expect(capped.status).toBe(200);
    expect(capped.data.items).toHaveLength(3);
    expect(capped.data.meta.total).toBe(3);
    expect(capped.meta).toMatchObject({ truncated: true, limit: 3 });
  });

  it("answers a malformed query with every issue", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: med.id },
      query: { from: "not-iso", limit: 99999 },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(422);
    expect(res.error).toBe("Validation failed");
    const issues = (res.body as ValidationBody).details.issues;
    expect(issues.map((i) => i.path).sort()).toEqual(["from", "limit"]);
    for (const issue of issues) expectSanitisedIssue(issue);
    // The declared bound is named, never the value sent.
    expect(issues.find((i) => i.path === "limit")).toMatchObject({
      code: "too_big",
      maximum: 200,
      inclusive: true,
      origin: "number",
    });
    expect(JSON.stringify(issues)).not.toContain("99999");
  });

  it("answers 404 for another account's medication and 401 to an anonymous caller", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const theirs = await makeMedication(other);
    await logSideEffect(other.id, theirs.id);

    const foreign = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: theirs.id },
      auth: await makeSession(owner),
    });
    const anon = await callRoute(GET, {
      method: "GET",
      route: ROUTE,
      params: { id: theirs.id },
      auth: anonymous,
    });

    expect(foreign.status).toBe(404);
    expect(anon.status).toBe(401);
  });
});

describe("POST /api/medications/{id}/side-effects", () => {
  it("stores the entry with the category derived from it and the note encrypted", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const occurredAt = "2026-05-14T08:00:00.000Z";

    const res = await callRoute<SideEffect>(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: med.id },
      body: {
        // A client claim the server must not follow.
        category: "INJECTION_SITE",
        entry: "NAUSEA",
        severity: 2,
        occurredAt,
        notes: "after breakfast",
      },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({
      medicationId: med.id,
      userId: owner.id,
      category: "GI",
      entry: "NAUSEA",
      severity: 2,
      occurredAt,
      notes: "after breakfast",
    });

    const row = await prisma.medicationSideEffect.findUniqueOrThrow({
      where: { id: res.data.id },
    });
    expect(row).toMatchObject({
      userId: owner.id,
      medicationId: med.id,
      category: "GI",
      entry: "NAUSEA",
      severity: 2,
      occurredAt: new Date(occurredAt),
      notes: null,
    });
    expect(row.notesEncrypted).not.toBeNull();
    expect(readNote(row.notesEncrypted, null)).toBe("after breakfast");

    const audit = await prisma.auditLog.findMany({
      where: { userId: owner.id, action: "medication.sideEffect.create" },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details ?? "{}")).toEqual({
      medicationId: med.id,
      sideEffectId: row.id,
      entry: "NAUSEA",
      severity: 2,
    });
  });

  it("dates an entry without `occurredAt` at the time of the write", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const before = Date.now();

    const res = await callRoute<SideEffect>(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: med.id },
      body: { entry: "EARLY_SATIETY", severity: 3 },
      auth: await makeSession(owner),
    });

    const after = Date.now();
    expect(res.status).toBe(201);
    const row = await prisma.medicationSideEffect.findUniqueOrThrow({
      where: { id: res.data.id },
    });
    expect(row.category).toBe("GLP1_SPECIFIC");
    expect(row.notesEncrypted).toBeNull();
    expect(row.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.occurredAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("refuses a severity outside 1..5 with 422 and stores nothing", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: med.id },
      body: { entry: "NAUSEA", severity: 7 },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(422);
    expect(await prisma.medicationSideEffect.count()).toBe(0);
  });

  it.each([
    [
      "two",
      { severity: "junk", notes: "x".repeat(2000) },
      ["entry", "notes", "severity"],
    ],
    [
      "three",
      {
        entry: 999,
        severity: "junk",
        occurredAt: "not-iso",
        notes: "x".repeat(5000),
      },
      ["entry", "notes", "occurredAt", "severity"],
    ],
  ])(
    "answers %s or more simultaneous body errors at once",
    async (_n, body, paths) => {
      const owner = await makeUser();
      const med = await makeMedication(owner);

      const res = await callRoute(POST, {
        method: "POST",
        route: ROUTE,
        params: { id: med.id },
        body,
        auth: await makeSession(owner),
      });

      expect(res.status).toBe(422);
      const issues = (res.body as ValidationBody).details.issues;
      expect(issues.map((i) => i.path).sort()).toEqual(paths);
      expect(await prisma.medicationSideEffect.count()).toBe(0);
    },
  );

  it("allows 30 writes a minute per account and refuses the 31st with 429", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const med = await makeMedication(owner);
    const theirMed = await makeMedication(other);
    const session = await makeSession(owner);
    for (let i = 0; i < 30; i++) {
      const ok = await callRoute(POST, {
        method: "POST",
        route: ROUTE,
        params: { id: med.id },
        body: { entry: "NAUSEA", severity: 1 },
        auth: session,
      });
      expect(ok.status).toBe(201);
    }

    const refused = await callRoute(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: med.id },
      body: { entry: "NAUSEA", severity: 1 },
      auth: session,
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).not.toBeNull();
    expect(
      await prisma.medicationSideEffect.count({ where: { userId: owner.id } }),
    ).toBe(30);

    const neighbour = await callRoute(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: theirMed.id },
      body: { entry: "NAUSEA", severity: 1 },
      auth: await makeSession(other),
    });
    expect(neighbour.status).toBe(201);
  });

  it("answers 404 for another account's medication and stores nothing", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const theirs = await makeMedication(other);

    const res = await callRoute(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: theirs.id },
      body: { entry: "NAUSEA", severity: 2 },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(404);
    expect(await prisma.medicationSideEffect.count()).toBe(0);
  });

  it("answers 401 to an anonymous caller", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);

    const res = await callRoute(POST, {
      method: "POST",
      route: ROUTE,
      params: { id: med.id },
      body: { entry: "NAUSEA", severity: 2 },
      auth: anonymous,
    });

    expect(res.status).toBe(401);
    expect(await prisma.medicationSideEffect.count()).toBe(0);
  });
});

describe("DELETE /api/medications/{id}/side-effects/{logId}", () => {
  it("removes the row and keeps entry, severity and date in the audit trail", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const row = await logSideEffect(owner.id, med.id, {
      severity: 3,
      occurredAt: new Date("2026-05-14T08:00:00Z"),
    });

    const res = await callRoute<{ id: string; deleted: boolean }>(DELETE, {
      method: "DELETE",
      route: ITEM_ROUTE,
      params: { id: med.id, logId: row.id },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: row.id, deleted: true });
    expect(
      await prisma.medicationSideEffect.findUnique({ where: { id: row.id } }),
    ).toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: { userId: owner.id, action: "medication.sideEffect.delete" },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]?.details ?? "{}")).toEqual({
      medicationId: med.id,
      sideEffectId: row.id,
      entry: "NAUSEA",
      severity: 3,
      occurredAt: "2026-05-14T08:00:00.000Z",
    });
  });

  it("answers 404 for another account's entry and for one filed under another medication, and both stay", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const med = await makeMedication(owner);
    const sibling = await makeMedication(owner);
    const theirMed = await makeMedication(other);
    const theirs = await logSideEffect(other.id, theirMed.id);
    const siblings = await logSideEffect(owner.id, sibling.id);
    const session = await makeSession(owner);

    const foreign = await callRoute(DELETE, {
      method: "DELETE",
      route: ITEM_ROUTE,
      params: { id: theirMed.id, logId: theirs.id },
      auth: session,
    });
    const crossed = await callRoute(DELETE, {
      method: "DELETE",
      route: ITEM_ROUTE,
      params: { id: med.id, logId: siblings.id },
      auth: session,
    });

    expect(foreign.status).toBe(404);
    expect(crossed.status).toBe(404);
    expect(
      (
        await prisma.medicationSideEffect.findMany({
          where: { id: { in: [theirs.id, siblings.id] } },
        })
      ).length,
    ).toBe(2);
  });

  it("answers 401 to an anonymous caller and keeps the row", async () => {
    const owner = await makeUser();
    const med = await makeMedication(owner);
    const row = await logSideEffect(owner.id, med.id);

    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: ITEM_ROUTE,
      params: { id: med.id, logId: row.id },
      auth: anonymous,
    });

    expect(res.status).toBe(401);
    expect(
      await prisma.medicationSideEffect.findUnique({ where: { id: row.id } }),
    ).not.toBeNull();
  });
});
