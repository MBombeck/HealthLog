/**
 * Removing one saved AI key, against a real account row.
 *
 * The settings forms send `{ <provider>Key: null }` to `PATCH
 * /api/user/ai-provider` to take a stored key back. This pins the route's
 * half of that against Postgres: the one ciphertext column is cleared, the
 * other keys, the provider choice and the model are left as they were, and
 * the read the form seeds from reports the key gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

async function seedAccountWithKeys(): Promise<string> {
  const prisma = getPrismaClient();
  const { encrypt } = await import("@/lib/crypto");
  const user = await prisma.user.create({
    data: {
      username: "ai-key-removal",
      email: "ai-key-removal@example.test",
      aiProvider: "OPENAI",
      aiModel: "gpt-4o-mini",
      aiOpenaiKeyEncrypted: encrypt("sk-test-openai-0001"),
      aiAnthropicKeyEncrypted: encrypt("sk-ant-test-0002"),
      aiLocalKeyEncrypted: encrypt("local-test-0003"),
      aiCompatKeyEncrypted: encrypt("compat-test-0004"),
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user.id;
}

async function patch(body: unknown): Promise<Response> {
  const { PATCH } = await import("@/app/api/user/ai-provider/route");
  return PATCH(
    new NextRequest("http://localhost/api/user/ai-provider", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function readProvider(): Promise<Record<string, unknown>> {
  const { GET } = await import("@/app/api/user/ai-provider/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

describe("PATCH /api/user/ai-provider — removing one saved key", () => {
  it("clears that key's column and leaves every other setting", async () => {
    const userId = await seedAccountWithKeys();

    const res = await patch({ openaiKey: null });
    expect(res.status).toBe(200);

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        aiProvider: true,
        aiModel: true,
        aiOpenaiKeyEncrypted: true,
        aiAnthropicKeyEncrypted: true,
        aiLocalKeyEncrypted: true,
        aiCompatKeyEncrypted: true,
      },
    });
    expect(row.aiOpenaiKeyEncrypted).toBeNull();
    expect(row.aiAnthropicKeyEncrypted).not.toBeNull();
    expect(row.aiLocalKeyEncrypted).not.toBeNull();
    expect(row.aiCompatKeyEncrypted).not.toBeNull();
    expect(row.aiProvider).toBe("OPENAI");
    expect(row.aiModel).toBe("gpt-4o-mini");
    // The removal is audited, naming the slot and no value.
    const audits = await getPrismaClient().auditLog.findMany({
      where: { userId, action: { startsWith: "user.ai-provider.key." } },
      select: { action: true, details: true },
    });
    expect(audits).toEqual([
      {
        action: "user.ai-provider.key.remove",
        details: JSON.stringify({ slot: "openai" }),
      },
    ]);
  });

  it("the read the form seeds from reports the key gone", async () => {
    await seedAccountWithKeys();
    expect(await readProvider()).toMatchObject({
      hasOpenaiKey: true,
      hasAnthropicKey: true,
    });

    await patch({ anthropicKey: null });

    expect(await readProvider()).toMatchObject({
      hasOpenaiKey: true,
      hasAnthropicKey: false,
      anthropicKeyPreview: null,
      hasLocalKey: true,
      hasCompatKey: true,
    });
  });

  for (const field of ["localKey", "compatKey"] as const) {
    it(`clears ${field} on its own`, async () => {
      await seedAccountWithKeys();
      await patch({ [field]: null });
      const data = await readProvider();
      expect(data[field === "localKey" ? "hasLocalKey" : "hasCompatKey"]).toBe(
        false,
      );
      expect(data.hasOpenaiKey).toBe(true);
    });
  }
});
