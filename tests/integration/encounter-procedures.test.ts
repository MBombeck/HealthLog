/**
 * The procedure history against real Postgres, through the real routes.
 *
 * What only a real database can answer:
 *
 *   - the new enum value and the two new columns exist and round-trip, which a
 *     mocked client would accept whether or not migration 0349 ran;
 *   - the body site is ciphertext on disk, not the words the person typed;
 *   - switching a visit that already exists to PROCEDURE keeps everything it
 *     carried, so nothing has to be entered again;
 *   - the history reads only DONE procedures of the caller, and the body-site
 *     search runs over the decrypted text;
 *   - the backup carries the site and the side, and a restore brings them
 *     back readable.
 *
 * Mutation checks (each run, each seen red):
 *   - drop `bodySiteEncrypted` from `ENCOUNTER_BACKUP_SELECT` → the round trip
 *     goes red with a null site;
 *   - drop `laterality` from the restore's `createMany` → the round trip goes
 *     red with a null side;
 *   - write `entry.bodySite` without `encryptToBytes` (as bytes of the plain
 *     string) → "stores the site as ciphertext" goes red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  GET as listEncounters,
  POST as createEncounter,
} from "@/app/api/encounters/route";
import { PATCH as patchEncounter } from "@/app/api/encounters/[id]/route";
import { GET as listProcedures } from "@/app/api/encounters/procedures/route";
import { encryptToBytes, decryptFromBytes } from "@/lib/ai/coach/bytes-codec";
import {
  buildVisitsBackupSection,
  restoreVisitsData,
} from "@/lib/export/visits-backup";
import { backupPayloadSchema } from "@/lib/validations/backup";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = "procedures-owner";
const STRANGER_ID = "procedures-stranger";

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function seedSession() {
  const prisma = getPrismaClient();
  for (const id of [OWNER_ID, STRANGER_ID]) {
    await prisma.user.create({
      data: {
        id,
        username: id,
        email: `${id}@example.test`,
        timezone: "Europe/Berlin",
        locale: "en",
      },
    });
  }
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: daysFromNow(7),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function post(body: unknown): Promise<Response> {
  return createEncounter(
    new Request("http://localhost/api/encounters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

function patch(id: string, body: unknown): Promise<Response> {
  return patchEncounter(
    new Request(`http://localhost/api/encounters/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

function procedures(query = ""): Promise<Response> {
  return listProcedures(
    new Request(
      `http://localhost/api/encounters/procedures${query ? `?${query}` : ""}`,
    ) as never,
  );
}

async function json<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface Row {
  id: string;
  kind: string;
  reason: string | null;
  bodySite: string | null;
  laterality: string | null;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("filing a procedure", () => {
  it("stores the site as ciphertext and reads it back decrypted", async () => {
    const res = await post({
      occurredAt: daysFromNow(-400).toISOString(),
      kind: "PROCEDURE",
      reason: "Meniscus repair",
      bodySite: "  Knee ",
      laterality: "LEFT",
    });
    expect(res.status).toBe(201);
    const created = await json<Row>(res);
    expect(created.kind).toBe("PROCEDURE");
    expect(created.bodySite).toBe("Knee");
    expect(created.laterality).toBe("LEFT");

    const stored = await getPrismaClient().encounter.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.bodySiteEncrypted).not.toBeNull();
    expect(
      Buffer.from(stored.bodySiteEncrypted!).toString("utf8"),
    ).not.toContain("Knee");
    expect(decryptFromBytes(stored.bodySiteEncrypted!)).toBe("Knee");
    expect(stored.laterality).toBe("LEFT");
  });

  it("refuses a side that is not one", async () => {
    const res = await post({
      occurredAt: daysFromNow(-10).toISOString(),
      kind: "PROCEDURE",
      laterality: "UP",
    });
    expect(res.status).toBe(422);
  });
});

describe("switching a visit already on file", () => {
  it("keeps the date, the reason and the outcome, and lists it as a procedure", async () => {
    const prisma = getPrismaClient();
    const existing = await prisma.encounter.create({
      data: {
        userId: OWNER_ID,
        occurredAt: daysFromNow(-2000),
        status: "DONE",
        kind: "HOSPITAL",
        reasonEncrypted: encryptToBytes("Appendectomy"),
        outcomeEncrypted: encryptToBytes("Home after three days"),
      },
    });

    const before = await json<{ procedures: Row[] }>(await procedures());
    expect(before.procedures).toHaveLength(0);

    const res = await patch(existing.id, {
      kind: "PROCEDURE",
      bodySite: "Abdomen",
    });
    expect(res.status).toBe(200);
    const updated = await json<Row & { outcome: string | null }>(res);
    expect(updated.kind).toBe("PROCEDURE");
    expect(updated.reason).toBe("Appendectomy");
    expect(updated.outcome).toBe("Home after three days");
    expect(updated.bodySite).toBe("Abdomen");
    expect(updated.laterality).toBeNull();

    const after = await json<{ procedures: Row[] }>(await procedures());
    expect(after.procedures.map((p) => p.id)).toEqual([existing.id]);
  });

  it("clears the site with an explicit null", async () => {
    const created = await json<Row>(
      await post({
        occurredAt: daysFromNow(-30).toISOString(),
        kind: "PROCEDURE",
        bodySite: "Wrist",
        laterality: "RIGHT",
      }),
    );
    const cleared = await json<Row>(
      await patch(created.id, { bodySite: null, laterality: null }),
    );
    expect(cleared.bodySite).toBeNull();
    expect(cleared.laterality).toBeNull();
  });
});

describe("the procedure history", () => {
  async function seedHistory() {
    const prisma = getPrismaClient();
    const make = (
      userId: string,
      days: number,
      over: {
        kind?: "PROCEDURE" | "HOSPITAL";
        status?: "DONE" | "PLANNED" | "CANCELLED";
        site?: string;
        side?: "LEFT" | "RIGHT";
        reason?: string;
      },
    ) =>
      prisma.encounter.create({
        data: {
          userId,
          occurredAt: daysFromNow(days),
          status: over.status ?? "DONE",
          kind: over.kind ?? "PROCEDURE",
          reasonEncrypted: over.reason ? encryptToBytes(over.reason) : null,
          bodySiteEncrypted: over.site ? encryptToBytes(over.site) : null,
          laterality: over.side ?? null,
        },
      });
    return {
      leftKnee: await make(OWNER_ID, -3000, {
        site: "Knee",
        side: "LEFT",
        reason: "Arthroscopy",
      }),
      rightKnee: await make(OWNER_ID, -1000, { site: "knee", side: "RIGHT" }),
      gallbladder: await make(OWNER_ID, -500, {
        site: "Gallbladder",
        reason: "Cholecystectomy",
      }),
      hospital: await make(OWNER_ID, -200, {
        kind: "HOSPITAL",
        site: "Knee",
        side: "LEFT",
      }),
      cancelled: await make(OWNER_ID, -100, { status: "CANCELLED" }),
      planned: await make(OWNER_ID, 30, { status: "PLANNED", site: "Knee" }),
      strangers: await make(STRANGER_ID, -50, { site: "Knee", side: "LEFT" }),
    };
  }

  it("lists the caller's procedures that happened, newest first", async () => {
    const seeded = await seedHistory();
    const body = await json<{
      procedures: Row[];
      total: number;
      bodySites: Array<{
        bodySite: string;
        laterality: string | null;
        count: number;
      }>;
    }>(await procedures());
    expect(body.procedures.map((p) => p.id)).toEqual([
      seeded.gallbladder.id,
      seeded.rightKnee.id,
      seeded.leftKnee.id,
    ]);
    expect(body.total).toBe(3);
    expect(body.bodySites).toEqual([
      { bodySite: "Gallbladder", laterality: null, count: 1 },
      { bodySite: "knee", laterality: "RIGHT", count: 1 },
      { bodySite: "Knee", laterality: "LEFT", count: 1 },
    ]);
  });

  it("answers 'what was done on the left knee'", async () => {
    const seeded = await seedHistory();
    const body = await json<{ procedures: Row[]; total: number }>(
      await procedures("q=left%20knee"),
    );
    expect(body.procedures.map((p) => p.id)).toEqual([seeded.leftKnee.id]);
    expect(body.total).toBe(3);
  });

  it("finds a procedure by its reason as well as its site", async () => {
    const seeded = await seedHistory();
    const body = await json<{ procedures: Row[] }>(
      await procedures("q=cholecyst"),
    );
    expect(body.procedures.map((p) => p.id)).toEqual([seeded.gallbladder.id]);
  });

  it("keeps a booked procedure in the visit list's upcoming half", async () => {
    const seeded = await seedHistory();
    const list = await json<{ upcoming: Row[] }>(
      await listEncounters(
        new Request("http://localhost/api/encounters") as never,
      ),
    );
    expect(list.upcoming.map((row) => row.id)).toEqual([seeded.planned.id]);
  });
});

describe("the backup", () => {
  it("carries the site and the side, and a restore reads them back", async () => {
    const prisma = getPrismaClient();
    const created = await json<Row>(
      await post({
        occurredAt: daysFromNow(-400).toISOString(),
        kind: "PROCEDURE",
        reason: "Hip replacement",
        bodySite: "Hüfte",
        laterality: "BOTH",
      }),
    );

    const section = await buildVisitsBackupSection(prisma, OWNER_ID);
    const entry = section.encounters.find((row) => row.id === created.id);
    expect(entry?.kind).toBe("PROCEDURE");
    expect(entry?.laterality).toBe("BOTH");
    expect(entry?.bodySiteEncrypted).toEqual(expect.any(String));

    // Through the file schema, as a restore reads it: a field the schema does
    // not know would be dropped here and come back as null.
    const parsed = backupPayloadSchema.parse({
      exportedAt: new Date().toISOString(),
      userId: OWNER_ID,
      ...JSON.parse(JSON.stringify(section)),
    });

    await prisma.$transaction((tx) =>
      restoreVisitsData(tx, OWNER_ID, parsed, []),
    );

    const restored = await prisma.encounter.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(restored.kind).toBe("PROCEDURE");
    expect(restored.laterality).toBe("BOTH");
    expect(decryptFromBytes(restored.bodySiteEncrypted!)).toBe("Hüfte");

    const history = await json<{ procedures: Row[] }>(
      await procedures("q=hufte"),
    );
    expect(history.procedures.map((p) => p.bodySite)).toEqual(["Hüfte"]);
  });
});
