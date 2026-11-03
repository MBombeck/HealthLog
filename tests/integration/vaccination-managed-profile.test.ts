/**
 * The two record-scope properties the immunization log must PROVE rather than
 * assume, through the real routes and a real Postgres.
 *
 * Decision 4's whole rationale is a parent keeping a child's Impfpass, so the
 * managed-profile write cannot be left to inference from the route's
 * `requireRecordAuth("write", "profile")` call:
 *
 *   1. A Guardian standing inside a managed profile writes a dose against the
 *      RESOLVED record — the profile's rows, not the Guardian's own — and reads
 *      it straight back. A positive round trip through the same handlers the UI
 *      calls.
 *   2. A delegate holding `profile` READ on an ordinary record sees the list
 *      and cannot escalate to a write: the PATCH is `manage`, and a READ grant
 *      is refused at the door with a 403, before the record is even looked up.
 *
 * Both are exercised through the record-session machinery
 * (`switchSessionTo`) the sibling sharing suites use, because the property is
 * about the resolver's answer, not about a fixture's shape.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { POST as createVaccination } from "@/app/api/vaccinations/route";
import { GET as listVaccinations } from "@/app/api/vaccinations/route";
import {
  GET as readVaccination,
  PATCH as patchVaccination,
} from "@/app/api/vaccinations/[id]/route";

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

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}
function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * DAY_MS);
}

let sequence = 0;

interface Person {
  id: string;
  sessionId: string;
}

/** An account with a session, ready to be signed in or switched. */
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

async function postDose(body: unknown): Promise<Response> {
  return createVaccination(
    new Request("http://localhost/api/vaccinations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
}

async function getList(): Promise<Response> {
  return listVaccinations(
    new Request("http://localhost/api/vaccinations") as never,
  );
}

async function getOne(id: string): Promise<Response> {
  return readVaccination(
    new Request(`http://localhost/api/vaccinations/${id}`) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

async function patchOne(id: string, body: unknown): Promise<Response> {
  return patchVaccination(
    new Request(`http://localhost/api/vaccinations/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("a Guardian captures against the managed profile's own record", () => {
  it("writes the dose to the profile, not to the Guardian, and reads it back", async () => {
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

    // Sign in as the Guardian and step into the child's record — the exact
    // state the `/vaccinations` surface runs in for a managed profile.
    signIn(guardian);
    await switchSessionTo(guardian.sessionId, profile.id);

    const created = await postDose({
      occurredAt: daysAgo(30).toISOString(),
      antigenSlug: "tetanus",
      lotNumber: "CHILD-LOT-1",
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(
      201,
    );
    const doseId = ((await created.json()) as { data: { id: string } }).data.id;

    const prisma = getPrismaClient();
    // The row belongs to the resolved record.
    const stored = await prisma.vaccinationRecord.findUniqueOrThrow({
      where: { id: doseId },
    });
    expect(stored.userId).toBe(profile.id);
    // And not to the Guardian's own account — the resolution is real, not a
    // fallback to the caller.
    expect(
      await prisma.vaccinationRecord.count({ where: { userId: guardian.id } }),
    ).toBe(0);

    // The list the surface renders answers with the profile's dose.
    const list = await getList();
    expect(list.status).toBe(200);
    const rows = (
      (await list.json()) as { data: { vaccinations: { id: string }[] } }
    ).data.vaccinations;
    expect(rows.map((r) => r.id)).toContain(doseId);
  });
});

describe("a profile-scoped READ delegate reads the list but cannot write", () => {
  async function ownerWithDose() {
    const owner = await person("owner");
    const dose = await getPrismaClient().vaccinationRecord.create({
      data: {
        userId: owner.id,
        occurredAt: daysAgo(60),
        antigenSlug: "tetanus",
        lotNumber: "OWNER-LOT-1",
      },
    });
    return { owner, dose };
  }

  /** Sign a delegate in and switch them into `ownerId` with a READ profile grant. */
  async function switchInAsReadDelegate(ownerId: string): Promise<Person> {
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const delegate = await person("delegate");
    const invited = await inviteGrant({
      grantorId: ownerId,
      granteeId: delegate.id,
      access: "READ",
      scope: ["profile"],
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    signIn(delegate);
    await switchSessionTo(delegate.sessionId, ownerId);
    return delegate;
  }

  it("lists and reads the owner's doses", async () => {
    const { owner, dose } = await ownerWithDose();
    await switchInAsReadDelegate(owner.id);

    const list = await getList();
    expect(list.status).toBe(200);
    const rows = (
      (await list.json()) as { data: { vaccinations: { id: string }[] } }
    ).data.vaccinations;
    expect(rows.map((r) => r.id)).toContain(dose.id);

    // The single-record read is admitted for a reader too.
    expect((await getOne(dose.id)).status).toBe(200);
  });

  it("is refused the PATCH with a 403, and the row is untouched", async () => {
    const { owner, dose } = await ownerWithDose();
    await switchInAsReadDelegate(owner.id);

    const res = await patchOne(dose.id, { lotNumber: "TAMPERED" });
    // The escalation is refused at `requireRecordAuth("manage")`, before the
    // record is even looked up — so it is a 403, not the 404 a missing row gets.
    expect(res.status).toBe(403);
    expect((await res.json()).meta?.errorCode).toBe("sharing.access.denied");

    // The write never landed.
    const after = await getPrismaClient().vaccinationRecord.findUniqueOrThrow({
      where: { id: dose.id },
    });
    expect(after.lotNumber).toBe("OWNER-LOT-1");
  });
});
