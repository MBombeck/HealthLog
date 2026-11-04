import { afterEach, describe, expect, it } from "vitest";

import {
  chunkGarminRange,
  clearGarminTokenCache,
  exchangeGarminKey,
  extractGarminToken,
  GarminApiError,
  GarminSession,
  garminTokenExpiry,
  GARMIN_TOKEN_PATH,
  isGarminKeyRefusal,
  isGarminRateLimit,
} from "../client";

const NOW = Date.parse("2026-11-04T08:00:00Z");
const HOUR = 60 * 60 * 1000;

/** A made-up unsigned JWT with the given `exp` (and `iat`), epoch seconds. */
function jwt(expSeconds: number, nonce = "a", iatSeconds?: number): string {
  const enc = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims =
    iatSeconds === undefined
      ? { exp: expSeconds, n: nonce }
      : { exp: expSeconds, iat: iatSeconds, n: nonce };
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

interface Call {
  url: string;
  auth: string | null;
}

/** A scripted Garmin: each request takes the next answer for its path kind. */
function fakeGarmin(script: {
  token?: Array<() => Response>;
  data?: Array<() => Response>;
}) {
  const calls: Call[] = [];
  const tokens = [...(script.token ?? [])];
  const data = [...(script.data ?? [])];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = url.toString();
    const headers = new Headers(init?.headers);
    calls.push({ url: u, auth: headers.get("authorization") });
    const next = u.includes(GARMIN_TOKEN_PATH) ? tokens.shift() : data.shift();
    if (!next) throw new Error(`unexpected request ${u}`);
    return next();
  }) as unknown as typeof import("@/lib/safe-fetch").safeFetch;
  return { fetch, calls };
}

const tokenResponse = (value: string) => () =>
  new Response(value, { status: 200 });
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

afterEach(() => clearGarminTokenCache());

describe("extractGarminToken", () => {
  it("reads a bare token, a quoted one and a JSON wrapper", () => {
    expect(extractGarminToken("  abc.def.ghi\n")).toBe("abc.def.ghi");
    expect(extractGarminToken('"abc.def.ghi"')).toBe("abc.def.ghi");
    expect(extractGarminToken('{"access_token":"abc.def.ghi"}')).toBe(
      "abc.def.ghi",
    );
    expect(extractGarminToken("{not json")).toBe("");
  });
});

