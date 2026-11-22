/**
 * The emergency card, the care calendar feed and the report schedule for a
 * managed profile.
 *
 * A managed profile (a child, a parent with dementia) has nobody who signs in.
 * These three surfaces were the caller's own only, so nobody could ever make
 * a card, a calendar or a monthly report for such a profile, and a guardian
 * who had switched into it got their own. They now resolve through
 * `requireGuardianAuth`, like the cycle feed: the owner on their own record,
 * or the guardian of a managed profile. A delegate on an adult's record is
 * refused at every grant level. A link a guardian made rests on the
 * guardian's live grant and ends with the handover.
 *
 * Mutations that must turn these red: put `requireActorAuth` back on any of
 * the routes (the guardian reads their own card, the schedule lands on their
 * own row), drop `guardianMintRefusal` from a serve path (a revoked grant
 * keeps the link alive), or drop the handover revocation in `lifecycle.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readEmergencyCardByToken } from "@/lib/emergency-card/serve";
import { writeEmergencyProfile } from "@/lib/profile/emergency-profile";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-guardian-surfaces-integration-32-bytes-1234567890";

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

const db = () => getPrismaClient();
let counter = 0;

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

beforeEach(async () => {
  await truncateAllTables(db());
  cookieJar.clear();
  headerJar.clear();
});

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const suffix = `${label}-${counter++}`;
  return db().user.create({
    data: {
      username: `gs-${suffix}`,
      email: `gs-${suffix}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      ...extra,
    },
  });
}

async function grant(grantorId: string, granteeId: string) {
  const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
  const invited = await inviteGrant({
    grantorId,
    granteeId,
    access: "MANAGE",
    scope: null,
  });
  return acceptGrant({ grantId: invited.id, granteeId });
}

async function signInAs(userId: string, actingAs: string | null) {
  cookieJar.clear();
  headerJar.clear();
  const session = await db().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
  if (actingAs) await switchSessionTo(session.id, actingAs);
  return session;
}

async function call(
  modulePath: string,
  url: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: unknown,
) {
  const route = (await import(modulePath)) as Record<string, unknown>;
  return (route[method] as Handler)(
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({}) },
  );
}

const card = (
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
  link = false,
) =>
  call(
    link
      ? "@/app/api/emergency-card/link/route"
      : "@/app/api/emergency-card/route",
    link ? "/api/emergency-card/link" : "/api/emergency-card",
    method,
    body,
  );

async function fetchCareFeed(segment: string) {
  const saved = new Map(cookieJar);
  cookieJar.clear();
  const { GET } = await import("@/app/api/care/feed/[token]/route");
  const res = await (GET as unknown as Handler)(
    new NextRequest(`http://localhost/api/care/feed/${segment}`),
    { params: Promise.resolve({ token: segment }) },
  );
  for (const [k, v] of saved) cookieJar.set(k, v);
  return res;
}

const anon = () =>
  new Request("http://localhost/e", { headers: new Headers() });

describe("a managed profile's guardian", () => {
  it("reads the profile's emergency card and makes its link, which the grant and the handover end", async () => {
    const profile = await makeUser("profile", { managedProfileAt: new Date() });
    const guardian = await makeUser("guardian");
    await writeEmergencyProfile(profile.id, { bloodType: "O_NEG" });
    const g = await grant(profile.id, guardian.id);
    await signInAs(guardian.id, profile.id);

    const read = await card("GET");
    expect(read.status).toBe(200);
    const view = (await read.json()).data.card;
    expect(view.bloodType).toBe("O_NEG");

    const minted = await card("POST", { fields: ["BLOOD_TYPE"] }, true);
    expect(minted.status).toBe(201);
    const { url } = (await minted.json()).data as { url: string };
    const row = await db().emergencyCardLink.findFirstOrThrow({
      where: { userId: profile.id },
    });
    expect(row.createdById).toBe(guardian.id);
    const token = url.split("/e/")[1];
    expect((await readEmergencyCardByToken(anon(), token)).ok).toBe(true);

    await db().accountGrant.update({
      where: { id: g.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });
    expect((await readEmergencyCardByToken(anon(), token)).ok).toBe(false);
    await db().accountGrant.update({
      where: { id: g.id },
      data: { revokedAt: null, revokedBy: null },
    });
    expect((await readEmergencyCardByToken(anon(), token)).ok).toBe(true);

    const { clearManagedProfileMarker } =
      await import("@/lib/managed-profiles/lifecycle");
    await clearManagedProfileMarker({ profileId: profile.id });
    const after = await db().emergencyCardLink.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.revokedAt).not.toBeNull();
  });

  it("turns on the profile's care calendar, which a revoked grant ends", async () => {
    const profile = await makeUser("profile", { managedProfileAt: new Date() });
    const guardian = await makeUser("guardian");
    const g = await grant(profile.id, guardian.id);
    await signInAs(guardian.id, profile.id);

    const on = await call(
      "@/app/api/care/feed-subscription/route",
      "/api/care/feed-subscription",
      "POST",
    );
    expect(on.status).toBe(201);
    const { url } = (await on.json()).data as { url: string };
    const row = await db().careCalendarFeed.findFirstOrThrow({
      where: { userId: profile.id },
    });
    expect(row.createdById).toBe(guardian.id);
    const segment = url.split("/").pop()!;
    expect((await fetchCareFeed(segment)).status).toBe(200);

    await db().accountGrant.update({
      where: { id: g.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });
    expect((await fetchCareFeed(segment)).status).toBe(404);
  });

  it("sets the profile's report schedule, not their own", async () => {
    const profile = await makeUser("profile", { managedProfileAt: new Date() });
    const guardian = await makeUser("guardian");
    await grant(profile.id, guardian.id);
    await signInAs(guardian.id, profile.id);

    const res = await call(
      "@/app/api/settings/report-schedule/route",
      "/api/settings/report-schedule",
      "PUT",
      { cadence: "MONTHLY", window: "PERIOD" },
    );
    expect(res.status).toBe(200);
    const [own, theirs] = await Promise.all([
      db().user.findUniqueOrThrow({ where: { id: guardian.id } }),
      db().user.findUniqueOrThrow({ where: { id: profile.id } }),
    ]);
    expect(own.reportScheduleJson).toBeNull();
    expect(theirs.reportScheduleJson).not.toBeNull();
  });
});

describe("a delegate on an adult's record", () => {
  it("is refused the card, the card link, the care calendar and the schedule", async () => {
    const adult = await makeUser("adult");
    const delegate = await makeUser("delegate");
    await grant(adult.id, delegate.id);
    await signInAs(delegate.id, adult.id);

    expect((await card("GET")).status).toBe(403);
    expect((await card("POST", { fields: ["BLOOD_TYPE"] }, true)).status).toBe(
      403,
    );
    expect(
      (
        await call(
          "@/app/api/care/feed-subscription/route",
          "/api/care/feed-subscription",
          "POST",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "@/app/api/settings/report-schedule/route",
          "/api/settings/report-schedule",
          "PUT",
          { cadence: "MONTHLY", window: "PERIOD" },
        )
      ).status,
    ).toBe(403);
    expect(await db().emergencyCardLink.count()).toBe(0);
    expect(await db().careCalendarFeed.count()).toBe(0);
  });
});
