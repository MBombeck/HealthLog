/**
 * v1.16.6 — admin CRUD contract for the operator-wide AI key
 * (`/api/admin/ai-settings`). The endpoint predates its UI; the new
 * admin "AI server key" card now drives it, so the contract gets
 * pinned: admin-only access, encrypted storage, key removal, the
 * HTTPS + hostname allowlist on the base URL, and the masked
 * `keyPreview` in every response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    providerHealth: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    insightStatusCache: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `enc(${value})`),
  decrypt: vi.fn((value: string) => value.replace(/^enc\(|\)$/g, "")),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";
import { encrypt } from "@/lib/crypto";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";

const ADMIN_CTX = {
  authMethod: "cookie" as const,
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "admin-1",
    username: "admin",
    role: "ADMIN",
  } as never,
};

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/ai-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  } as never);
});

describe("GET /api/admin/ai-settings", () => {
  it("propagates the admin gate (non-admin cannot read)", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new HttpError(403, "Forbidden"));
    await expect(GET()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns defaults + hasKey=false when nothing is configured", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
    const res = await GET();
    const body = await res.json();
    expect(body.data).toEqual({
      hasKey: false,
      keyPreview: null,
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      legacyPrivateHostGrant: null,
    });
  });

  it("returns hasKey=true with a masked preview when a key is stored", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "enc(sk-test-12cd)",
      adminAiModel: "gpt-4o-mini",
      adminAiBaseUrl: "https://api.openai.com/v1",
    } as never);
    const res = await GET();
    const body = await res.json();
    expect(body.data.hasKey).toBe(true);
    expect(body.data.keyPreview).toBe("...12cd");
    expect(body.data.model).toBe("gpt-4o-mini");
    // The plaintext key never leaks into the envelope.
    expect(JSON.stringify(body)).not.toContain("sk-test-12cd");
  });
});

describe("PUT /api/admin/ai-settings", () => {
  function upsertEcho() {
    vi.mocked(prisma.appSettings.upsert).mockImplementation((async (args: {
      update: Record<string, unknown>;
    }) => ({
      adminAiKeyEncrypted: null,
      adminAiModel: "gpt-4o",
      adminAiBaseUrl: "https://api.openai.com/v1",
      ...args.update,
    })) as never);
  }

  it("propagates the admin gate (non-admin cannot write)", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new HttpError(403, "Forbidden"));
    await expect(PUT(jsonReq({ model: "gpt-4o" }))).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("encrypts and stores a new key, audit-logged", async () => {
    upsertEcho();
    const res = await PUT(jsonReq({ apiKey: "sk-new-key-89ab" }));
    const body = await res.json();

    expect(encrypt).toHaveBeenCalledWith("sk-new-key-89ab");
    expect(prisma.appSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { adminAiKeyEncrypted: "enc(sk-new-key-89ab)" },
      }),
    );
    expect(body.data.hasKey).toBe(true);
    expect(body.data.keyPreview).toBe("...89ab");
    expect(auditLog).toHaveBeenCalledWith(
      "admin.ai-settings.update",
      expect.objectContaining({ userId: "admin-1" }),
    );
    // The audit detail records THAT the key changed, never the key.
    const details = vi.mocked(auditLog).mock.calls[0][1] as {
      details: Record<string, unknown>;
    };
    expect(JSON.stringify(details)).not.toContain("sk-new-key-89ab");
  });

  it("clears the key when apiKey is empty", async () => {
    upsertEcho();
    const res = await PUT(jsonReq({ apiKey: "" }));
    const body = await res.json();

    expect(prisma.appSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { adminAiKeyEncrypted: null } }),
    );
    expect(body.data.hasKey).toBe(false);
    expect(body.data.keyPreview).toBeNull();
  });

  it("updates model and baseUrl for an allowlisted https host", async () => {
    upsertEcho();
    const res = await PUT(
      jsonReq({ model: "gpt-4o-mini", baseUrl: "https://openrouter.ai/v1" }),
    );
    const body = await res.json();
    expect(body.data.model).toBe("gpt-4o-mini");
    expect(body.data.baseUrl).toBe("https://openrouter.ai/v1");
  });

  it("rejects a plain-http base URL", async () => {
    await expect(
      PUT(jsonReq({ baseUrl: "http://api.openai.com/v1" })),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("rejects a base URL host outside the allowlist", async () => {
    await expect(
      PUT(jsonReq({ baseUrl: "https://attacker.example/v1" })),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  it("rejects an empty model", async () => {
    await expect(PUT(jsonReq({ model: "   " }))).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("rejects a body with no recognised fields", async () => {
    await expect(PUT(jsonReq({ unrelated: true }))).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("returns 429 when the admin surface is rate-limited", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    await expect(PUT(jsonReq({ model: "gpt-4o" }))).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  // #1279 — background work leaves a provider the health ledger benched out
  // of every account's chain. A fixed operator provider must not sit out a
  // pause the broken one earned, so a saved change forgets what the ledger
  // recorded for it on every account, and lets their notes try again.
  it("forgets the operator provider's recorded failures on every account", async () => {
    upsertEcho();
    await PUT(jsonReq({ model: "gpt-4o-mini" }));
    expect(prisma.providerHealth.deleteMany).toHaveBeenCalledWith({
      where: { providerType: "admin-openai" },
    });
    expect(prisma.insightStatusCache.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [{ retryAt: { not: null } }, { failureStreak: { gt: 0 } }],
      },
      data: { retryAt: null, negativeReason: null, failureStreak: 0 },
    });
  });

  it("forgets nothing when the change is refused", async () => {
    await expect(
      PUT(jsonReq({ baseUrl: "https://attacker.example/v1" })),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(prisma.providerHealth.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * v1.39.3 — while the deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` is set,
 * the page names it and lists the origins it is standing in for, so the
 * operator can copy them into `AI_PRIVATE_ORIGINS`.
 */
describe("GET /api/admin/ai-settings — deprecated private-host grant", () => {
  beforeEach(async () => {
    const { _resetAiGrantsForTests } =
      await import("@/lib/ai/local-host-allowlist");
    _resetAiGrantsForTests();
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX as never);
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: null,
      adminAiModel: null,
      adminAiBaseUrl: "http://gateway.lan:4000/v1",
    } as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { aiBaseUrl: "http://10.0.0.5:11434/v1", aiCompatBaseUrl: null },
      {
        aiBaseUrl: "http://10.0.0.5:11434/v1/",
        aiCompatBaseUrl: "https://openrouter.ai/api/v1",
      },
      { aiBaseUrl: "http://169.254.169.254/latest", aiCompatBaseUrl: null },
    ] as never);
    vi.stubEnv("AI_PRIVATE_ORIGINS", "");
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists the private origins in use, once each, when `true` is set", async () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    const res = await GET();
    const body = await res.json();
    expect(body.data.legacyPrivateHostGrant).toEqual({
      originsInUse: ["http://10.0.0.5:11434", "http://gateway.lan:4000"],
    });
  });

  it("is null when `true` is not set", async () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "ollama.lan");
    const res = await GET();
    expect((await res.json()).data.legacyPrivateHostGrant).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});
