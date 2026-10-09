/**
 * v1.42 (#1005) — the record's own vaccine definitions, through the real
 * routes and a real Postgres.
 *
 * Pinned here: a definition is created, listed, renamed and removed under the
 * resolved record; a dose logged against it counts into every listed
 * antigen's series and clears a booster keyed to one of them, the way a
 * catalogue combination does; an id another record holds is refused; removing
 * the definition leaves every dose standing with a name; the booster mint keys
 * on its first antigen; and the sharing levels hold — a READ delegate lists
 * but cannot add, a WRITE delegate adds onto the owner's record but cannot
 * edit, and a Guardian inside a managed profile writes to the profile.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  GET as listCustom,
  POST as createCustom,
} from "@/app/api/vaccinations/custom/route";
import {
  DELETE as deleteCustom,
  PATCH as patchCustom,
} from "@/app/api/vaccinations/custom/[id]/route";
import {
  GET as listVaccinations,
  POST as createVaccination,
} from "@/app/api/vaccinations/route";
import { POST as planBooster } from "@/app/api/vaccinations/[id]/booster/route";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);

let sequence = 0;

interface Person {
  id: string;
  sessionId: string;
}

async function person(label: string): Promise<Person> {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      timezone: "Europe/Berlin",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: daysFromNow(1) },
  });
  return { id: user.id, sessionId: session.id };
}

function signIn(who: Person): void {
  headerJar.delete("authorization");
  cookieJar.set("healthlog_session", who.sessionId);
}

function json(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function addCustom(body: unknown): Promise<Response> {
  return createCustom(json("POST", "/api/vaccinations/custom", body) as never);
}
async function getCustoms(): Promise<Response> {
  // The GET takes no request; the wrapper still hands one through.
  return (listCustom as (request: Request) => Promise<Response>)(
    json("GET", "/api/vaccinations/custom"),
  );
}
async function editCustom(id: string, body: unknown): Promise<Response> {
  return patchCustom(
    json("PATCH", `/api/vaccinations/custom/${id}`, body) as never,
    params(id),
  );
}
async function removeCustom(id: string): Promise<Response> {
  return deleteCustom(
    json("DELETE", `/api/vaccinations/custom/${id}`) as never,
    params(id),
  );
}
async function postDose(body: unknown): Promise<Response> {
  return createVaccination(json("POST", "/api/vaccinations", body) as never);
}

interface DoseDto {
  id: string;
  customVaccineId: string | null;
  customVaccine: { name: string } | null;
  series: { antigen: string; position: number; total: number | null }[];
  reminderId: string | null;
}

async function doses(): Promise<DoseDto[]> {
  const res = await listVaccinations(json("GET", "/api/vaccinations") as never);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { vaccinations: DoseDto[] } }).data
    .vaccinations;
}

const TRAVEL = {
  name: "Travel combo",
  components: ["typhoid", "hepatitis-a"],
  typicalSeriesDoses: 2,
  boosterIntervalMonths: 36,
};

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("an owner's own vaccine definitions", () => {
  it("creates, lists and refuses a second definition of the same name", async () => {
    const owner = await person("owner");
    signIn(owner);

    const created = await addCustom(TRAVEL);
    expect(created.status).toBe(201);
    const def = ((await created.json()) as { data: { id: string } }).data;

    const listed = await getCustoms();
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { data: { id: string; name: string }[] }).data,
    ).toEqual([expect.objectContaining({ id: def.id, name: "Travel combo" })]);

    // The same product, typed differently, is one product to the reader.
    const clash = await addCustom({ ...TRAVEL, name: "travel COMBO" });
    expect(clash.status).toBe(409);
    expect((await clash.json()).meta?.errorCode).toBe(
      "vaccination.custom.name-taken",
    );

    // An antigen outside the closed list is refused.
    const bad = await addCustom({ name: "Other", components: ["unicorn-pox"] });
    expect(bad.status).toBe(422);
  });

  it("answers 409, not 500, to the loser of two concurrent adds of one name", async () => {
    const owner = await person("owner");
    signIn(owner);
    const prisma = getPrismaClient();
    // Hold every insert long enough that both requests have passed the name
    // lookup before either commits, so the loser meets the unique index.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION slow_custom_vaccine_insert() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER slow_custom_vaccine_insert BEFORE INSERT ON "custom_vaccines"
      FOR EACH ROW EXECUTE FUNCTION slow_custom_vaccine_insert()`);
    try {
      const statuses = (
        await Promise.all([addCustom(TRAVEL), addCustom(TRAVEL)])
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual([201, 409]);
      expect(
        await prisma.customVaccine.count({ where: { userId: owner.id } }),
      ).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS slow_custom_vaccine_insert ON "custom_vaccines"',
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS slow_custom_vaccine_insert()",
      );
    }
  });

  it("counts a dose into every listed antigen and clears a booster keyed to one", async () => {
    const owner = await person("owner");
    signIn(owner);
    const prisma = getPrismaClient();
    const def = (
      (await (await addCustom(TRAVEL)).json()) as { data: { id: string } }
    ).data;
    // A hepatitis A booster already planned and due.
    const reminder = await prisma.measurementReminder.create({
      data: {
        userId: owner.id,
        label: "hepatitis A booster",
        intervalDays: 3650,
        notifyHour: 9,
        vaccinationAntigen: "hepatitis-a",
        nextDueAt: daysAgo(1),
      },
    });

    const res = await postDose({
      occurredAt: daysAgo(3).toISOString(),
      customVaccineId: def.id,
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const dto = ((await res.json()) as { data: DoseDto }).data;
    expect(dto.customVaccine?.name).toBe("Travel combo");
    expect(dto.series).toEqual([
      expect.objectContaining({ antigen: "typhoid", position: 1, total: 2 }),
      expect.objectContaining({
        antigen: "hepatitis-a",
        position: 1,
        total: 2,
      }),
    ]);
    expect(dto.reminderId).toBe(reminder.id);
    expect(
      (
        await prisma.measurementReminder.findUniqueOrThrow({
          where: { id: reminder.id },
        })
      ).lastSatisfiedAt,
    ).not.toBeNull();

    // An edit to the definition is read by every dose that names it.
    expect((await editCustom(def.id, { components: ["typhoid"] })).status).toBe(
      200,
    );
    expect((await doses())[0].series.map((p) => p.antigen)).toEqual([
      "typhoid",
    ]);
  });

  it("keys the booster mint on the definition's first antigen", async () => {
    const owner = await person("owner");
    signIn(owner);
    const def = (
      (await (await addCustom(TRAVEL)).json()) as { data: { id: string } }
    ).data;
    const dose = (
      (await (
        await postDose({
          occurredAt: daysAgo(3).toISOString(),
          customVaccineId: def.id,
        })
      ).json()) as { data: { id: string } }
    ).data;

    const res = await planBooster(
      json("POST", `/api/vaccinations/${dose.id}/booster`, {
        intervalMonths: 36,
        label: "Travel combo booster",
      }) as never,
      params(dose.id),
    );
    expect(res.status).toBe(201);
    const minted = await getPrismaClient().measurementReminder.findFirstOrThrow(
      { where: { userId: owner.id } },
    );
    expect(minted.vaccinationAntigen).toBe("typhoid");
  });

  it("refuses a definition another record holds", async () => {
    const stranger = await person("stranger");
    signIn(stranger);
    const foreign = (
      (await (await addCustom(TRAVEL)).json()) as { data: { id: string } }
    ).data;

    const owner = await person("owner");
    signIn(owner);
    const res = await postDose({
      occurredAt: daysAgo(3).toISOString(),
      customVaccineId: foreign.id,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).meta?.errorCode).toBe(
      "vaccination.custom-vaccine-not-found",
    );
    expect((await editCustom(foreign.id, { name: "Mine" })).status).toBe(404);
    expect((await removeCustom(foreign.id)).status).toBe(404);
    expect(
      await getPrismaClient().vaccinationRecord.count({
        where: { userId: owner.id },
      }),
    ).toBe(0);
  });

  it("removing a definition keeps every dose, each with a name, and the name can be used again", async () => {
    const owner = await person("owner");
    signIn(owner);
    const prisma = getPrismaClient();
    const def = (
      (await (await addCustom(TRAVEL)).json()) as { data: { id: string } }
    ).data;
    await postDose({
      occurredAt: daysAgo(30).toISOString(),
      customVaccineId: def.id,
    });
    await postDose({
      occurredAt: daysAgo(3).toISOString(),
      customVaccineId: def.id,
      vaccineName: "as the pass says",
    });

    expect((await removeCustom(def.id)).status).toBe(200);
    // Removing twice succeeds.
    expect((await removeCustom(def.id)).status).toBe(200);

    const rows = await prisma.vaccinationRecord.findMany({
      where: { userId: owner.id, deletedAt: null },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows.map((row) => [row.customVaccineId, row.vaccineName])).toEqual([
      [null, "Travel combo"],
      [null, "as the pass says"],
    ]);
    expect(
      ((await (await getCustoms()).json()) as { data: unknown[] }).data,
    ).toEqual([]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "vaccination.custom.delete" },
      orderBy: { createdAt: "asc" },
    });
    const details =
      typeof audit.details === "string"
        ? JSON.parse(audit.details)
        : audit.details;
    expect(details).toMatchObject({ dosesUnlinked: 2 });

    // The same name again brings the definition back, without its old doses.
    const again = await addCustom({ ...TRAVEL, boosterIntervalMonths: 12 });
    expect(again.status).toBe(201);
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(
      def.id,
    );
    expect(
      await prisma.vaccinationRecord.count({
        where: { userId: owner.id, customVaccineId: def.id },
      }),
    ).toBe(0);
  });
});

describe("sharing and managed profiles", () => {
  async function switchInAs(
    ownerId: string,
    access: "READ" | "WRITE",
  ): Promise<Person> {
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const delegate = await person("delegate");
    const invited = await inviteGrant({
      grantorId: ownerId,
      granteeId: delegate.id,
      access,
      scope: ["profile"],
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    signIn(delegate);
    await switchSessionTo(delegate.sessionId, ownerId);
    return delegate;
  }

  it("lets a READ delegate list the definitions but not add one", async () => {
    const owner = await person("owner");
    await getPrismaClient().customVaccine.create({
      data: { userId: owner.id, name: "Owner's own", components: ["rabies"] },
    });
    await switchInAs(owner.id, "READ");

    const listed = await getCustoms();
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { data: { name: string }[] }).data.map(
        (row) => row.name,
      ),
    ).toEqual(["Owner's own"]);

    const res = await addCustom(TRAVEL);
    expect(res.status).toBe(403);
    expect((await res.json()).meta?.errorCode).toBe("sharing.access.denied");
  });

  it("lets a WRITE delegate add onto the owner's record but not edit or remove", async () => {
    const owner = await person("owner");
    const delegate = await switchInAs(owner.id, "WRITE");

    const res = await addCustom(TRAVEL);
    expect(res.status).toBe(201);
    const def = ((await res.json()) as { data: { id: string } }).data;
    const prisma = getPrismaClient();
    expect(
      (await prisma.customVaccine.findUniqueOrThrow({ where: { id: def.id } }))
        .userId,
    ).toBe(owner.id);
    expect(
      await prisma.customVaccine.count({ where: { userId: delegate.id } }),
    ).toBe(0);

    expect((await editCustom(def.id, { name: "Renamed" })).status).toBe(403);
    expect((await removeCustom(def.id)).status).toBe(403);
  });

  it("writes a Guardian's definition to the managed profile", async () => {
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const guardian = await person("guardian");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Child record",
      dateOfBirth: null,
      locale: "en",
      timezone: "Europe/Berlin",
    });
    signIn(guardian);
    await switchSessionTo(guardian.sessionId, profile.id);

    expect((await addCustom(TRAVEL)).status).toBe(201);
    const prisma = getPrismaClient();
    expect(
      await prisma.customVaccine.count({ where: { userId: profile.id } }),
    ).toBe(1);
    expect(
      await prisma.customVaccine.count({ where: { userId: guardian.id } }),
    ).toBe(0);
  });
});
