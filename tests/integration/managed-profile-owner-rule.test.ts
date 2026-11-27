/**
 * #1615 — a managed profile's guardian holds the owner's rights, by one rule.
 *
 * Driven over the real route handlers, the real grant table and real
 * Postgres:
 *
 *   1. routes that resolve the caller with `requireAuth()` serve the profile
 *      to its guardian: a setting is written on the profile and not on the
 *      guardian, a medication is deleted, and every audit row is filed under
 *      the profile with the guardian as the actor;
 *   2. the exclusions stay the caller's own: the token list and the session
 *      list refuse inside the profile;
 *   3. an adult's delegate at MANAGE, and a READ grant on a managed profile,
 *      reach none of it.
 */
import type { ShareDomain } from "@/lib/sharing/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `gm-${suffix}`,
      email: `gm-${suffix}@example.test`,
      displayName: `Guardian medication ${suffix}`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
    },
  });
}

async function signIn(userId: string) {
  headerJar.clear();
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function makeProfile(guardianId: string, name: string) {
  const { createManagedProfile } =
    await import("@/lib/managed-profiles/create");
  const { profile } = await createManagedProfile({
    creatorId: guardianId,
    displayName: name,
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  return profile;
}

/** A guardian signed in and switched into a fresh managed profile. */
async function guardianInside() {
  const guardian = await makeUser("guardian");
  const profile = await makeProfile(guardian.id, "Managed record");
  const session = await signIn(guardian.id);
  await switchSessionTo(session.id, profile.id);
  return { guardian, profile, session };
}

/** An adult delegate signed in and switched into an adult owner's record. */
async function adultInside(
  access: "READ" | "WRITE" | "MANAGE",
  scope: ShareDomain[] | null = null,
) {
  const owner = await makeUser("owner");
  const delegate = await makeUser("delegate");
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId: owner.id,
    granteeId: delegate.id,
    access,
    scope,
  });
  await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
  const session = await signIn(delegate.id);
  await switchSessionTo(session.id, owner.id);
  return { owner, delegate, session };
}

async function seedMedication(userId: string, name = "Added by mistake") {
  return getPrismaClient().medication.create({
    data: {
      userId,
      name,
      dose: "5 mg",
      schedules: { create: [{ windowStart: "08:00", windowEnd: "09:00" }] },
    },
  });
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Ctx = { params: Promise<Record<string, string>> };
type Handler = (r: Request, c: Ctx) => Promise<Response>;
const ctx = (params: Record<string, string> = {}): Ctx => ({
  params: Promise.resolve(params),
});

async function routes() {
  const timezone = await import("@/app/api/auth/me/timezone/route");
  const medication = await import("@/app/api/medications/[id]/route");
  const tokens = await import("@/app/api/tokens/route");
  const sessions = await import("@/app/api/auth/me/sessions/route");
  const cast = (h: unknown) => h as Handler;
  return {
    setTimezone: (timezone_: string) =>
      cast(timezone.PUT)(
        jsonRequest("/api/auth/me/timezone", "PUT", { timezone: timezone_ }),
        ctx(),
      ),
    deleteMedication: (id: string) =>
      cast(medication.DELETE)(
        jsonRequest(`/api/medications/${id}`, "DELETE"),
        ctx({ id }),
      ),
    listTokens: () =>
      cast(tokens.GET)(jsonRequest("/api/tokens", "GET"), ctx()),
    listSessions: () =>
      cast(sessions.GET)(jsonRequest("/api/auth/me/sessions", "GET"), ctx()),
  };
}

async function auditRows(action: string) {
  return getPrismaClient().auditLog.findMany({
    where: { action },
    orderBy: { createdAt: "asc" },
    select: { userId: true, actorUserId: true },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
});

describe("a guardian inside a managed profile", () => {
  it("writes the profile's setting, not their own, audited with both", async () => {
    const { guardian, profile } = await guardianInside();
    const r = await routes();

    const res = await r.setTimezone("Europe/Berlin");
    expect(res.status, await res.clone().text()).toBe(200);

    const prisma = getPrismaClient();
    const after = await prisma.user.findMany({
      where: { id: { in: [guardian.id, profile.id] } },
      select: { id: true, timezone: true },
    });
    const zone = Object.fromEntries(after.map((u) => [u.id, u.timezone]));
    expect(zone[profile.id]).toBe("Europe/Berlin");
    expect(zone[guardian.id]).toBe("UTC");
    expect(await auditRows("user.timezone.update")).toEqual([
      { userId: profile.id, actorUserId: guardian.id },
    ]);
  });

  it("deletes a medication entered by mistake", async () => {
    const { guardian, profile } = await guardianInside();
    const med = await seedMedication(profile.id);
    const r = await routes();

    const res = await r.deleteMedication(med.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(
      await getPrismaClient().medication.count({ where: { id: med.id } }),
    ).toBe(0);
    expect(await auditRows("medication.delete")).toEqual([
      { userId: profile.id, actorUserId: guardian.id },
    ]);
  });

  it("is refused the guardian's own identity surfaces", async () => {
    await guardianInside();
    const r = await routes();
    expect((await r.listTokens()).status).toBe(403);
    expect((await r.listSessions()).status).toBe(403);
  });

  it("reaches nothing in a profile it does not look after", async () => {
    const { session, guardian } = await guardianInside();
    const otherGuardian = await makeUser("other-guardian");
    const other = await makeProfile(otherGuardian.id, "Someone else's");
    const foreign = await seedMedication(other.id);
    const r = await routes();

    await switchSessionTo(session.id, other.id);
    expect((await r.deleteMedication(foreign.id)).status).toBe(403);
    expect((await r.setTimezone("Europe/Berlin")).status).toBe(403);
    const zones = await getPrismaClient().user.findMany({
      where: { id: { in: [guardian.id, other.id] } },
      select: { timezone: true },
    });
    expect(zones.every((u) => u.timezone === "UTC")).toBe(true);
  });
});

describe("everyone else stays where they were", () => {
  it("an adult's delegate at MANAGE reaches none of the owner rule", async () => {
    const { owner } = await adultInside("MANAGE");
    const med = await seedMedication(owner.id);
    const r = await routes();

    expect((await r.setTimezone("Europe/Berlin")).status).toBe(403);
    expect((await r.deleteMedication(med.id)).status).toBe(403);
    expect(
      await getPrismaClient().medication.count({ where: { id: med.id } }),
    ).toBe(1);
  });

  it("a READ grant on a managed profile is not a guardian", async () => {
    const guardian = await makeUser("guardian");
    const profile = await makeProfile(guardian.id, "Managed record");
    const reader = await makeUser("reader");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: profile.id,
      granteeId: reader.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: reader.id });
    const med = await seedMedication(profile.id);
    const session = await signIn(reader.id);
    await switchSessionTo(session.id, profile.id);
    const r = await routes();

    expect((await r.setTimezone("Europe/Berlin")).status).toBe(403);
    expect((await r.deleteMedication(med.id)).status).toBe(403);
  });
});
