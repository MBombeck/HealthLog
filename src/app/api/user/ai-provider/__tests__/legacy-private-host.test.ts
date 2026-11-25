/**
 * v1.39.3 — `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` is deprecated and narrowed,
 * not removed. Saving a private base URL under it is still accepted for the
 * operator's own configuration (an admin account) and refused for any other
 * account, which needs an exact origin in `AI_PRIVATE_ORIGINS`. Metadata and
 * link-local are refused for everyone. The real policy and the real public-host
 * check run here; only persistence is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The read-merge-write runs under the account's row lock; here the
// transaction client is the mocked one.
vi.mock("@/lib/user-row-lock", async () => {
  const { prisma } = await import("@/lib/db");
  return {
    withUserRowLock: (_userId: string, fn: (tx: unknown) => unknown) =>
      fn(prisma),
    lockUserRow: async () => {},
  };
});

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `dec:${v}`),
  encrypt: vi.fn((v: string) => `enc:${v}`),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderAvailability: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/server-provider-health", () => ({
  readServerProviderHealth: vi.fn(),
}));
vi.mock("@/lib/feature-flags", async () =>
  (
    await import("@/__tests__/helpers/assistant-switches-mock")
  ).mockAssistantSwitches(vi.fn()),
);
vi.mock("@/lib/sharing/provider-work-authority", () => ({
  providerWorkAuthorityForRecord: vi.fn(() => ({ origin: "owner" })),
  providerCredentialPolicy: vi.fn(() => "personal"),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  hasActiveConsentForSurface: vi.fn(),
}));

import { PATCH } from "../route";
import { prisma } from "@/lib/db";
import { _resetAiGrantsForTests } from "@/lib/ai/local-host-allowlist";

const patch = PATCH as (req: Request) => Promise<Response>;

function save(body: Record<string, string>) {
  return patch(
    new Request("http://localhost/api/user/ai-provider", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function asRole(role: "ADMIN" | "USER") {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({ role } as never);
}

beforeEach(() => {
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.user.update).mockReset();
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  _resetAiGrantsForTests();
  vi.stubEnv("AI_PRIVATE_ORIGINS", "");
  vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PATCH /api/user/ai-provider under ALLOW_LOCAL_AI_PRIVATE_HOSTS=true", () => {
  it.each([
    ["baseUrl", "http://10.0.0.5:11434/v1"],
    ["compatBaseUrl", "http://192.168.1.20:4000/v1"],
  ])("refuses a non-admin account's private %s", async (field, url) => {
    asRole("USER");
    const res = await save({ [field]: url });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("AI_PRIVATE_ORIGINS");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ["baseUrl", "http://10.0.0.5:11434/v1"],
    ["compatBaseUrl", "http://192.168.1.20:4000/v1"],
  ])("accepts an admin account's private %s", async (field, url) => {
    asRole("ADMIN");
    const res = await save({ [field]: url });
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://[fe80::1]:11434/v1",
    "http://0.0.0.0:11434/v1",
  ])("refuses %s even for an admin account", async (url) => {
    asRole("ADMIN");
    const res = await save({ baseUrl: url });
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("accepts a non-admin account's private URL once its exact origin is granted", async () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "http://10.0.0.5:11434");
    asRole("USER");
    const res = await save({ baseUrl: "http://10.0.0.5:11434/v1" });
    expect(res.status).toBe(200);
  });
});
