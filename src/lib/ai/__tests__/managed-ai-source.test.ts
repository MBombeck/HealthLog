/**
 * #1403 — a managed profile's AI provider source, end to end through the two
 * resolutions every gate and every call reads: the presence probe and the
 * chain resolution. The choice names the credential source only; a delegate
 * still gets nothing, a guardian who lost the profile serves nothing, and no
 * branch falls back to the operator's key behind the guardian's choice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/sharing/grant-access", () => ({
  findActiveGrant: vi.fn(),
}));

import type { AccountGrant, AppSettings } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { findActiveGrant } from "@/lib/sharing/grant-access";
import {
  withProviderWorkAuthority,
  type ProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";

import { probeProviderChain, resolveProviderChain } from "../provider";

const PROFILE = "profile-1";
const GUARDIAN = "guardian-1";

const SYSTEM: ProviderWorkAuthority = {
  origin: "system",
  recordUserId: PROFILE,
  actorUserId: null,
  grantId: null,
};

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    aiProvider: null,
    aiProviderChain: null,
    aiNamedChains: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiLocalBaseUrl: null,
    aiLocalModel: null,
    aiCompatBaseUrl: null,
    aiCompatKeyEncrypted: null,
    aiCompatModel: null,
    aiModel: null,
    role: "USER",
    codexConnectionStatus: null,
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
    useCentralCodex: false,
    managedProfileAt: null,
    labsLocalOcrEnabled: false,
    aiResponseTimeoutSeconds: null,
    ...overrides,
  };
}

/** The guardian has an Anthropic key, and a named chain holding it. */
const GUARDIAN_ROW = credentialRow({
  aiAnthropicKeyEncrypted: "guardian-key",
  aiModel: "claude-sonnet-4-6",
  aiProviderChain: [{ providerType: "anthropic", priority: 0, enabled: true }],
  aiNamedChains: {
    chains: [{ id: "family", name: "Family", entries: ["anthropic"] }],
  },
});

function setup(
  source: Record<string, unknown>,
  options: { grant?: boolean; adminKey?: boolean } = {},
) {
  const profileRow = credentialRow({
    managedProfileAt: new Date("2026-01-01T00:00:00Z"),
    ...source,
  });
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
    where: { id: string };
  }) =>
    args.where.id === GUARDIAN
      ? GUARDIAN_ROW
      : args.where.id === PROFILE
        ? profileRow
        : null) as unknown as typeof prisma.user.findUnique);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    adminAiKeyEncrypted: options.adminKey === false ? null : "operator-key",
    adminAiModel: "gpt-4o",
    adminAiBaseUrl: null,
  } as unknown as AppSettings);
  vi.mocked(findActiveGrant).mockResolvedValue(
    options.grant === false
      ? null
      : ({ id: "grant-1", access: "MANAGE" } as unknown as AccountGrant),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("managed profile provider source", () => {
  it("keeps the operator's key as the default source", async () => {
    setup({ managedAiSource: "INSTANCE" });
    const presence = await probeProviderChain(PROFILE, SYSTEM);
    expect(presence.entries.map((e) => e.providerType)).toEqual([
      "admin-openai",
    ]);
    const chain = await withProviderWorkAuthority(SYSTEM, () =>
      resolveProviderChain(PROFILE, null),
    );
    expect(chain.map((c) => c.providerType)).toEqual(["admin-openai"]);
  });

  it("serves the guardian's named chain with the guardian's key, pinned", async () => {
    setup({
      managedAiSource: "GUARDIAN",
      managedAiGuardianId: GUARDIAN,
      managedAiChainId: "family",
    });
    const presence = await probeProviderChain(PROFILE, SYSTEM);
    expect(presence.entries.map((e) => e.providerType)).toEqual(["anthropic"]);
    expect(presence.pinned?.documentAi?.map((e) => e.providerType)).toEqual([
      "anthropic",
    ]);
    // The guardian's in-browser OCR is never the profile's.
    expect(presence.localOcrEnabled).toBe(false);

    const chain = await withProviderWorkAuthority(SYSTEM, () =>
      resolveProviderChain(PROFILE, "briefing"),
    );
    expect(chain.map((c) => [c.providerType, c.pinned])).toEqual([
      ["anthropic", true],
    ]);
  });

  it("serves the guardian's default chain when no named chain is picked", async () => {
    setup({
      managedAiSource: "GUARDIAN",
      managedAiGuardianId: GUARDIAN,
      managedAiChainId: null,
    });
    const chain = await withProviderWorkAuthority(SYSTEM, () =>
      resolveProviderChain(PROFILE, null),
    );
    expect(chain.map((c) => c.providerType)).toEqual(["anthropic"]);
  });

  it("serves nothing, not the operator's key, once the guardian lost the profile", async () => {
    setup(
      {
        managedAiSource: "GUARDIAN",
        managedAiGuardianId: GUARDIAN,
        managedAiChainId: "family",
      },
      { grant: false },
    );
    const presence = await probeProviderChain(PROFILE, SYSTEM);
    expect(presence.entries).toEqual([]);
    const chain = await withProviderWorkAuthority(SYSTEM, () =>
      resolveProviderChain(PROFILE, null),
    );
    expect(chain).toEqual([]);
  });

  it("serves nothing when the named chain was deleted", async () => {
    setup({
      managedAiSource: "GUARDIAN",
      managedAiGuardianId: GUARDIAN,
      managedAiChainId: "gone",
    });
    expect((await probeProviderChain(PROFILE, SYSTEM)).entries).toEqual([]);
    const chain = await withProviderWorkAuthority(SYSTEM, () =>
      resolveProviderChain(PROFILE, null),
    );
    expect(chain).toEqual([]);
  });

  it("serves nothing under NONE even with an operator key", async () => {
    setup({ managedAiSource: "NONE" });
    expect((await probeProviderChain(PROFILE, SYSTEM)).entries).toEqual([]);
    const chain = await withProviderWorkAuthority(SYSTEM, () =>
      resolveProviderChain(PROFILE, null),
    );
    expect(chain).toEqual([]);
  });

  it("still gives a delegate nothing", async () => {
    setup({
      managedAiSource: "GUARDIAN",
      managedAiGuardianId: GUARDIAN,
      managedAiChainId: "family",
    });
    const presence = await probeProviderChain(PROFILE, {
      origin: "delegate",
      recordUserId: PROFILE,
      actorUserId: "someone",
      grantId: "grant-2",
    });
    expect(presence.entries).toEqual([]);
  });
});