describe("garminTokenExpiry", () => {
  it("reads exp in ms and ignores tokens without one", () => {
    expect(garminTokenExpiry(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(garminTokenExpiry("opaque")).toBeUndefined();
  });
});

describe("exchangeGarminKey", () => {
  it("sends the key as ApiKey and returns a token with its refresh point", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({ token: [tokenResponse(jwt(exp))] });
    const token = await exchangeGarminKey("k".repeat(20), "global", {
      fetch: g.fetch,
      now: () => NOW,
    });
    expect(g.calls[0]!.auth).toBe(`ApiKey ${"k".repeat(20)}`);
    expect(g.calls[0]!.url).toBe(
      `https://personal.connectapi.garmin.com${GARMIN_TOKEN_PATH}`,
    );
    expect(token.expiresAt).toBe(exp * 1000);
    // An hour before expiry for a regular day-long token.
    expect(token.refreshAt).toBe(exp * 1000 - HOUR);
    // A regular token says nothing about the key's end.
    expect(token.keyExpiresAt).toBeNull();
  });

  it("learns the key's end from a token capped short of a day", async () => {
    const exp = Math.floor((NOW + 5 * HOUR) / 1000);
    const g = fakeGarmin({ token: [tokenResponse(jwt(exp))] });
    const token = await exchangeGarminKey("k".repeat(20), "global", {
      fetch: g.fetch,
      now: () => NOW,
    });
    expect(token.keyExpiresAt).toBe(exp * 1000);
  });

  it("reads the token's lifetime from its own claims, not the local clock", async () => {
    // A regular day-long token, read by a clock 20 hours ahead of Garmin's:
    // exp minus now says four hours, exp minus iat says a full day.
    const iat = Math.floor((NOW - 20 * HOUR) / 1000);
    const exp = iat + 24 * 3600;
    const g = fakeGarmin({ token: [tokenResponse(jwt(exp, "a", iat))] });
    const token = await exchangeGarminKey("k".repeat(20), "global", {
      fetch: g.fetch,
      now: () => NOW,
    });
    expect(token.keyExpiresAt).toBeNull();
    // A token Garmin cut short at the key's end, with its own iat.
    const iat2 = Math.floor(NOW / 1000);
    const g2 = fakeGarmin({
      token: [tokenResponse(jwt(iat2 + 3 * 3600, "b", iat2))],
    });
    const capped = await exchangeGarminKey("k".repeat(20), "global", {
      fetch: g2.fetch,
      now: () => NOW,
    });
    expect(capped.keyExpiresAt).toBe((iat2 + 3 * 3600) * 1000);
  });

  it.each([401, 403, 404])(
    "treats %s at the exchange as a refused key",
    async (status) => {
      const g = fakeGarmin({
        token: [() => new Response("", { status })],
      });
      const err = await exchangeGarminKey("k".repeat(20), "china", {
        fetch: g.fetch,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(GarminApiError);
      expect(isGarminKeyRefusal(err)).toBe(true);
      expect(err.classification).toBe("reauth_required");
      expect(g.calls[0]!.url).toContain("connectapi.garmin.cn");
    },
  );

  it("carries Retry-After on a rate-limited exchange", async () => {
    const g = fakeGarmin({
      token: [
        () =>
          new Response("", { status: 429, headers: { "retry-after": "120" } }),
      ],
    });
    const err = await exchangeGarminKey("k".repeat(20), "global", {
      fetch: g.fetch,
    }).catch((e) => e);
    expect(isGarminRateLimit(err)).toBe(true);
    expect(err.retryAfterMs).toBe(120_000);
    expect(isGarminKeyRefusal(err)).toBe(false);
  });

  it("refuses a 200 that is not a token, without echoing the body", async () => {
    const g = fakeGarmin({
      token: [() => new Response("<html>maintenance</html>", { status: 200 })],
    });
    const err = await exchangeGarminKey("k".repeat(20), "global", {
      fetch: g.fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(GarminApiError);
    expect(err.reason).toBe("token_not_jwt");
    expect(String(err.message)).not.toContain("maintenance");
  });
});

describe("GarminSession", () => {
  const key = "secret-key-0123456789";

  function session(fetch: ReturnType<typeof fakeGarmin>["fetch"], now = NOW) {
    return new GarminSession({
      userId: "u1",
      apiKey: key,
      region: "global",
      transport: { fetch, now: () => now },
    });
  }

  it("caches the token across calls and sessions", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp))],
      data: [json({ a: 1 }), json({ a: 2 })],
    });
    expect(await session(g.fetch).get("x", "/p")).toEqual({ a: 1 });
    expect(await session(g.fetch).get("x", "/p")).toEqual({ a: 2 });
    const exchanges = g.calls.filter((c) => c.url.includes(GARMIN_TOKEN_PATH));
    expect(exchanges).toHaveLength(1);
    expect(g.calls[1]!.auth).toBe(`Bearer ${jwt(exp)}`);
  });

  it("buys a new token once the cached one is near its end", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp, "a")), tokenResponse(jwt(exp + 10, "b"))],
      data: [json({}), json({})],
    });
    await session(g.fetch).get("x", "/p");
    await session(g.fetch, NOW + 23.5 * HOUR).get("x", "/p");
    expect(
      g.calls.filter((c) => c.url.includes(GARMIN_TOKEN_PATH)),
    ).toHaveLength(2);
  });

  it("does not reuse another key's token", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp, "a")), tokenResponse(jwt(exp, "b"))],
      data: [json({}), json({})],
    });
    await session(g.fetch).get("x", "/p");
    await new GarminSession({
      userId: "u1",
      apiKey: "another-key-0123456789",
      region: "global",
      transport: { fetch: g.fetch, now: () => NOW },
    }).get("x", "/p");
    expect(
      g.calls.filter((c) => c.url.includes(GARMIN_TOKEN_PATH)),
    ).toHaveLength(2);
  });

  it("re-exchanges once on a 401 and retries", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp, "a")), tokenResponse(jwt(exp, "b"))],
      data: [() => new Response("", { status: 401 }), json({ ok: true })],
    });
    const s = session(g.fetch);
    expect(await s.get("x", "/p")).toEqual({ ok: true });
    expect(s.exchanges).toBe(2);
    expect(s.proven).toBe(true);
    expect(g.calls.at(-1)!.auth).toBe(`Bearer ${jwt(exp, "b")}`);
  });

  it("treats a second 401 as the key's end and stops", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp, "a")), tokenResponse(jwt(exp, "b"))],
      data: [
        () => new Response("", { status: 401 }),
        () => new Response("", { status: 401 }),
      ],
    });
    const err = await session(g.fetch)
      .get("x", "/p")
      .catch((e) => e);
    expect(isGarminKeyRefusal(err)).toBe(true);
    // Exactly one retry: two data calls, two exchanges, nothing more.
    expect(g.calls).toHaveLength(4);
  });

  it("surfaces a 429 with its wait and does not retry", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp))],
      data: [
        () =>
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
      ],
    });
    const err = (await session(g.fetch)
      .get("x", "/p")
      .catch((e) => e)) as GarminApiError;
    expect(isGarminRateLimit(err)).toBe(true);
    expect(err.retryAfterMs).toBe(30_000);
    expect(g.calls).toHaveLength(2);
  });

  it("answers null for 204 and an empty body", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp))],
      data: [
        () => new Response(null, { status: 204 }),
        () => new Response("", { status: 200 }),
      ],
    });
    const s = session(g.fetch);
    expect(await s.get("x", "/p")).toBeNull();
    expect(await s.get("x", "/p")).toBeNull();
  });

  it("puts the query on the URL and drops empty values", async () => {
    const exp = Math.floor((NOW + 24 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp))],
      data: [json([])],
    });
    await session(g.fetch).get("x", "/p", {
      startDate: "2026-10-01",
      none: undefined,
      flag: true,
    });
    expect(g.calls[1]!.url).toBe(
      "https://personal.connectapi.garmin.com/p?startDate=2026-10-01&flag=true",
    );
  });

  it("remembers the key's end when a token reveals it", async () => {
    const exp = Math.floor((NOW + 3 * HOUR) / 1000);
    const g = fakeGarmin({
      token: [tokenResponse(jwt(exp))],
      data: [json({})],
    });
    const s = session(g.fetch);
    await s.get("x", "/p");
    expect(s.learnedKeyExpiresAt).toBe(exp * 1000);
  });
});

describe("chunkGarminRange", () => {
  it("splits newest first into windows of at most maxDays, both ends counted", () => {
    expect(chunkGarminRange("2026-01-01", "2026-03-01", 28)).toEqual([
      { startDate: "2026-02-02", endDate: "2026-03-01" },
      { startDate: "2026-01-05", endDate: "2026-02-01" },
      { startDate: "2026-01-01", endDate: "2026-01-04" },
    ]);
  });

  it("keeps a year of daily summaries in one 365-day request", () => {
    const chunks = chunkGarminRange("2025-11-05", "2026-11-04", 365);
    expect(chunks).toEqual([
      { startDate: "2025-11-05", endDate: "2026-11-04" },
    ]);
  });

  it("returns one single-day window and nothing for an inverted range", () => {
    expect(chunkGarminRange("2026-05-05", "2026-05-05", 31)).toEqual([
      { startDate: "2026-05-05", endDate: "2026-05-05" },
    ]);
    expect(chunkGarminRange("2026-05-06", "2026-05-05", 31)).toEqual([]);
  });
});
