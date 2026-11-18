/**
 * Coach tool mode with an Antigravity provider in the chain.
 *
 * Antigravity reports `supportsTools = false`. The Coach uses tool retrieval
 * only when every provider in the chain supports tools. So one Antigravity
 * hop must switch the turn to the legacy snapshot path, and the Coach must
 * not fail or skip the snapshot path because of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityClient } from "@/lib/ai/antigravity-client";
import { resolveProviderChain } from "@/lib/ai/provider";
import { assertConsentForChain } from "@/lib/ai/consent-guard";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";
import type { AIProvider } from "@/lib/ai/types";
import { resolveTurnChain } from "../chain";
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));
const PROFILE = {
  geminiDir: "/var/lib/healthlog/antigravity/u1",
};
/** A provider that can call tools, as the Coach's tool mode needs. */
const toolCapable: AIProvider = {
  type: "openai",
  supportsTools: true,
} as unknown as AIProvider;
function entry(
  providerType: ProviderChainResolved["providerType"],
  instance: AIProvider,
): ProviderChainResolved {
  return { providerType, instance };
}
describe("resolveTurnChain tool mode with Antigravity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("turns tool mode off when Antigravity is the only provider", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([
      entry("antigravity", new AntigravityClient({ profile: PROFILE })),
    ]);
    const result = await resolveTurnChain("user-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolMode).toBe(false);
  });
  it("turns tool mode off when Antigravity is a fallback after a tool-capable provider", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([
      entry("openai", toolCapable),
      entry("antigravity", new AntigravityClient({ profile: PROFILE })),
    ]);
    const result = await resolveTurnChain("user-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolMode).toBe(false);
  });
  it("keeps tool mode on when every provider in the chain supports tools", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([
      entry("openai", toolCapable),
      entry("openai", toolCapable),
    ]);
    const result = await resolveTurnChain("user-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.toolMode).toBe(true);
  });
  it("still checks consent for an Antigravity chain", async () => {
    const chain = [
      entry("antigravity", new AntigravityClient({ profile: PROFILE })),
    ];
    vi.mocked(resolveProviderChain).mockResolvedValue(chain);
    await resolveTurnChain("user-1");
    expect(assertConsentForChain).toHaveBeenCalledWith({
      userId: "user-1",
      chain,
      surface: "coach",
    });
  });
});
