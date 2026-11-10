/**
 * #1350 — the anonymous feed fetch: the limit before any lookup, one 404 for
 * every miss, every gate re-read per fetch, and the ETag / 304 path.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  cycleCalendarFeed: { findFirst: vi.fn(), update: vi.fn() },
  user: { findFirst: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

const limits = vi.hoisted(() => ({
  surface: vi.fn(),
  token: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkAuthSurfaceRateLimit: limits.surface,
  checkRateLimit: limits.token,
  rateLimitHeaders: () => ({ "Retry-After": "60" }),
}));

const gates = vi.hoisted(() => ({
  api: vi.fn(),
  cycle: vi.fn(),
  grant: vi.fn(),
}));
vi.mock("@/lib/app-settings", () => ({ isApiGloballyEnabled: gates.api }));
vi.mock("@/lib/cycle/gate", () => ({ isCycleAvailableForUser: gates.cycle }));
vi.mock("@/lib/sharing/grant-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/sharing/grant-access")>()),
  findActiveGrant: gates.grant,
}));

const built = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("../build", () => ({ buildCycleFeed: built.build }));

import { hashToken } from "@/lib/auth/hmac";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { serveCycleFeed } from "../serve";

const TOKEN = `hlf_${"ab".repeat(24)}`;
const ALLOWED = { allowed: true, limit: 1, remaining: 1, resetAt: new Date() };

const FEED_ROW = {
  id: "feed-1",
  userId: "subject",
  createdById: "subject",
  bodyHash: "old-hash",
  contentChangedAt: new Date("2026-11-01T00:00:00Z"),
  horizonCycles: 3,
  historyCycles: 0,
  includeFertile: false,
  titleMode: "DISCREET",
  forecastStyle: "BAND",
};

function request(path = `${TOKEN}.ics`, headers: Record<string, string> = {}) {
  return {
    req: new NextRequest(`http://localhost/api/cycle/feed/${path}`, {
      headers,
    }),
    segment: path,
  };
}

async function fetchFeed(path?: string, headers?: Record<string, string>) {
  const { req, segment } = request(path, headers);
  const res = await serveCycleFeed(req, segment);
  await settleBackgroundTasks();
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("API_TOKEN_HMAC_KEY", "k".repeat(40));
  limits.surface.mockResolvedValue({ ...ALLOWED, ip: "203.0.113.7" });
  limits.token.mockResolvedValue(ALLOWED);
  db.cycleCalendarFeed.findFirst.mockResolvedValue(FEED_ROW);
  db.cycleCalendarFeed.update.mockResolvedValue({});
  db.user.findFirst.mockResolvedValue({
    id: "subject",
    timezone: "Europe/Berlin",
    locale: "en",
    managedProfileAt: null,
  });
  gates.api.mockResolvedValue(true);
  gates.cycle.mockResolvedValue(true);
  gates.grant.mockResolvedValue(null);
  built.build.mockResolvedValue({
    calendar: {
      name: "HealthLog",
      events: [
        {
          uid: "u@healthlog.invalid",
          start: "2026-11-15",
          endExclusive: "2026-11-22",
          summary: "●",
        },
      ],
    },
    contentHash: "new-hash",
    projectionState: "OK",
  });
});

async function expectBlunt404(res: Response) {
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body).toMatchObject({ error: "Not found" });
  expect(body.meta?.errorCode).toBe("cycle.feed.notFound");
  expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

describe("serveCycleFeed", () => {
  it("serves the calendar with its validator and privacy headers", async () => {
    const res = await fetchFeed();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, max-age=0",
    );
    expect(res.headers.get("etag")).toBe('"new-hash"');
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
  });

  it("looks the token up by its HMAC, live rows only", async () => {
    await fetchFeed();
    expect(db.cycleCalendarFeed.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashToken(TOKEN), revokedAt: null },
      }),
    );
  });

  it("takes the anonymous limit before any lookup", async () => {
    limits.surface.mockResolvedValue({ ...ALLOWED, allowed: false, ip: null });
    const res = await fetchFeed();
    expect(res.status).toBe(429);
    expect(db.cycleCalendarFeed.findFirst).not.toHaveBeenCalled();
    expect(limits.surface).toHaveBeenCalledWith(
      expect.anything(),
      "cycle-feed",
      600,
      3_600_000,
    );
  });

  it("throttles one link through its own bucket", async () => {
    limits.token.mockResolvedValue({ ...ALLOWED, allowed: false });
    const res = await fetchFeed();
    expect(res.status).toBe(429);
    expect(limits.token).toHaveBeenCalledWith(
      `cycle-feed:${hashToken(TOKEN)}`,
      120,
      3_600_000,
    );
    expect(built.build).not.toHaveBeenCalled();
  });

  it("answers a malformed token without a lookup", async () => {
    await expectBlunt404(await fetchFeed("hlf_short.ics"));
    await expectBlunt404(await fetchFeed(`hlk_${"ab".repeat(24)}`));
    expect(db.cycleCalendarFeed.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unknown or revoked",
      () => db.cycleCalendarFeed.findFirst.mockResolvedValue(null),
    ],
    [
      "the record pending deletion or gone",
      () => db.user.findFirst.mockResolvedValue(null),
    ],
    [
      "the operator's external-access switch off",
      () => gates.api.mockResolvedValue(false),
    ],
    ["cycle tracking off", () => gates.cycle.mockResolvedValue(false)],
  ])("answers the same 404 for %s", async (_label, arrange) => {
    arrange();
    await expectBlunt404(await fetchFeed());
    expect(built.build).not.toHaveBeenCalled();
  });

  describe("a feed a guardian minted on a managed profile", () => {
    beforeEach(() => {
      db.cycleCalendarFeed.findFirst.mockResolvedValue({
        ...FEED_ROW,
        createdById: "manager",
      });
      db.user.findFirst.mockResolvedValue({
        id: "subject",
        timezone: "Europe/Berlin",
        locale: "en",
        managedProfileAt: new Date("2026-01-01"),
      });
    });

    const grant = (overrides: Record<string, unknown> = {}) => ({
      id: "g",
      access: "MANAGE",
      acceptedAt: new Date("2026-01-01"),
      revokedAt: null,
      expiresAt: null,
      scopeJson: null,
      ...overrides,
    });

    it("is served while the manager's MANAGE grant over cycle is live", async () => {
      gates.grant.mockResolvedValue(grant());
      expect((await fetchFeed()).status).toBe(200);
      expect(gates.grant).toHaveBeenCalledWith({
        grantorId: "subject",
        granteeId: "manager",
      });
    });

    it.each([
      ["no live grant", null],
      ["a WRITE grant", grant({ access: "WRITE" })],
      ["a READ grant", grant({ access: "READ" })],
      [
        "a grant scoped away from cycle",
        grant({ scopeJson: ["measurements"] }),
      ],
    ])("is a blunt 404 with %s", async (_label, row) => {
      gates.grant.mockResolvedValue(row);
      await expectBlunt404(await fetchFeed());
    });

    it("is a blunt 404 once the profile is an adult's account", async () => {
      // A live MANAGE grant is not enough: only a guardian of a managed
      // profile may hold a feed on somebody else's record.
      gates.grant.mockResolvedValue(grant());
      db.user.findFirst.mockResolvedValue({
        id: "subject",
        timezone: null,
        locale: null,
        managedProfileAt: null,
      });
      await expectBlunt404(await fetchFeed());
    });

    it("is a blunt 404 once the manager's account is gone", async () => {
      gates.grant.mockResolvedValue(grant());
      db.user.findFirst.mockImplementation(
        async (args: { where: { id: string } }) =>
          args.where.id === "manager"
            ? null
            : {
                id: "subject",
                timezone: null,
                locale: null,
                managedProfileAt: new Date("2026-01-01"),
              },
      );
      await expectBlunt404(await fetchFeed());
    });
  });

  it("moves the stamp and the hash only when the content moved", async () => {
    await fetchFeed();
    expect(db.cycleCalendarFeed.update).toHaveBeenCalledWith({
      where: { id: "feed-1" },
      data: expect.objectContaining({
        bodyHash: "new-hash",
        contentChangedAt: expect.any(Date),
        fetchCount: { increment: 1 },
      }),
    });

    vi.clearAllMocks();
    db.cycleCalendarFeed.findFirst.mockResolvedValue({
      ...FEED_ROW,
      bodyHash: "new-hash",
    });
    db.cycleCalendarFeed.update.mockResolvedValue({});
    const res = await fetchFeed();
    const data = db.cycleCalendarFeed.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("bodyHash");
    expect(data).not.toHaveProperty("contentChangedAt");
    expect(await res.text()).toContain("DTSTAMP:20261101T000000Z");
  });

  it("answers 304 to a matching If-None-Match and still counts the fetch", async () => {
    db.cycleCalendarFeed.findFirst.mockResolvedValue({
      ...FEED_ROW,
      bodyHash: "new-hash",
    });
    const res = await fetchFeed(undefined, { "if-none-match": '"new-hash"' });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"new-hash"');
    expect(await res.text()).toBe("");
    expect(db.cycleCalendarFeed.update).toHaveBeenCalled();
  });

  it("keeps the User-Agent short", async () => {
    await fetchFeed(undefined, {
      "user-agent": `Google-Calendar-Importer ${"x".repeat(200)}`,
    });
    const data = db.cycleCalendarFeed.update.mock.calls[0][0].data;
    expect(data.lastFetcherUa.length).toBe(80);
  });

  it("does not fail the fetch when the statistics write fails", async () => {
    db.cycleCalendarFeed.update.mockRejectedValue(new Error("db down"));
    expect((await fetchFeed()).status).toBe(200);
  });
});
