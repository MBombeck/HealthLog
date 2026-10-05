/**
 * v1.4.16 phase B5b — read-only chain summary surfaced under
 * `/settings/ai`. The full management UX is owned by B2 (provider
 * settings cleanup); this endpoint just lets the existing AI section
 * render "Active provider: codex" + "Configured: codex, openai" so the
 * user can see the cascade order without clicking into a dedicated
 * page.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
  HttpError: class HttpError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(),
  probeProviderChain: vi.fn(async () => ({
    entries: [],
    localOcrEnabled: false,
    managedBy: null,
    availableTypes: ["codex", "openai", "admin-openai"],
  })),
}));

vi.mock("@/lib/ai/provider-runner", () => ({
  getLastWorkingProvider: vi.fn(),
  forgetLastWorkingProvider: vi.fn(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ aiProviderChain: null })),
    },
  },
}));

import { GET } from "../route";
import { probeProviderChain, resolveProviderChain } from "@/lib/ai/provider";
import { getLastWorkingProvider } from "@/lib/ai/provider-runner";
import { prisma } from "@/lib/db";

interface Envelope {
  data?: {
    activeProvider: string | null;
    cachedActiveProvider: string | null;
    configuredChain: {
      providerType: string;
      enabled: boolean;
      available: boolean;
    }[];
  };
  error?: string;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    aiProviderChain: null,
  } as never);
});

describe("GET /api/insights/provider-chain", () => {
  it("returns the persisted chain (with enabled flags) and the active resolver winner", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProviderChain: [
        { providerType: "codex", priority: 1, enabled: true },
        { providerType: "admin-openai", priority: 2, enabled: true },
      ],
    } as never);
    vi.mocked(resolveProviderChain).mockResolvedValue([
      {
        providerType: "codex",
        instance: { type: "codex" } as never,
      },
      {
        providerType: "admin-openai",
        instance: { type: "admin-key" } as never,
      },
    ]);
    vi.mocked(getLastWorkingProvider).mockReturnValue(null);

    const res = await (GET as () => Promise<Response>)();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope;
    expect(body.data?.activeProvider).toBe("codex");
    expect(body.data?.configuredChain).toEqual([
      { providerType: "codex", enabled: true, available: true },
      { providerType: "admin-openai", enabled: true, available: true },
    ]);
  });

  it("surfaces disabled entries on the wire so the user can re-enable them", async () => {
    // v1.4.16 phase D reconcile (code-review H2) — the GET response
    // used to filter through resolveProviderChain which DROPS disabled
    // entries; the UI then lost them on next refetch. The persisted
    // chain is the source of truth on the wire.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProviderChain: [
        { providerType: "codex", priority: 1, enabled: true },
        { providerType: "openai", priority: 2, enabled: false },
        { providerType: "admin-openai", priority: 3, enabled: true },
      ],
    } as never);
    vi.mocked(resolveProviderChain).mockResolvedValue([
      { providerType: "codex", instance: { type: "codex" } as never },
      {
        providerType: "admin-openai",
        instance: { type: "admin-key" } as never,
      },
    ]);
    vi.mocked(getLastWorkingProvider).mockReturnValue(null);

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as Envelope;
    expect(body.data?.configuredChain).toEqual([
      { providerType: "codex", enabled: true, available: true },
      { providerType: "openai", enabled: false, available: true },
      { providerType: "admin-openai", enabled: true, available: true },
    ]);
    // Active still reflects the resolver winner (enabled-only).
    expect(body.data?.activeProvider).toBe("codex");
  });

  it("surfaces the cached last-working provider when available", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProviderChain: [
        { providerType: "codex", priority: 1, enabled: true },
        { providerType: "openai", priority: 2, enabled: true },
      ],
    } as never);
    vi.mocked(resolveProviderChain).mockResolvedValue([
      { providerType: "codex", instance: { type: "codex" } as never },
      {
        providerType: "openai",
        instance: { type: "admin-key" } as never,
      },
    ]);
    vi.mocked(getLastWorkingProvider).mockReturnValue("openai");

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as Envelope;
    expect(body.data?.cachedActiveProvider).toBe("openai");
    // The chain still reports codex first (chain priority is the truth);
    // only the cache hint is updated. The UI reads both — primary line
    // is "Active provider: codex (cached: openai)".
    expect(body.data?.activeProvider).toBe("codex");
  });

  it("falls back to the default chain when nothing is configured", async () => {
    // parseProviderChain(null) returns PROVIDER_CHAIN_DEFAULT — every
    // user therefore renders a populated list, not an empty one. The
    // active line still reflects the resolver, which can be empty if
    // no credentials are configured.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProviderChain: null,
    } as never);
    vi.mocked(resolveProviderChain).mockResolvedValue([]);
    vi.mocked(getLastWorkingProvider).mockReturnValue(null);

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as Envelope;
    expect(body.data?.activeProvider).toBeNull();
    expect(body.data?.configuredChain.length).toBeGreaterThan(0);
    expect(body.data?.configuredChain.every((e) => e.enabled === true)).toBe(
      true,
    );
  });

  it("marks an entry without a credential as unavailable, enabled or not", async () => {
    // The Coach's provider select offers only available entries; an entry
    // marked available without a key was saved to the front of the chain
    // and never answered.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProviderChain: [
        { providerType: "codex", priority: 1, enabled: true },
        { providerType: "anthropic", priority: 2, enabled: true },
        { providerType: "openai", priority: 3, enabled: false },
        { providerType: "local", priority: 4, enabled: true },
      ],
    } as never);
    vi.mocked(probeProviderChain).mockResolvedValueOnce({
      entries: [{ providerType: "codex", vision: false }],
      localOcrEnabled: false,
      managedBy: "user",
      availableTypes: ["codex", "openai"],
    });
    vi.mocked(resolveProviderChain).mockResolvedValue([
      { providerType: "codex", instance: { type: "codex" } as never },
    ]);
    vi.mocked(getLastWorkingProvider).mockReturnValue(null);

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as Envelope;
    expect(body.data?.configuredChain).toEqual([
      { providerType: "codex", enabled: true, available: true },
      { providerType: "anthropic", enabled: true, available: false },
      { providerType: "openai", enabled: false, available: true },
      { providerType: "local", enabled: true, available: false },
    ]);
  });
});
