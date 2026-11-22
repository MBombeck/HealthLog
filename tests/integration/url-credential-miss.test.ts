/**
 * Every URL-credential route, called against a real database, answers a dead
 * link with its one miss status, and for a page or a record that is a 404.
 *
 * The list of surfaces is `src/__tests__/helpers/url-credential-surfaces.ts`,
 * which the unit guard holds to the tree (and whose pages it checks through
 * the proxy). Here each route is called with a well-formed token nobody holds
 * and with a malformed one; the clinician share link and the emergency card,
 * the two pages a stranger opens, are also called with a revoked and an
 * expired link, and every one of those answers must be the same bytes.
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_ROUTES } from "@/__tests__/helpers/url-credential-surfaces";
import { hashToken } from "@/lib/auth/hmac";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-url-credential-miss-integration-32-bytes-min-12345";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.WITHINGS_WEBHOOK_SECRET ??= "a-configured-withings-path-secret";

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

type Handler = (
  request: NextRequest,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const db = () => getPrismaClient();

async function call(file: string, token: string) {
  const route = CREDENTIAL_ROUTES[file];
  const mod = (await import(`@/app/${file.replace(/\.ts$/, "")}`)) as Record<
    string,
    unknown
  >;
  const GET = mod.GET as Handler;
  const path = `/${file.replace(/\/route\.ts$/, "").replace(/\[token\]/, token)}`;
  return GET(new NextRequest(`http://localhost${path}`), {
    params: Promise.resolve({ token, ...(route.params ?? {}) }),
  });
}

/** What a miss says, without the per-request id an envelope may carry. */
async function missShape(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("json")) return text;
  const body = JSON.parse(text) as {
    error?: unknown;
    status?: unknown;
    meta?: { errorCode?: unknown };
  };
  return [body.error, body.status, body.meta?.errorCode];
}

beforeEach(async () => {
  await truncateAllTables(db());
  cookieJar.clear();
  headerJar.clear();
});

const probed = Object.entries(CREDENTIAL_ROUTES).filter(
  ([, route]) => route.method === "GET",
);

describe("URL-credential routes answer a dead link with one status", () => {
  it("probes the routes (the list is not empty)", () => {
    expect(probed.length).toBeGreaterThanOrEqual(8);
  });

  it.each(probed)(
    "%s answers an unknown and a malformed token alike",
    async (file, route) => {
      const unknown = await call(file, route.unknownToken ?? "probe");
      const malformed = await call(file, "nope");
      expect(unknown.status).toBe(route.missStatus);
      expect(malformed.status).toBe(route.missStatus);
      expect(await missShape(unknown)).toEqual(await missShape(malformed));
    },
  );
});

async function owner() {
  return db().user.create({
    data: {
      username: `miss-${randomBytes(4).toString("hex")}`,
      email: `miss-${randomBytes(4).toString("hex")}@example.test`,
      role: "USER",
      timezone: "Europe/Berlin",
      locale: "en",
    },
  });
}

describe("the two pages a stranger opens: one 404 for every dead link", () => {
  it("/c/<token>: unknown, revoked and expired answer the same 404; a live link goes on to the view", async () => {
    const user = await owner();
    const make = async (patch: { revokedAt?: Date; expiresAt?: Date }) => {
      const raw = `hls_${randomBytes(24).toString("hex")}`;
      await db().clinicianShareLink.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(raw),
          label: "Practice",
          rangeStart: new Date("2026-01-01T00:00:00Z"),
          sectionsJson: {},
          expiresAt:
            patch.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          revokedAt: patch.revokedAt ?? null,
        },
      });
      return raw;
    };
    const file = "c/[token]/route.ts";
    const unknown = await call(file, `hls_${"0".repeat(48)}`);
    const revoked = await call(file, await make({ revokedAt: new Date() }));
    const expired = await call(
      file,
      await make({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const body = await unknown.text();
    for (const res of [unknown, revoked, expired]) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toContain("no-store");
    }
    expect(await revoked.text()).toBe(body);
    expect(await expired.text()).toBe(body);
    expect(body).not.toMatch(/<script|href=/i);

    const live = await make({});
    const ok = await call(file, live);
    expect(ok.status).toBe(307);
    expect(ok.headers.get("location")).toBe(`/c/${live}/view`);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hls_view=1");
    expect(cookie).toContain(`Path=/c/${live}/view`);
    expect(cookie).toMatch(/HttpOnly/i);
  });

  it("/e/<token>: unknown, revoked and expired answer the same 404", async () => {
    const user = await owner();
    const make = async (patch: { revokedAt?: Date; expiresAt?: Date }) => {
      const raw = `hlm_${randomBytes(24).toString("hex")}`;
      await db().emergencyCardLink.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(raw),
          tokenPrefix: raw.slice(0, 8),
          fields: ["BLOOD_TYPE"],
          expiresAt: patch.expiresAt ?? null,
          revokedAt: patch.revokedAt ?? null,
        },
      });
      return raw;
    };
    const file = "e/[token]/route.ts";
    const unknown = await call(file, `hlm_${"0".repeat(48)}`);
    const revoked = await call(file, await make({ revokedAt: new Date() }));
    const expired = await call(
      file,
      await make({ expiresAt: new Date(Date.now() - 1000) }),
    );
    const body = await unknown.text();
    for (const res of [unknown, revoked, expired]) {
      expect(res.status).toBe(404);
    }
    expect(await revoked.text()).toBe(body);
    expect(await expired.text()).toBe(body);
  });
});
