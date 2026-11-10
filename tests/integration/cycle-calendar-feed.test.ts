/**
 * #1350 — the subscribable cycle forecast, against real Postgres.
 *
 * The management routes and the anonymous feed driven through their shipped
 * exports: the URL is returned once and never again, every miss class is the
 * same 404, a Bearer token and a stale session cannot mint, a READ delegate
 * cannot, the partial index holds one live feed per record, and the lifecycle
 * hooks (handover claim, carrier deletion, credential remediation) end the
 * link.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";

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

const db = () => getPrismaClient();
let counter = 0;

async function makeUser(label: string, extra: Record<string, unknown> = {}) {
  const suffix = `${label}-${counter++}`;
  return db().user.create({
    data: {
      username: `cf-${suffix}`,
      email: `cf-${suffix}@example.test`,
      displayName: `CF ${suffix}`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
      gender: "FEMALE",
      ...extra,
    },
  });
}

async function signIn(userId: string, createdAt?: Date) {
  cookieJar.clear();
  headerJar.clear();
  const session = await db().session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      ...(createdAt ? { createdAt } : {}),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

/** Thirteen regular cycles, the last one starting three weeks ago. */
async function seedCycles(userId: string) {
  const today = new Date();
  const lastStart = new Date(today.getTime() - 21 * 86_400_000);
  for (let i = 12; i >= 0; i--) {
    const start = new Date(lastStart.getTime() - i * 28 * 86_400_000);
    const key = start.toISOString().slice(0, 10);
    await db().menstrualCycle.create({
      data: {
        userId,
        startDate: key,
        periodEndDate: new Date(start.getTime() + 4 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      },
    });
  }
}

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

function req(method: string, path: string, body?: unknown, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function manage(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
  headers = {},
) {
  const route = await import("@/app/api/cycle/feed-subscription/route");
  const handler = route[method] as unknown as Handler;
  return handler(req(method, "/api/cycle/feed-subscription", body, headers), {
    params: Promise.resolve({}),
  });
}

async function rotate() {
  const { POST } =
    await import("@/app/api/cycle/feed-subscription/rotate/route");
  return (POST as unknown as Handler)(
    req("POST", "/api/cycle/feed-subscription/rotate"),
    { params: Promise.resolve({}) },
  );
}

async function fetchFeed(
  segment: string,
  headers: Record<string, string> = {},
) {
  const saved = new Map(cookieJar);
  cookieJar.clear();
  headerJar.clear();
  const { GET } = await import("@/app/api/cycle/feed/[token]/route");
  const res = await (GET as unknown as Handler)(
    new NextRequest(`http://localhost/api/cycle/feed/${segment}`, { headers }),
    { params: Promise.resolve({ token: segment }) },
  );
  for (const [k, v] of saved) cookieJar.set(k, v);
  return res;
}

async function mint(userId: string) {
  await signIn(userId);
  const res = await manage("POST");
  expect(res.status).toBe(201);
  const { data } = await res.json();
  return data as {
    url: string;
    webcalUrl: string;
    feed: { tokenPrefix: string };
  };
}

function segmentOf(url: string): string {
  return url.split("/api/cycle/feed/")[1];
}

async function expect404(res: Response) {
  expect(res.status).toBe(404);
  expect((await res.json()).meta?.errorCode).toBe("cycle.feed.notFound");
}

beforeEach(async () => {
  await truncateAllTables(db());
  cookieJar.clear();
  headerJar.clear();
});

describe("turning the subscription on", () => {
  it("returns the URL once; the status never carries the hash or the URL", async () => {
    const owner = await makeUser("owner");
    await seedCycles(owner.id);
    const minted = await mint(owner.id);

    expect(minted.url).toMatch(
      /^http:\/\/localhost\/api\/cycle\/feed\/hlf_[0-9a-f]{48}\.ics$/,
    );
    expect(minted.webcalUrl).toBe(minted.url.replace(/^http:/, "webcal:"));

    const row = await db().cycleCalendarFeed.findFirstOrThrow({
      where: { userId: owner.id },
    });
    const raw = segmentOf(minted.url).replace(/\.ics$/, "");
    expect(row.tokenHash).not.toContain(raw);
    expect(row.tokenPrefix).toBe(raw.slice(0, 8));
    expect(row.createdById).toBe(owner.id);

    const status = await (await manage("GET")).text();
    expect(status).not.toContain(raw);
    expect(status).not.toContain(row.tokenHash);
    expect(status).not.toContain("/api/cycle/feed/");
    expect(JSON.parse(status).data.feed.tokenPrefix).toBe(row.tokenPrefix);

    const audit = await db().auditLog.findFirst({
      where: { action: "cycle.feed.create", userId: owner.id },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses a second live feed; rotate leaves exactly one", async () => {
    const owner = await makeUser("owner");
    const first = await mint(owner.id);
    expect((await manage("POST")).status).toBe(409);

    const res = await rotate();
    expect(res.status).toBe(201);
    const second = (await res.json()).data as { url: string };
    expect(second.url).not.toBe(first.url);

    const live = await db().cycleCalendarFeed.findMany({
      where: { userId: owner.id, revokedAt: null },
    });
    expect(live).toHaveLength(1);
    await expect404(await fetchFeed(segmentOf(first.url)));
    expect((await fetchFeed(segmentOf(second.url))).status).toBe(200);
    expect(
      await db().auditLog.count({ where: { action: "cycle.feed.rotate" } }),
    ).toBe(1);
  });

  it("answers the losing one of two racing rotations with 409, never 500", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    // Both read the same live feed and revoke it; the second successor then
    // meets the one-live-feed index. A fast runner can still finish one
    // rotation before the other starts, so rounds go on until a pair has
    // really collided, with the mint bucket emptied between them.
    const statuses: number[] = [];
    for (let round = 0; round < 25 && !statuses.includes(409); round++) {
      await db().rateLimit.deleteMany();
      const pair = await Promise.all([rotate(), rotate()]);
      for (const res of pair) {
        statuses.push(res.status);
        if (res.status === 409) {
          expect((await res.json()).meta.errorCode).toBe("cycle.feed.exists");
        }
      }
      expect(
        await db().cycleCalendarFeed.count({
          where: { userId: owner.id, revokedAt: null },
        }),
      ).toBe(1);
    }
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    // The race was really run, not sidestepped by one finishing first.
    expect(statuses).toContain(409);
  });

  /**
   * Run `rotate()` while `write` holds the live feed's row in an open
   * transaction, and commit `write` only once the rotation is waiting on
   * that row: the rotation has read the feed, and its revoke comes after
   * the competing write whatever the scheduler does.
   */
  async function rotateAround(
    userId: string,
    write: (tx: Prisma.TransactionClient, feedId: string) => Promise<void>,
  ): Promise<Response> {
    const feed = await db().cycleCalendarFeed.findFirstOrThrow({
      where: { userId, revokedAt: null },
      select: { id: true },
    });
    let pending: Promise<Response> | undefined;
    await db().$transaction(
      async (tx) => {
        await write(tx, feed.id);
        pending = rotate();
        for (let i = 0; i < 100; i++) {
          const [{ n }] = await db().$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`;
          if (n > 0) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("the rotation never waited on the feed row");
      },
      { timeout: 10_000 },
    );
    return pending!;
  }

  it("keeps a subscription that is turned off during a rotation off", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    const res = await rotateAround(owner.id, async (tx, feedId) => {
      await tx.cycleCalendarFeed.update({
        where: { id: feedId },
        data: { revokedAt: new Date() },
      });
    });
    expect(res.status).toBe(409);
    expect(
      await db().cycleCalendarFeed.count({
        where: { userId: owner.id, revokedAt: null },
      }),
    ).toBe(0);
  });

  it("carries an option changed during a rotation onto the new link", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    const res = await rotateAround(owner.id, async (tx, feedId) => {
      await tx.cycleCalendarFeed.update({
        where: { id: feedId },
        data: { forecastStyle: "EXACT" },
      });
    });
    expect(res.status).toBe(201);
    const live = await db().cycleCalendarFeed.findFirstOrThrow({
      where: { userId: owner.id, revokedAt: null },
      select: { forecastStyle: true },
    });
    expect(live.forecastStyle).toBe("EXACT");
  });

  it("the partial unique index rejects a second live row written directly", async () => {
    const owner = await makeUser("owner");
    const base = {
      userId: owner.id,
      createdById: owner.id,
      tokenPrefix: "hlf_0000",
    };
    await db().cycleCalendarFeed.create({ data: { ...base, tokenHash: "a" } });
    await expect(
      db().cycleCalendarFeed.create({ data: { ...base, tokenHash: "b" } }),
    ).rejects.toThrow();
    // A revoked row does not count.
    await db().cycleCalendarFeed.updateMany({
      where: { userId: owner.id },
      data: { revokedAt: new Date() },
    });
    await db().cycleCalendarFeed.create({ data: { ...base, tokenHash: "b" } });
  });

  it("the table refuses a horizon outside 1..6", async () => {
    const owner = await makeUser("owner");
    await expect(
      db().cycleCalendarFeed.create({
        data: {
          userId: owner.id,
          createdById: owner.id,
          tokenHash: "x",
          tokenPrefix: "hlf_0000",
          horizonCycles: 12,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a Bearer token, even a cookie-equivalent one", async () => {
    const owner = await makeUser("owner");
    const { issueApiToken } = await import("@/lib/auth/issue-token");
    const issued = await issueApiToken({ userId: owner.id, name: "app" });
    cookieJar.clear();
    headerJar.clear();
    headerJar.set("authorization", `Bearer ${issued.token}`);
    const res = await manage("POST", undefined, {
      authorization: `Bearer ${issued.token}`,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).meta?.errorCode).toBe("cycle.feed.cookie_only");
    expect(await db().cycleCalendarFeed.count()).toBe(0);
  });

  it("refuses a session without a fresh proof", async () => {
    const owner = await makeUser("owner");
    await signIn(owner.id, new Date(Date.now() - 60 * 60 * 1000));
    const res = await manage("POST");
    expect(res.status).toBe(401);
    expect((await res.json()).meta?.errorCode).toBe("auth.reproof.required");
    expect(await db().cycleCalendarFeed.count()).toBe(0);
  });

  it("refuses a READ delegate", async () => {
    const owner = await makeUser("owner");
    const reader = await makeUser("reader");
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: reader.id,
      access: "READ",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: reader.id });
    const session = await signIn(reader.id);
    await switchSessionTo(session.id, owner.id);

    expect((await manage("POST")).status).toBe(403);
    expect((await manage("GET")).status).toBe(403);
    expect(await db().cycleCalendarFeed.count()).toBe(0);
  });

  it("refuses a MANAGE delegate on an adult's record, for every verb", async () => {
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    // The owner's own feed exists, so a refused DELETE has something to miss.
    await mint(owner.id);
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: manager.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: manager.id });
    const session = await signIn(manager.id);
    await switchSessionTo(session.id, owner.id);

    for (const res of [
      await manage("GET"),
      await manage("POST"),
      await manage("PATCH", { horizonCycles: 6 }),
      await manage("DELETE"),
      await rotate(),
    ]) {
      expect(res.status).toBe(403);
    }
    const feeds = await db().cycleCalendarFeed.findMany({
      where: { userId: owner.id },
    });
    expect(feeds).toHaveLength(1);
    expect(feeds[0].revokedAt).toBeNull();
    expect(feeds[0].horizonCycles).toBe(3);
    expect(feeds[0].createdById).toBe(owner.id);
  });

  it("serves no feed a delegate holds on an adult's record, even with MANAGE", async () => {
    // Written directly, as a row from before the narrowing would look: the
    // fetch path refuses it on the missing managed-profile marker alone.
    const owner = await makeUser("owner");
    const manager = await makeUser("manager");
    await seedCycles(owner.id);
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: owner.id,
      granteeId: manager.id,
      access: "MANAGE",
      scope: null,
    });
    await acceptGrant({ grantId: invited.id, granteeId: manager.id });
    const { mintFeedToken } = await import("@/lib/cycle/feed/token");
    const minted = mintFeedToken();
    await db().cycleCalendarFeed.create({
      data: {
        userId: owner.id,
        createdById: manager.id,
        tokenHash: minted.hash,
        tokenPrefix: minted.prefix,
      },
    });
    await expect404(await fetchFeed(`${minted.raw}.ics`));
  });

  it("refuses the fertile window outside TRYING_TO_CONCEIVE", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    const res = await manage("PATCH", { includeFertile: true });
    expect(res.status).toBe(422);
    expect((await res.json()).meta?.errorCode).toBe("cycle.feed.fertile_goal");
  });

  it("never stores an idempotent replay of the mint", async () => {
    const owner = await makeUser("owner");
    await signIn(owner.id);
    const key = "feed-mint-replay-key-1";
    const first = await manage("POST", undefined, { "idempotency-key": key });
    expect(first.status).toBe(201);
    const second = await manage("POST", undefined, { "idempotency-key": key });
    // Not a replay of the URL: the second request ran and met the live feed.
    expect(second.headers.get("x-idempotent-replay")).not.toBe("true");
    expect(second.status).toBe(409);
    const cached = await db().idempotencyKey.findMany({
      where: { userId: owner.id },
    });
    for (const row of cached) {
      expect(row.responseBody == null || row.responseBody.length === 0).toBe(
        true,
      );
    }
  });
});

describe("the forecast style", () => {
  /** The live row's style, read from the table rather than the route. */
  async function liveStyle(userId: string) {
    const row = await db().cycleCalendarFeed.findFirstOrThrow({
      where: { userId, revokedAt: null },
      select: { forecastStyle: true },
    });
    return row.forecastStyle;
  }

  /** How many VEVENTs the live link serves. */
  async function eventCount(url: string) {
    const res = await fetchFeed(segmentOf(url));
    expect(res.status).toBe(200);
    return (await res.text()).split("BEGIN:VEVENT").length - 1;
  }

  it("starts a new subscription on MARGIN and publishes it in the status", async () => {
    const owner = await makeUser("owner");
    await seedCycles(owner.id);
    await signIn(owner.id);
    const res = await manage("POST");
    expect(res.status).toBe(201);
    expect((await res.json()).data.feed.forecastStyle).toBe("MARGIN");
    expect(await liveStyle(owner.id)).toBe("MARGIN");
    const status = (await (await manage("GET")).json()).data;
    expect(status.feed.forecastStyle).toBe("MARGIN");
  });

  it("keeps a feed minted before the option on BAND, through a rotation", async () => {
    const owner = await makeUser("owner");
    // A row written without the column, as every feed minted before it was.
    await db().cycleCalendarFeed.create({
      data: {
        userId: owner.id,
        createdById: owner.id,
        tokenHash: "pre-option",
        tokenPrefix: "hlf_0000",
      },
    });
    expect(await liveStyle(owner.id)).toBe("BAND");

    await signIn(owner.id);
    const res = await rotate();
    expect(res.status).toBe(201);
    expect((await res.json()).data.feed.forecastStyle).toBe("BAND");
    expect(await liveStyle(owner.id)).toBe("BAND");
  });

  it("changes on PATCH, is audited, survives a rotation, and changes the body", async () => {
    const owner = await makeUser("owner");
    await seedCycles(owner.id);
    const minted = await mint(owner.id);
    const marginEvents = await eventCount(minted.url);

    await signIn(owner.id);
    const res = await manage("PATCH", { forecastStyle: "EXACT" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.feed.forecastStyle).toBe("EXACT");
    expect(await liveStyle(owner.id)).toBe("EXACT");
    // The calculated period alone: fewer events than with its margins, and
    // one per forecast cycle.
    const exactEvents = await eventCount(minted.url);
    expect(exactEvents).toBeGreaterThan(0);
    expect(marginEvents).toBeGreaterThan(exactEvents);

    const audit = await db().auditLog.findFirstOrThrow({
      where: { action: "cycle.feed.update", userId: owner.id },
    });
    // The audit names the changed field and the value it replaced.
    const details = JSON.parse(audit.details ?? "{}");
    expect(details.fields).toEqual(["forecastStyle"]);
    expect(details.previous).toEqual({ forecastStyle: "MARGIN" });

    await signIn(owner.id);
    const rotated = await rotate();
    expect(rotated.status).toBe(201);
    expect((await rotated.json()).data.feed.forecastStyle).toBe("EXACT");
    expect(await liveStyle(owner.id)).toBe("EXACT");
  });

  it("refuses a style that does not exist", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    const res = await manage("PATCH", { forecastStyle: "WIDE" });
    expect(res.status).toBe(422);
    expect(await liveStyle(owner.id)).toBe("MARGIN");
  });
});

describe("fetching the feed", () => {
  it("serves iCalendar with an ETag and answers 304 to it", async () => {
    const owner = await makeUser("owner");
    await seedCycles(owner.id);
    const minted = await mint(owner.id);

    const res = await fetchFeed(segmentOf(minted.url), {
      "user-agent": "Google-Calendar-Importer",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/calendar; charset=utf-8",
    );
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("SUMMARY:●");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    // Let the fire-and-forget statistics land before the conditional fetch.
    const { settleBackgroundTasks } =
      await import("@/lib/logging/background-tasks");
    await settleBackgroundTasks();
    const again = await fetchFeed(segmentOf(minted.url), {
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
    await settleBackgroundTasks();

    const row = await db().cycleCalendarFeed.findFirstOrThrow({
      where: { userId: owner.id },
    });
    expect(row.fetchCount).toBe(2);
    expect(row.bodyHash).toBe(etag.slice(1, -1));

    await signIn(owner.id);
    const status = (await (await manage("GET")).json()).data;
    expect(status.feed.lastFetcher).toBe("GOOGLE");
    expect(status.feed.fetchCount).toBe(2);
  });

  it("answers the same 404 for every miss class", async () => {
    const owner = await makeUser("owner");
    await seedCycles(owner.id);
    const minted = await mint(owner.id);
    const live = segmentOf(minted.url);

    await expect404(await fetchFeed(`hlf_${"0".repeat(48)}.ics`)); // unknown
    await expect404(await fetchFeed("hlf_short")); // malformed

    // The operator's external-access switch.
    await db().appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", apiGlobal: false },
      update: { apiGlobal: false },
    });
    await expect404(await fetchFeed(live));
    await db().appSettings.update({
      where: { id: "singleton" },
      data: { apiGlobal: true },
    });

    // The operator's module switch.
    await db().appSettings.update({
      where: { id: "singleton" },
      data: { moduleAvailabilityJson: { cycle: false } },
    });
    await expect404(await fetchFeed(live));
    await db().appSettings.update({
      where: { id: "singleton" },
      data: { moduleAvailabilityJson: {} },
    });

    // The person's own toggle.
    await db().cycleProfile.update({
      where: { userId: owner.id },
      data: { cycleTrackingEnabled: false },
    });
    await expect404(await fetchFeed(live));
    await db().cycleProfile.update({
      where: { userId: owner.id },
      data: { cycleTrackingEnabled: true },
    });

    // Back to serving, so the misses above are the gates and not the fixture.
    expect((await fetchFeed(live)).status).toBe(200);

    // An account in its deletion window.
    await db().user.update({
      where: { id: owner.id },
      data: { deletionRequestedAt: new Date() },
    });
    await expect404(await fetchFeed(live));
    await db().user.update({
      where: { id: owner.id },
      data: { deletionRequestedAt: null },
    });

    // Revoked.
    await signIn(owner.id);
    expect((await manage("DELETE")).status).toBe(200);
    await expect404(await fetchFeed(live));
  });

  it("throttles a well-formed unknown token through the anonymous limit", async () => {
    let throttled = false;
    for (let i = 0; i < 610 && !throttled; i++) {
      const res = await fetchFeed(`hlf_${"1".repeat(48)}.ics`);
      if (res.status === 429) throttled = true;
      else expect(res.status).toBe(404);
    }
    expect(throttled).toBe(true);
  });

  it("lets a managed profile's guardian hold one, until the grant or the handover ends it", async () => {
    const profile = await makeUser("profile", { managedProfileAt: new Date() });
    const guardian = await makeUser("guardian");
    await seedCycles(profile.id);
    const { inviteGrant, acceptGrant } = await import("@/lib/sharing/grants");
    const invited = await inviteGrant({
      grantorId: profile.id,
      granteeId: guardian.id,
      access: "MANAGE",
      scope: null,
    });
    const grant = await acceptGrant({
      grantId: invited.id,
      granteeId: guardian.id,
    });

    const session = await signIn(guardian.id);
    await switchSessionTo(session.id, profile.id);
    const res = await manage("POST");
    expect(res.status).toBe(201);
    const { url } = (await res.json()).data as { url: string };
    const row = await db().cycleCalendarFeed.findFirstOrThrow({
      where: { userId: profile.id },
    });
    expect(row.createdById).toBe(guardian.id);
    expect((await fetchFeed(segmentOf(url))).status).toBe(200);

    // Grant revoked: the next poll is a 404, with no write anywhere.
    await db().accountGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });
    await expect404(await fetchFeed(segmentOf(url)));
    await db().accountGrant.update({
      where: { id: grant.id },
      data: { revokedAt: null, revokedBy: null },
    });
    expect((await fetchFeed(segmentOf(url))).status).toBe(200);

    // The handover claim ends the carrier's feed outright.
    const { clearManagedProfileMarker } =
      await import("@/lib/managed-profiles/lifecycle");
    await clearManagedProfileMarker({ profileId: profile.id });
    const after = await db().cycleCalendarFeed.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.revokedAt).not.toBeNull();
    expect(
      await db().auditLog.count({
        where: { action: "cycle.feed.revoke.handover", userId: profile.id },
      }),
    ).toBe(1);
  });

  it("is removed when the carrier's account is deleted", async () => {
    const owner = await makeUser("owner");
    const carrier = await makeUser("carrier");
    await db().cycleCalendarFeed.create({
      data: {
        userId: owner.id,
        createdById: carrier.id,
        tokenHash: "cascade",
        tokenPrefix: "hlf_0000",
      },
    });
    await db().user.delete({ where: { id: carrier.id } });
    expect(await db().cycleCalendarFeed.count()).toBe(0);
  });

  it("is revoked by a credential remediation on either account", async () => {
    const owner = await makeUser("owner");
    await mint(owner.id);
    const { destroyAllSessions } = await import("@/lib/auth/session");
    await destroyAllSessions(owner.id);
    expect(
      await db().cycleCalendarFeed.count({
        where: { userId: owner.id, revokedAt: null },
      }),
    ).toBe(0);
  });
});
