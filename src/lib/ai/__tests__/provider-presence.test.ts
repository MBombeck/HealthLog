/**
 * The one provider-presence definition (`probeProviderChain` /
 * `probeProviderPresence`): what it counts, in which order, and what it never
 * does (decrypt, build a client, refresh a token).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => {
    throw new Error("the presence probe must never decrypt");
  }),
  encrypt: vi.fn(),
}));

import { prisma } from "@/lib/db";
import type { ProviderWorkAuthority } from "@/lib/sharing/provider-work-authority";

import {
  hasAnyConfiguredProvider,
  probeProviderChain,
  probeProviderPresence,
  resolveProviderAvailability,
} from "../provider";

const OWNER: ProviderWorkAuthority = {
  origin: "owner",
  recordUserId: "u1",
  actorUserId: "u1",
  grantId: null,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    aiProvider: null,
    aiProviderChain: null,
    aiAnthropicKeyEncrypted: null,
    aiLocalKeyEncrypted: null,
    aiOpenaiKeyEncrypted: null,
    aiBaseUrl: null,
    aiCompatBaseUrl: null,
    aiCompatModel: null,
    aiModel: null,
    codexConnectionStatus: null,
    codexAccessTokenEncrypted: null,
    codexRefreshTokenEncrypted: null,
    useCentralCodex: false,
    managedProfileAt: null,
    labsLocalOcrEnabled: false,
    ...overrides,
  };
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    adminAiKeyEncrypted: null,
    adminAiModel: null,
    adminCodexConnectionStatus: null,
    adminCodexAccessTokenEncrypted: null,
    adminCodexRefreshTokenEncrypted: null,
    adminCodexAccountIdEncrypted: null,
    ...overrides,
  };
}

function load(user: unknown, app: unknown = settings()) {
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(app as never);
}

beforeEach(() => {
  vi.mocked(prisma.user.findUnique).mockReset();
  vi.mocked(prisma.appSettings.findUnique).mockReset();
});

describe("probeProviderChain", () => {
  it("reads nothing for a delegate, and finds nothing", async () => {
    const presence = await probeProviderChain("u1", {
      origin: "delegate",
      recordUserId: "u1",
      actorUserId: "u2",
      grantId: "g1",
    });
    expect(presence).toEqual({
      entries: [],
      localOcrEnabled: false,
      managedBy: null,
      availableTypes: [],
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("finds nothing on an account with nothing configured", async () => {
    load(row());
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([]);
    expect(presence.managedBy).toBeNull();
  });

  it("lists the person's own credentials in chain order, presence only", async () => {
    load(
      row({
        aiProviderChain: [
          { providerType: "anthropic", enabled: true, priority: 0 },
          { providerType: "local", enabled: true, priority: 1 },
          { providerType: "openai", enabled: false, priority: 2 },
        ],
        aiAnthropicKeyEncrypted: "enc",
        aiOpenaiKeyEncrypted: "enc",
        aiBaseUrl: "http://10.0.0.5:11434/v1",
        aiModel: "claude-sonnet-4-6",
      }),
    );
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries.map((e) => e.providerType)).toEqual([
      "anthropic",
      "local",
    ]);
    expect(presence.managedBy).toBe("user");
  });

  it("names every type whose credential is present, enabled in the chain or not", async () => {
    load(
      row({
        aiProviderChain: [
          { providerType: "codex", enabled: true, priority: 0 },
          { providerType: "openai", enabled: false, priority: 1 },
          { providerType: "anthropic", enabled: true, priority: 2 },
        ],
        aiOpenaiKeyEncrypted: "enc",
      }),
    );
    const presence = await probeProviderChain("u1", OWNER);
    // Codex is not signed in and no Anthropic key is saved: neither can answer.
    expect(presence.availableTypes).toEqual(["openai"]);
  });

  it("marks which entries can read an image", async () => {
    load(
      row({
        aiProviderChain: [
          { providerType: "openai", enabled: true, priority: 0 },
          { providerType: "local", enabled: true, priority: 1 },
        ],
        aiOpenaiKeyEncrypted: "enc",
        aiBaseUrl: "http://10.0.0.5:11434/v1",
        aiModel: "gpt-3.5-turbo",
      }),
    );
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries).toEqual([
      { providerType: "openai", vision: false },
      // A self-hosted model is trusted to read images.
      { providerType: "local", vision: true },
    ]);
  });

  it("gives a guardian the operator's key and nothing of the record's own", async () => {
    load(
      row({
        managedProfileAt: new Date(),
        aiAnthropicKeyEncrypted: "enc",
        labsLocalOcrEnabled: true,
      }),
      settings({ adminAiKeyEncrypted: "enc", adminAiModel: "gpt-4o" }),
    );
    const presence = await probeProviderChain("u1", {
      origin: "guardian",
      recordUserId: "u1",
      actorUserId: "u2",
      grantId: "g1",
    });
    expect(presence).toEqual({
      entries: [{ providerType: "admin-openai", vision: true }],
      localOcrEnabled: false,
      managedBy: "server",
      availableTypes: ["admin-openai"],
    });
  });

  it("appends the operator's central Codex only behind the opt-in", async () => {
    const connected = settings({
      adminCodexConnectionStatus: "connected",
      adminCodexAccessTokenEncrypted: "a",
      adminCodexRefreshTokenEncrypted: "r",
      adminCodexAccountIdEncrypted: "i",
    });
    load(row({ aiProviderChain: [] }), connected);
    expect((await probeProviderChain("u1", OWNER)).entries).toEqual([]);

    load(row({ aiProviderChain: [], useCentralCodex: true }), connected);
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries.map((e) => e.providerType)).toEqual([
      "admin-codex",
    ]);
    expect(presence.managedBy).toBe("server");
  });

  it("falls back to the legacy single provider only for an empty chain", async () => {
    // A chain whose only entry is switched off resolves empty.
    load(
      row({
        aiProviderChain: [
          { providerType: "anthropic", enabled: false, priority: 0 },
        ],
        aiProvider: "ANTHROPIC",
        aiAnthropicKeyEncrypted: "enc",
      }),
    );
    const presence = await probeProviderChain("u1", OWNER);
    expect(presence.entries.map((e) => e.providerType)).toEqual([
      "admin-openai",
    ]);
  });

  it("carries the person's in-browser OCR opt-in", async () => {
    load(row({ labsLocalOcrEnabled: true }));
    expect((await probeProviderChain("u1", OWNER)).localOcrEnabled).toBe(true);
  });
});

describe("probeProviderPresence", () => {
  const textOnly = row({
    aiProviderChain: [{ providerType: "openai", enabled: true, priority: 0 }],
    aiOpenaiKeyEncrypted: "enc",
    aiModel: "gpt-3.5-turbo",
  });

  it("serves text from any entry", async () => {
    load(textOnly);
    expect(await probeProviderPresence("u1", "text")).toBe(true);
  });

  it("serves a document only from a vision entry, or text plus in-browser OCR", async () => {
    load(textOnly);
    expect(await probeProviderPresence("u1", "document")).toBe(false);
    load({ ...textOnly, labsLocalOcrEnabled: true });
    expect(await probeProviderPresence("u1", "document")).toBe(true);
  });
});

describe("the helpers that answer through the probe", () => {
  it("agree with it", async () => {
    load(
      row({
        aiProviderChain: [
          { providerType: "admin-openai", enabled: true, priority: 0 },
        ],
      }),
      settings({ adminAiKeyEncrypted: "enc" }),
    );
    expect(await hasAnyConfiguredProvider("u1")).toBe(true);
    expect(await resolveProviderAvailability("u1")).toEqual({
      aiAvailable: true,
      managedBy: "server",
    });
    load(row({ aiProviderChain: [] }));
    expect(await hasAnyConfiguredProvider("u1")).toBe(false);
    expect(await resolveProviderAvailability("u1")).toEqual({
      aiAvailable: false,
      managedBy: null,
    });
  });
});
