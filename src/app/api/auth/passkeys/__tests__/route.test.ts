/**
 * `GET /api/auth/passkeys` — the passkey management list.
 *
 * The management UI renders a "last used" column per credential, and a
 * passkey that reads "never used" is something a person acts on: they may
 * delete a working credential believing it is dead. So the field is part of
 * the route's contract, not an incidental select — dropping it from the
 * projection would silently turn every row into "never used" without any
 * type or lint failure.
 *
 * The write half (the stamp on a verified assertion) is pinned in
 * `src/lib/auth/__tests__/passkey.test.ts`.
 *
 * v1.35.1 adds the published half. The route was absent from
 * `docs/api/openapi.yaml` entirely — no path entry, no schema — while iOS
 * had been told to generate against one (iOS #60). The last case below
 * compares the projection the route actually asks Prisma for against the
 * property set the contract publishes, so the two cannot drift: a column
 * added to the select without a schema entry fails, and so does a schema
 * property the route never serves.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireSelfAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { passkey: { findMany: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { GET } from "../route";
import { requireSelfAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { buildOpenApiDocument } from "@/lib/openapi/registry";

const USER = { id: "user-1", username: "u", email: "u@example.com" };

const ROW = {
  id: "pk-1",
  name: "Phone",
  credentialDeviceType: "multiDevice",
  credentialBackedUp: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  lastUsedAt: new Date("2026-07-01T10:00:00Z"),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireSelfAuth).mockResolvedValue({ user: USER } as never);
  vi.mocked(prisma.passkey.findMany).mockResolvedValue([ROW] as never);
});

describe("GET /api/auth/passkeys", () => {
  it("selects lastUsedAt, scoped to the calling user", async () => {
    await (GET as unknown as () => Promise<Response>)();

    expect(prisma.passkey.findMany).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.passkey.findMany).mock.calls[0][0];

    expect(args?.where).toEqual({ userId: USER.id });
    expect(args?.select).toMatchObject({ lastUsedAt: true });
  });

  it("emits lastUsedAt in the response envelope", async () => {
    const res = await (GET as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(body.error).toBeNull();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toHaveProperty("lastUsedAt");
    expect(new Date(body.data[0].lastUsedAt).toISOString()).toBe(
      "2026-07-01T10:00:00.000Z",
    );
  });

  it("passes a never-used credential through as null, not as a missing key", async () => {
    vi.mocked(prisma.passkey.findMany).mockResolvedValue([
      { ...ROW, lastUsedAt: null },
    ] as never);

    const res = await (GET as unknown as () => Promise<Response>)();
    const body = await res.json();

    expect(Object.keys(body.data[0])).toContain("lastUsedAt");
    expect(body.data[0].lastUsedAt).toBeNull();
  });

  it("publishes exactly the columns it selects", async () => {
    await (GET as unknown as () => Promise<Response>)();
    const args = vi.mocked(prisma.passkey.findMany).mock.calls[0][0];
    const selected = Object.keys(args?.select ?? {}).sort();

    const doc = buildOpenApiDocument() as {
      paths?: Record<string, { get?: { responses?: Record<string, unknown> } }>;
      components?: {
        schemas?: Record<string, { properties?: Record<string, unknown> }>;
      };
    };

    expect(
      doc.paths?.["/api/auth/passkeys"]?.get,
      "GET /api/auth/passkeys is not registered in the OpenAPI document",
    ).toBeDefined();

    const published = doc.components?.schemas?.["PasskeyInfo"]?.properties;
    expect(published, "PasskeyInfo schema is not emitted").toBeDefined();

    expect(Object.keys(published ?? {}).sort()).toEqual(selected);
  });
});

describe("primary-passkey enrollment route guards", () => {
  const optionsSource = readFileSync(
    resolve(__dirname, "../../passkey/register-options/route.ts"),
    "utf8",
  );
  const verifySource = readFileSync(
    resolve(__dirname, "../../passkey/register-verify/route.ts"),
    "utf8",
  );

  it("keeps both registration legs cookie-only", () => {
    for (const source of [optionsSource, verifySource]) {
      expect(source).toContain("requireCookieAuth");
      expect(source).not.toMatch(/\brequire(?:Self)?Auth\b/);
      expect(source).not.toContain("requireMfaManagementAuth");
      expect(source).not.toContain("requireBearerAuth");
    }
  });

  it("requires existing-factor proof before options and repeats freshness on verify", () => {
    expect(optionsSource).toMatch(
      /password|totp|webauthn|passkey-registration/,
    );
    expect(optionsSource).toMatch(/session\.id/);
    expect(verifySource).toMatch(/session\.id/);
    expect(verifySource).toMatch(/fresh|reauth|proof/i);
  });
});
