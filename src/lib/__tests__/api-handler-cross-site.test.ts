import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { NextRequest } from "next/server";
import { apiHandler } from "@/lib/api-handler";
import { safeJson } from "@/lib/api-response";

/**
 * A page on a sibling subdomain shares the session cookie's site, so a Lax
 * cookie rides its POSTs. It could send a CORS-simple request, a body typed
 * `text/plain; x=application/json`, and the server took it for JSON from the
 * signed-in person. `apiHandler` now refuses a state change a browser sent
 * from another origin, and `safeJson` compares the media type exactly.
 */

const handler = vi.fn(async (request: NextRequest) => {
  const { data, error } = await safeJson<{ value: number }>(request);
  if (error) return error;
  return Response.json({ data, error: null });
});
const route = apiHandler(handler);

const ORIGIN = "https://health.example.com";

function post(headers: Record<string, string>, body = '{"value":1}') {
  return route(
    new NextRequest(`${ORIGIN}/api/measurements`, {
      method: "POST",
      headers: { host: "health.example.com", ...headers },
      body,
    }),
  );
}

afterEach(() => {
  handler.mockClear();
});

describe("apiHandler and a state change from another site", () => {
  it("refuses the forged text/plain POST from a sibling subdomain", async () => {
    const response = await post({
      "content-type": "text/plain; x=application/json",
      "sec-fetch-site": "same-site",
      origin: "https://evil.example.com",
      cookie: "healthlog_session=s",
    });
    expect(response.status).toBe(403);
    expect((await response.json()).meta?.errorCode).toBe("request.cross_site");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a cross-site Origin from a browser that sends no Sec-Fetch-Site", async () => {
    const response = await post({
      "content-type": "application/json",
      origin: "https://evil.example.org",
    });
    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an opaque origin", async () => {
    const response = await post({
      "content-type": "application/json",
      origin: "null",
    });
    expect(response.status).toBe(403);
  });

  it("accepts the app's own page", async () => {
    const response = await post({
      "content-type": "application/json; charset=utf-8",
      "sec-fetch-site": "same-origin",
      origin: ORIGIN,
    });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("accepts an Origin naming the host the request went to, without Sec-Fetch-Site", async () => {
    const response = await post({
      "content-type": "application/json",
      origin: ORIGIN,
    });
    expect(response.status).toBe(200);
  });

  it("accepts a Bearer client and a client that is not a browser page", async () => {
    expect(
      (
        await post({
          "content-type": "application/json",
          authorization: "Bearer hlk_x",
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(200);
    expect((await post({ "content-type": "application/json" })).status).toBe(
      200,
    );
  });

  it("refuses a browser-attached Basic or Negotiate header riding a session cookie", async () => {
    // The browser adds these on its own once a proxy or the host asked for
    // them, and the caller is resolved from the cookie first: the header is
    // not what the request is authenticated by.
    for (const authorization of ["Basic dXNlcjpwYXNz", "Negotiate YIIGhg"]) {
      const response = await post({
        "content-type": "application/json",
        authorization,
        "sec-fetch-site": "same-site",
        origin: "https://evil.example.com",
        cookie: "healthlog_session=s",
      });
      expect(response.status).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks a Bearer request that also carries a session cookie as the cookie request it resolves to", async () => {
    for (const cookie of [
      "healthlog_session=s",
      "theme=dark; __Host-healthlog_session=s",
    ]) {
      const response = await post({
        "content-type": "application/json",
        authorization: "Bearer hlk_x",
        "sec-fetch-site": "cross-site",
        cookie,
      });
      expect(response.status).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
    // From the app's own page the same pair passes.
    const own = await post({
      "content-type": "application/json",
      authorization: "Bearer hlk_x",
      "sec-fetch-site": "same-origin",
      cookie: "healthlog_session=s",
    });
    expect(own.status).toBe(200);
  });

  it("lets the share-link passphrase POST through from a no-referrer page", async () => {
    // The shared view is served with `Referrer-Policy: no-referrer`; a
    // browser without Sec-Fetch-Site then sends `Origin: null`. The token in
    // the path and the passphrase in the body are the credential.
    const response = await route(
      new NextRequest(`${ORIGIN}/api/c/hls_token/unlock`, {
        method: "POST",
        headers: {
          host: "health.example.com",
          "content-type": "application/json",
          origin: "null",
        },
        body: '{"value":1}',
      }),
    );
    expect(response.status).toBe(200);
  });

  it("leaves reads alone", async () => {
    const response = await route(
      new NextRequest(`${ORIGIN}/api/measurements`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );
    expect(response.status).not.toBe(403);
  });
});

describe("safeJson's media type", () => {
  it("refuses a type that only mentions JSON in a parameter", async () => {
    const response = await post({
      "content-type": "text/plain; x=application/json",
    });
    expect(response.status).toBe(415);
  });

  it("accepts JSON in any case, with parameters", async () => {
    expect(
      (await post({ "content-type": "Application/JSON; charset=UTF-8" }))
        .status,
    ).toBe(200);
  });
});
