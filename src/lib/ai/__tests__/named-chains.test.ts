import { describe, expect, it } from "vitest";

import {
  MAX_NAMED_CHAINS,
  chainSelectionFor,
  parseNamedChains,
  serializeNamedChains,
} from "../named-chains";

describe("parseNamedChains", () => {
  it("reads nothing stored as no chains, the main chain the default", () => {
    for (const raw of [null, undefined, 42, "x", [], {}]) {
      expect(parseNamedChains(raw)).toEqual({
        chains: [],
        defaultChainId: null,
        attachments: {},
      });
    }
  });

  it("keeps valid chains and drops what cannot resolve", () => {
    const parsed = parseNamedChains({
      chains: [
        { id: "docs", name: "  Local only  ", entries: ["local", "local"] },
        { id: "bad id!", name: "Broken", entries: ["local"] },
        { id: "empty", name: "Empty", entries: ["nope"] },
        { id: "cloud", name: "Cloud", entries: ["anthropic", "admin-codex"] },
        { id: "docs", name: "Duplicate id", entries: ["openai"] },
      ],
      defaultChainId: "ghost",
      attachments: {
        documentAi: "docs",
        labsOcr: "ghost",
        notACapability: "docs",
        coach: "cloud",
      },
    });
    expect(parsed.chains).toEqual([
      { id: "docs", name: "Local only", entries: ["local"] },
      { id: "cloud", name: "Cloud", entries: ["anthropic", "admin-codex"] },
    ]);
    expect(parsed.defaultChainId).toBeNull();
    expect(parsed.attachments).toEqual({ documentAi: "docs", coach: "cloud" });
  });

  it("caps the number of chains", () => {
    const chains = Array.from({ length: MAX_NAMED_CHAINS + 3 }, (_, i) => ({
      id: `c${i}`,
      name: `Chain ${i}`,
      entries: ["local"],
    }));
    expect(parseNamedChains({ chains }).chains).toHaveLength(MAX_NAMED_CHAINS);
  });

  it("round-trips through the serializer", () => {
    const config = parseNamedChains({
      chains: [{ id: "a", name: "A", entries: ["local", "openai"] }],
      defaultChainId: "a",
      attachments: { labsOcr: "a" },
    });
    expect(parseNamedChains(serializeNamedChains(config))).toEqual(config);
  });
});

describe("chainSelectionFor", () => {
  const config = parseNamedChains({
    chains: [
      { id: "docs", name: "Docs", entries: ["local"] },
      { id: "fast", name: "Fast", entries: ["openai", "local"] },
    ],
    defaultChainId: null,
    attachments: { documentAi: "docs" },
  });

  it("pins an attached capability to its chain", () => {
    expect(chainSelectionFor(config, "documentAi")).toEqual({
      kind: "pinned",
      chainId: "docs",
      entries: ["local"],
    });
  });

  it("leaves an unattached capability on the main chain", () => {
    expect(chainSelectionFor(config, "coach")).toEqual({ kind: "main" });
    expect(chainSelectionFor(config, null)).toEqual({ kind: "main" });
  });

  it("puts unattached capabilities on a named default with today's rules", () => {
    const withDefault = { ...config, defaultChainId: "fast" };
    expect(chainSelectionFor(withDefault, "coach")).toEqual({
      kind: "default",
      chainId: "fast",
      entries: ["openai", "local"],
    });
    expect(chainSelectionFor(withDefault, "documentAi").kind).toBe("pinned");
  });
});

describe("the settings list", () => {
  it("offers every capability exactly once", async () => {
    const { NAMED_CHAIN_CAPABILITIES } =
      await import("@/components/settings/ai/shared");
    const { AI_CAPABILITY_KEYS } = await import("@/lib/ai/capabilities/types");
    expect([...NAMED_CHAIN_CAPABILITIES].sort()).toEqual(
      [...AI_CAPABILITY_KEYS].sort(),
    );
  });
});
