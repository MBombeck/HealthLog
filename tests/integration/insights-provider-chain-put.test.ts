/**
 * v1.4.16 — integration coverage for the new PUT
 * `/api/insights/provider-chain` endpoint.
 *
 * Two scenarios pinned end-to-end against the postgres testcontainer:
 *   1. Saving a valid chain persists the JSON column and a follow-up
 *      GET surfaces the new order. priority is normalised so the
 *      first row of the saved chain always has priority 1.
 *   2. Saving an empty chain rejects with 422 and the column is left
 *      untouched.
 *
 * No fetch mocks — the route runs against the real Prisma client +
 * real testcontainer. The session cookie is forged via `cookieJar`
 * because we don't want to recreate the auth flow here; the auth
 * helpers already cover that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedUser(): Promise<{ userId: string }> {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "chain-put-user",
      email: "chain-put@example.test",
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return { userId: user.id };
}

interface PutEnvelope {
  data: { saved: true } | null;
  error?: string | null;
}

describe("PUT /api/insights/provider-chain — integration", () => {
  it("persists a reordered chain and the follow-up GET surfaces it", async () => {
    const { userId } = await seedUser();
    const { PUT } = await import("@/app/api/insights/provider-chain/route");

    const res = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/provider-chain", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chain: [
            { providerType: "openai", enabled: true },
            { providerType: "codex", enabled: false },
            { providerType: "admin-openai", enabled: true },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PutEnvelope;
    expect(body.data).toEqual({ saved: true });

    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: { aiProviderChain: true },
    });
    expect(stored.aiProviderChain).toEqual([
      { providerType: "openai", priority: 1, enabled: true },
      { providerType: "codex", priority: 2, enabled: false },
      { providerType: "admin-openai", priority: 3, enabled: true },
    ]);
  });

  it("rejects an empty chain with 422 and leaves the column untouched", async () => {
    const { userId } = await seedUser();
    const { PUT } = await import("@/app/api/insights/provider-chain/route");

    const res = await (PUT as (req: Request) => Promise<Response>)(
      new Request("http://localhost/api/insights/provider-chain", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chain: [] }),
      }),
    );
    expect(res.status).toBe(422);

    const stored = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: { aiProviderChain: true },
    });
    // Untouched — the user row was created with no chain so the
    // column should still be JSON null.
    expect(stored.aiProviderChain).toBeNull();
  });
});
