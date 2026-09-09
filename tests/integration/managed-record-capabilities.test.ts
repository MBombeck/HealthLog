/**
 * v1.38.12 — what a delegate is told they may do, and what the routes then do.
 *
 * `GET /api/auth/me` publishes two lists on the active entry,
 * `writableDomains` and `manageableDomains`, and every add / edit / delete
 * control in a shared record reads them. The lists are worth nothing unless
 * the routes agree with them, so this file drives both ends over the real
 * route handlers, the real grant table and real Postgres:
 *
 *   1. a guardian acting on a managed profile reads the payload and gets
 *      every section with a delegated route as manageable, and never the
 *      vault;
 *   2. the same guardian posts a mood entry and an allergy — the two writes
 *      #939 was reported on — and both land on the PROFILE's record;
 *   3. the same guardian is refused a vault write, which is what the empty
 *      answer for `documents` promised;
 *   4. a WRITE delegate on an adult's record reads writable sections and no
 *      manageable ones, and is refused the mood entry the list withheld.
 *
 * The lists are compared against `delegatedDomains`, the helper the resolver
 * itself runs, so a change to the table shows up here as a change in what the
 * routes must then honour, not as a fixture to update.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables, switchSessionTo } from "./setup";

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

import { delegatedDomains } from "@/lib/sharing/domain-write-support";
import type { ShareDomain } from "@/lib/sharing/scope";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `caps-${suffix}`,
      email: `caps-${suffix}@example.test`,
      displayName: `Caps ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      onboardingCompletedAt: new Date(),
    },
  });
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

interface ActiveEntry {
  accountId: string;
  level: "read" | "write" | "manage";
  recordKind: "shared" | "managed";
  writableDomains: ShareDomain[];
  manageableDomains: ShareDomain[];
}

async function readActive(): Promise<ActiveEntry> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { accountAccess: { active: ActiveEntry | null } };
  };
  const active = body.data.accountAccess.active;
  if (active === null) throw new Error("expected a switched payload");
  return active;
}

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postMood() {
  const { POST } = await import("@/app/api/mood-entries/route");
  return POST(
    jsonRequest("/api/mood-entries", {
      mood: "GUT",
      moodLoggedAt: new Date().toISOString(),
    }),
  );
}

async function postAllergy() {
  const { POST } = await import("@/app/api/allergies/route");
  return POST(
    jsonRequest("/api/allergies", {
      substance: "Penicillin",
      category: "MEDICATION",
      severity: "SEVERE",
    }),
  );
}

async function postDocumentsBulk() {
  const { POST } = await import("@/app/api/documents/inbound/bulk/route");
  return POST(
    jsonRequest("/api/documents/inbound/bulk", {
      ids: [],
      action: "setKind",
      kind: "OTHER",
    }),
  );
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
});

describe("a guardian acting on a managed profile", () => {
  async function guardianInside() {
    const guardian = await makeUser("guardian");
    const { createManagedProfile } =
      await import("@/lib/managed-profiles/create");
    const { profile } = await createManagedProfile({
      creatorId: guardian.id,
      displayName: "Managed record",
      dateOfBirth: null,
      locale: "en",
      timezone: "UTC",
    });
    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);
    return { guardian, profile };
  }

  it("is told every section with a delegated route is manageable, and the vault is not", async () => {
    const { profile } = await guardianInside();
    const active = await readActive();

    expect(active.accountId).toBe(profile.id);
    expect(active.level).toBe("manage");
    expect(active.recordKind).toBe("managed");
    expect(active.writableDomains).toEqual(
      delegatedDomains("manage", null, "write"),
    );
    expect(active.manageableDomains).toEqual(
      delegatedDomains("manage", null, "manage"),
    );
    // The sections #939 named, by name, so the list is not only self-consistent.
    for (const domain of ["mind", "profile", "labs", "measurements"] as const) {
      expect(active.manageableDomains, domain).toContain(domain);
    }
    expect(active.manageableDomains).not.toContain("documents");
    expect(active.writableDomains).not.toContain("documents");
  });

  it("lands a mood entry and an allergy on the profile's record", async () => {
    const { guardian, profile } = await guardianInside();

    const mood = await postMood();
    expect(mood.status).toBe(201);
    const moodRows = await getPrismaClient().moodEntry.findMany({
      where: { userId: profile.id },
    });
    expect(moodRows).toHaveLength(1);
    expect(
      await getPrismaClient().moodEntry.count({
        where: { userId: guardian.id },
      }),
    ).toBe(0);

    const allergy = await postAllergy();
    expect(allergy.status).toBe(201);
    const allergyRows = await getPrismaClient().allergy.findMany({
      where: { userId: profile.id },
    });
    expect(allergyRows).toHaveLength(1);
    expect(allergyRows[0]?.substance).toBe("Penicillin");
  });

  it("is refused a vault write, as the empty documents answer promised", async () => {
    await guardianInside();
    const res = await postDocumentsBulk();
    expect(res.status).toBe(403);
  });
});

describe("a WRITE delegate on an adult's record", () => {
  it("reads writable sections without manageable ones, and is refused the mood entry", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: delegate.id,
      access: "WRITE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: delegate.id });
    const session = await signIn(delegate.id);
    await switchSessionTo(session.id, owner.id);

    const active = await readActive();
    expect(active.level).toBe("write");
    expect(active.writableDomains).toEqual(
      delegatedDomains("write", null, "write"),
    );
    expect(active.writableDomains).toContain("measurements");
    expect(active.writableDomains).not.toContain("mind");
    expect(active.manageableDomains).toEqual([]);

    // The route agrees with the list: a mood entry is a MANAGE create.
    const mood = await postMood();
    expect(mood.status).toBe(403);
    expect(
      await getPrismaClient().moodEntry.count({ where: { userId: owner.id } }),
    ).toBe(0);
  });
});
