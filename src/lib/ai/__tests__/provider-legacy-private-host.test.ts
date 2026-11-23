/**
 * v1.39.3 — the deprecated `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` at dial time.
 *
 * Provider resolution decides whose configuration a base URL is, and the
 * client dials accordingly. Under `=true` a private endpoint is still reached
 * for the operator's own configurations (the instance-wide admin provider and
 * settings saved on an admin account), always through the pinned
 * operator-approved dispatcher; any other account's saved URL is pinned to
 * public hosts, so `safeFetch` refuses it. Checked at the wire: the options
 * each resolved provider hands to `safeFetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
}));
vi.mock("@/lib/ai/codex-oauth", () => ({
  refreshDeviceTokens: vi.fn(),
  encryptCodexCreds: vi.fn(),
  decryptCodexCreds: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => undefined),
}));

import {
  AITestConfigError,
  resolveProviderChain,
  resolveProviderForTest,
} from "../provider";
import { _resetAiGrantsForTests } from "../local-host-allowlist";
import { singleUserTurn } from "../types";
import { prisma } from "@/lib/db";

function row(role: "ADMIN" | "USER", overrides: Record<string, unknown>) {
  return {
    aiProvider: null,
    aiModel: "m",
    aiLocalBaseUrl: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiCompatBaseUrl: null,
    aiCompatKeyEncrypted: null,
    aiCompatModel: null,
    managedProfileAt: null,
    aiProviderChain: null,
    aiNamedChains: null,
    useCentralCodex: false,
    aiResponseTimeoutSeconds: null,
    role,
    ...overrides,
  } as never;
}

/** The one entry the chain resolves for the row, dialled once. */
async function dialOptions(): Promise<Record<string, unknown>> {
  const chain = await resolveProviderChain("u-1", null);
  expect(chain).toHaveLength(1);
  await chain[0].instance
    .generateCompletion(singleUserTurn({ system: "s", user: "u" }))
    .catch(() => undefined);
  return safeFetch.mock.calls[0][2] as Record<string, unknown>;
}

beforeEach(() => {
  _resetAiGrantsForTests();
  safeFetch.mockReset();
  safeFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
  );
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.appSettings.findUnique).mockReset();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.stubEnv("AI_PRIVATE_ORIGINS", "");
  vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ALLOW_LOCAL_AI_PRIVATE_HOSTS=true at dial time", () => {
  it.each([
    [
      "LOCAL",
      { aiProvider: "LOCAL", aiLocalBaseUrl: "http://10.0.0.5:11434/v1" },
    ],
    [
      "OPENAI_COMPATIBLE",
      {
        aiProvider: "OPENAI_COMPATIBLE",
        aiCompatBaseUrl: "http://10.0.0.5:4000/v1",
        aiCompatModel: "m",
      },
    ],
  ])(
    "an admin account's %s endpoint goes through the operator-approved pin",
    async (_label, overrides) => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        row("ADMIN", overrides),
      );
      const opts = await dialOptions();
      expect(opts.requirePublicHost).toBe(false);
      expect(opts.operatorApprovedPrivateOrigin).toMatch(
        /^http:\/\/10\.0\.0\.5:/,
      );
    },
  );

  it.each([
    [
      "LOCAL",
      { aiProvider: "LOCAL", aiLocalBaseUrl: "http://10.0.0.5:11434/v1" },
    ],
    [
      "OPENAI_COMPATIBLE",
      {
        aiProvider: "OPENAI_COMPATIBLE",
        aiCompatBaseUrl: "http://10.0.0.5:4000/v1",
        aiCompatModel: "m",
      },
    ],
  ])(
    "a non-admin account's %s endpoint stays on the public pin",
    async (_label, overrides) => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        row("USER", overrides),
      );
      const opts = await dialOptions();
      expect(opts.requirePublicHost).toBe(true);
      expect(opts).not.toHaveProperty("operatorApprovedPrivateOrigin");
    },
  );

  it("the metadata address stays on the public pin even for an admin account", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("ADMIN", {
        aiProvider: "LOCAL",
        aiLocalBaseUrl: "http://169.254.169.254/latest/v1",
      }),
    );
    const opts = await dialOptions();
    expect(opts.requirePublicHost).toBe(true);
  });

  it("the instance-wide admin provider is the operator's own", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("USER", { aiProvider: null }),
    );
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiKeyEncrypted: "k",
      adminAiModel: "m",
      adminAiBaseUrl: "http://10.0.0.7:8080/v1",
    } as never);
    const opts = await dialOptions();
    expect(opts).toMatchObject({
      requirePublicHost: false,
      operatorApprovedPrivateOrigin: "http://10.0.0.7:8080",
    });
  });
});

describe("the connection test under ALLOW_LOCAL_AI_PRIVATE_HOSTS=true", () => {
  it("refuses a non-admin account's private endpoint", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("USER", {
        aiProvider: "LOCAL",
        aiLocalBaseUrl: "http://10.0.0.5:11434/v1",
      }),
    );
    await expect(resolveProviderForTest("u-1")).rejects.toBeInstanceOf(
      AITestConfigError,
    );
  });

  it("resolves an admin account's private endpoint", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      row("ADMIN", {
        aiProvider: "LOCAL",
        aiLocalBaseUrl: "http://10.0.0.5:11434/v1",
      }),
    );
    await expect(
      resolveProviderForTest("u-1", { provider: "LOCAL" }),
    ).resolves.toBeDefined();
  });
});
