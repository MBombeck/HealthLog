/**
 * v1.39.4 — a practitioner's phone number and address are encrypted at rest,
 * against real Postgres.
 *
 *   - a create and an edit store ciphertext only: the readable columns stay
 *     NULL and the stored bytes do not contain the number;
 *   - the wire shape is unchanged, and a row the backfill has not reached yet
 *     still reads back from its legacy columns;
 *   - an edit's audit row names the changed contact field without its value;
 *   - a disaster-recovery backup carries the fields as ciphertext only, a
 *     portable export carries them readable, and a restore from either (or
 *     from a file written before this release) writes ciphertext only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { GET as listPractitioners, POST } from "@/app/api/practitioners/route";
import { PATCH } from "@/app/api/practitioners/[id]/route";
import {
  buildVisitsBackupSection,
  restoreVisitsData,
} from "@/lib/export/visits-backup";
import { readNote } from "@/lib/crypto/note-cipher";

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

const OWNER_ID = "practitioner-contact-owner";
const PHONE = "+49 30 9876543";
const ADDRESS = "Lindenweg 12, 10115 Berlin";

async function seedSession() {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: OWNER_ID,
      username: OWNER_ID,
      email: `${OWNER_ID}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: OWNER_ID,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  cookieJar.set("healthlog_session", session.id);
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

/** The stored row as SQL sees it: readable columns and a leak probe. */
async function onDisk(id: string, needle: string) {
  const rows = await getPrismaClient().$queryRaw<
    {
      phone: string | null;
      location: string | null;
      phone_leaks: boolean;
      location_leaks: boolean;
    }[]
  >`
    SELECT phone, location,
           COALESCE(position(convert_to(${needle}, 'UTF8') IN phone_encrypted) > 0, false)
             AS phone_leaks,
           COALESCE(position(convert_to(${needle}, 'UTF8') IN location_encrypted) > 0, false)
             AS location_leaks
    FROM practitioners WHERE id = ${id}`;
  return rows[0];
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await seedSession();
});

