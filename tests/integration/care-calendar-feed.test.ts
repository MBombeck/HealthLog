/**
 * The care calendar feed against real Postgres: booked visits, check-ups and
 * vaccination boosters coming due, served to a calendar provider by an
 * `hlf_` path credential.
 *
 * Driven through the shipped route exports: the URL is returned once and
 * never again, the body carries the dates and no free text beyond what the
 * title mode allows, the options shape the body, every miss is the same 404,
 * a Bearer token cannot mint, the partial index holds one live feed, and a
 * credential remediation ends the link.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/crypto";

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

const db = () => getPrismaClient();
const DAY = 86_400_000;
let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return db().user.create({
    data: {
      username: `care-${suffix}`,
      email: `care-${suffix}@example.test`,
      displayName: `Care ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
}

async function signIn(userId: string) {
  cookieJar.clear();
  headerJar.clear();
  const session = await db().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function manage(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const route = await import("@/app/api/care/feed-subscription/route");
  const handler = route[method] as unknown as Handler;
  return handler(
    new NextRequest("http://localhost/api/care/feed-subscription", {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({}) },
  );
}

async function fetchFeed(segment: string) {
  const saved = new Map(cookieJar);
  cookieJar.clear();
  headerJar.clear();
  const { GET } = await import("@/app/api/care/feed/[token]/route");
  const res = await (GET as unknown as Handler)(
    new NextRequest(`http://localhost/api/care/feed/${segment}`),
    { params: Promise.resolve({ token: segment }) },
  );
  for (const [k, v] of saved) cookieJar.set(k, v);
  return res;
}

async function mint(userId: string) {
  await signIn(userId);
  const res = await manage("POST");
  expect(res.status).toBe(201);
  return (await res.json()).data as { url: string; webcalUrl: string };
}

const segmentOf = (url: string) => url.split("/api/care/feed/")[1];

async function expect404(res: Response) {
  expect(res.status).toBe(404);
  expect((await res.json()).meta?.errorCode).toBe("care.feed.notFound");
}

/** A booked visit, a check-up and a booster coming due, plus decoys. */
async function seedCare(userId: string) {
  const now = Date.now();
  const practitioner = await db().practitioner.create({
    data: { userId, name: "Practice Lindenhof" },
  });
  await db().encounter.create({
    data: {
      userId,
      occurredAt: new Date(now + 5 * DAY),
      status: "PLANNED",
      practitionerId: practitioner.id,
      reasonEncrypted: Buffer.from(encrypt("SECRET-REASON-TEXT")),
    },
  });
  // Already happened: not a booking.
  await db().encounter.create({
    data: { userId, occurredAt: new Date(now - 3 * DAY), status: "DONE" },
  });
  await db().measurementReminder.create({
    data: {
      userId,
      label: "Skin check",
      location: "SECRET-LOCATION-TEXT",
      intervalDays: 365,
      nextDueAt: new Date(now + 20 * DAY),
    },
  });
  await db().measurementReminder.create({
    data: {
      userId,
      label: "Tetanus booster",
      intervalDays: 3650,
      vaccinationAntigen: "tetanus",
      nextDueAt: new Date(now + 40 * DAY),
    },
  });
  // Switched off: never in a calendar.
  await db().measurementReminder.create({
    data: {
      userId,
      label: "Disabled reminder",
      intervalDays: 30,
      enabled: false,
      nextDueAt: new Date(now + 10 * DAY),
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(db());
  cookieJar.clear();
  headerJar.clear();
});

describe("the care calendar feed", () => {
  it("returns the URL once and serves the care dates, discreet by default", async () => {
    const owner = await makeUser("owner");
    await seedCare(owner.id);
    const minted = await mint(owner.id);
    expect(minted.url).toMatch(
      /^http:\/\/localhost\/api\/care\/feed\/hlf_[0-9a-f]{48}\.ics$/,
    );

    const status = await (await manage("GET")).text();
    const raw = segmentOf(minted.url).replace(/\.ics$/, "");
    expect(status).not.toContain(raw);
    expect(status).not.toContain("/api/care/feed/");

    const res = await fetchFeed(segmentOf(minted.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    // One timed appointment, two all-day dates.
    expect(body).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(body.match(/DTSTART;VALUE=DATE:/g)).toHaveLength(2);
    expect(body).toContain("X-WR-CALNAME:HealthLog");
    expect(body).not.toContain("Lindenhof");
    expect(body).not.toContain("Skin check");
    expect(body).not.toContain("SECRET-");
    expect(body).not.toContain("Disabled reminder");
  });

  it("names the dates in descriptive mode and honours the switches", async () => {
    const owner = await makeUser("owner");
    await seedCare(owner.id);
    const minted = await mint(owner.id);

    let res = await manage("PATCH", { titleMode: "DESCRIPTIVE" });
    expect(res.status).toBe(200);
    let body = await (await fetchFeed(segmentOf(minted.url))).text();
    expect(body).toContain("SUMMARY:Appointment: Practice Lindenhof");
    expect(body).toContain("SUMMARY:Due: Skin check");
    expect(body).toContain("SUMMARY:Booster due: Tetanus booster");
    // A visit's reason and a check-up's location never travel.
    expect(body).not.toContain("SECRET-");

    res = await manage("PATCH", {
      includeVisits: false,
      includeVaccinations: false,
    });
    expect(res.status).toBe(200);
    body = await (await fetchFeed(segmentOf(minted.url))).text();
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(body).toContain("Skin check");
  });

  it("answers every miss with the same 404", async () => {
    const owner = await makeUser("owner");
    const minted = await mint(owner.id);
    await expect404(await fetchFeed("not-a-token"));
    await expect404(await fetchFeed(`hlf_${"0".repeat(48)}.ics`));

    expect((await manage("DELETE")).status).toBe(200);
    await expect404(await fetchFeed(segmentOf(minted.url)));
  });

  it("refuses a Bearer caller and a second live feed", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    expect((await manage("POST")).status).toBe(409);
    expect(await db().careCalendarFeed.count()).toBe(1);

    cookieJar.clear();
    const res = await manage("POST", undefined, {
      authorization: `Bearer hlk_${"a".repeat(64)}`,
    });
    expect([401, 403]).toContain(res.status);
  });

  it("ends with a credential remediation", async () => {
    const owner = await makeUser("owner");
    const minted = await mint(owner.id);
    const { destroyAllSessions } = await import("@/lib/auth/session");
    await destroyAllSessions(owner.id);
    await expect404(await fetchFeed(segmentOf(minted.url)));
  });
});