describe("practitioner phone and address at rest", () => {
  it("stores a created practitioner's contact fields as ciphertext only and serves them unchanged", async () => {
    const res = await POST(
      jsonRequest("http://localhost/api/practitioners", "POST", {
        name: "Dr. Weber",
        specialty: "Kardiologie",
        phone: PHONE,
        location: ADDRESS,
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()).data as {
      id: string;
      phone: string | null;
      location: string | null;
    };
    expect(created).toMatchObject({ phone: PHONE, location: ADDRESS });

    expect(await onDisk(created.id, "9876543")).toEqual({
      phone: null,
      location: null,
      phone_leaks: false,
      location_leaks: false,
    });
    expect(await onDisk(created.id, "Lindenweg")).toMatchObject({
      location_leaks: false,
    });

    const list = await listPractitioners(
      new Request("http://localhost/api/practitioners") as never,
    );
    const rows = (await list.json()).data as {
      name: string;
      phone: string | null;
      location: string | null;
    }[];
    expect(rows).toEqual([
      expect.objectContaining({
        name: "Dr. Weber",
        phone: PHONE,
        location: ADDRESS,
      }),
    ]);
  });

  it("reads a row the backfill has not reached from its legacy columns", async () => {
    await getPrismaClient().practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Dr. Alt",
        phone: PHONE,
        location: ADDRESS,
      },
    });
    const list = await listPractitioners(
      new Request("http://localhost/api/practitioners") as never,
    );
    const rows = (await list.json()).data as {
      phone: string | null;
      location: string | null;
    }[];
    expect(rows[0]).toMatchObject({ phone: PHONE, location: ADDRESS });
  });

  it("seals an edited field, clears its legacy column, and audits the change without the value", async () => {
    const prisma = getPrismaClient();
    const legacy = await prisma.practitioner.create({
      data: {
        userId: OWNER_ID,
        name: "Dr. Alt",
        phone: "+49 30 1111111",
        location: ADDRESS,
      },
    });

    const res = await PATCH(
      jsonRequest(`http://localhost/api/practitioners/${legacy.id}`, "PATCH", {
        phone: PHONE,
      }),
      { params: Promise.resolve({ id: legacy.id }) },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      phone: PHONE,
      // Untouched by the edit: still served from the legacy column.
      location: ADDRESS,
    });

    const row = await prisma.practitioner.findUniqueOrThrow({
      where: { id: legacy.id },
    });
    expect(row.phone).toBeNull();
    expect(readNote(row.phoneEncrypted, null)).toBe(PHONE);
    expect(row.location).toBe(ADDRESS);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: OWNER_ID, action: "practitioner.contact.update" },
    });
    const details = JSON.parse(audit.details ?? "{}") as {
      fields?: string[];
      previous?: Record<string, unknown>;
    };
    expect(details.fields).toEqual(["phone"]);
    expect(details.previous ?? {}).not.toHaveProperty("phone");
    expect(audit.details).not.toContain("1111111");
    expect(audit.details).not.toContain("9876543");
  });

  it("carries the contact fields as ciphertext in a disaster-recovery backup, readable in a portable one, and restores ciphertext only", async () => {
    const prisma = getPrismaClient();
    // One legacy row, one sealed through the route.
    await prisma.practitioner.create({
      data: {
        id: "pr-legacy",
        userId: OWNER_ID,
        name: "Dr. Alt",
        phone: PHONE,
        location: ADDRESS,
      },
    });
    const created = await POST(
      jsonRequest("http://localhost/api/practitioners", "POST", {
        name: "Dr. Neu",
        phone: PHONE,
      }),
    );
    const sealedId = ((await created.json()).data as { id: string }).id;

    const dr = await buildVisitsBackupSection(prisma, OWNER_ID, {
      purpose: "disaster-recovery",
    });
    const drFile = JSON.stringify(dr);
    expect(drFile).not.toContain("9876543");
    expect(drFile).not.toContain("Lindenweg");
    for (const entry of dr.practitioners) {
      expect(entry.phone).toBeNull();
      expect(entry.location).toBeNull();
      expect(typeof entry.phoneEncrypted).toBe("string");
    }

    const portable = await buildVisitsBackupSection(prisma, OWNER_ID, {
      purpose: "portable-export",
    });
    expect(
      portable.practitioners.map((p) => ({
        id: p.id,
        phone: p.phone,
        location: p.location,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: "pr-legacy", phone: PHONE, location: ADDRESS },
        { id: sealedId, phone: PHONE, location: null },
      ]),
    );

    // A file written before this release: readable fields, no ciphertext.
    const older = portable.practitioners.map((p) => ({
      id: p.id,
      name: p.name,
      phone: p.phone,
      location: p.location,
      noteEncrypted: p.noteEncrypted,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    for (const payload of [
      dr.practitioners,
      portable.practitioners,
      older,
    ] as const) {
      await prisma.$transaction(async (tx) => {
        await restoreVisitsData(
          tx,
          OWNER_ID,
          {
            practitioners: payload,
            encounters: [],
            encounterDocumentLinks: [],
            encounterLabLinks: [],
            encounterConditionLinks: [],
          },
          [],
        );
      });
      const restored = await prisma.practitioner.findMany({
        where: { userId: OWNER_ID },
        orderBy: { name: "asc" },
      });
      expect(
        restored.map((p) => ({
          id: p.id,
          phone: p.phone,
          location: p.location,
          phoneText: readNote(p.phoneEncrypted, null),
          locationText: readNote(p.locationEncrypted, null),
        })),
      ).toEqual([
        {
          id: "pr-legacy",
          phone: null,
          location: null,
          phoneText: PHONE,
          locationText: ADDRESS,
        },
        {
          id: sealedId,
          phone: null,
          location: null,
          phoneText: PHONE,
          locationText: null,
        },
      ]);
    }
  });

  it("carries a deleted practitioner a live visit names in a portable file, and no other tombstone", async () => {
    const prisma = getPrismaClient();
    const gone = new Date("2026-09-01T00:00:00.000Z");
    for (const id of ["pr-live", "pr-named", "pr-orphan"]) {
      await prisma.practitioner.create({
        data: {
          id,
          userId: OWNER_ID,
          name: id,
          deletedAt: id === "pr-live" ? null : gone,
        },
      });
    }
    await prisma.encounter.create({
      data: {
        id: "visit-named",
        userId: OWNER_ID,
        occurredAt: new Date("2026-08-01T08:00:00.000Z"),
        practitionerId: "pr-named",
      },
    });

    const portable = await buildVisitsBackupSection(prisma, OWNER_ID, {
      purpose: "portable-export",
    });

    expect(
      portable.practitioners
        .map((p) => ({ id: p.id, deleted: Boolean(p.deletedAt) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: "pr-live", deleted: false },
      { id: "pr-named", deleted: true },
    ]);
    expect(portable.encounters[0].practitionerId).toBe("pr-named");

    // The restore brings the named entry back as a tombstone: on the visit,
    // not in the address book.
    await prisma.$transaction(async (tx) => {
      await restoreVisitsData(
        tx,
        OWNER_ID,
        {
          practitioners: portable.practitioners,
          encounters: portable.encounters,
          encounterDocumentLinks: [],
          encounterLabLinks: [],
          encounterConditionLinks: [],
        },
        [],
      );
    });
    const visit = await prisma.encounter.findFirstOrThrow({
      where: { userId: OWNER_ID },
      select: { practitioner: { select: { id: true, deletedAt: true } } },
    });
    expect(visit.practitioner?.id).toBe("pr-named");
    expect(visit.practitioner?.deletedAt).not.toBeNull();
  });
});
