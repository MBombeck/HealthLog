import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Document-class provider order (governance fix, oauth-investigation
 * SYNTHESIS §1). Pins: for a DOCUMENT read the chain is reprioritised
 * local-first with codex (ChatGPT-subscription OAuth) LAST, and the egress
 * class the vault notice reads is vendor-blind local/external. Coach / insights
 * do not use these helpers, so their app-wide order is untouched.
 */

vi.mock("@/lib/labs/ocr-capability", () => ({
  resolveVisionProvider: vi.fn(),
  resolveTextProvider: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  getAiCapability: vi.fn(),
}));

import {
  documentEgressClass,
  reorderChainForDocumentClass,
  requireDocumentTextProvider,
  requireDocumentVisionProvider,
  resolveDocumentAiCapability,
  resolveDocumentTextProvider,
  resolveDocumentVisionProvider,
} from "../provider-order";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import {
  resolveTextProvider,
  resolveVisionProvider,
  type VisionProviderPick,
} from "@/lib/labs/ocr-capability";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";

function entry(providerType: string): ProviderChainResolved {
  return {
    providerType: providerType as ProviderChainResolved["providerType"],
    instance: {
      type: providerType,
      generateCompletion: vi.fn(),
    } as unknown as ProviderChainResolved["instance"],
  };
}

const order = (chain: ProviderChainResolved[]) =>
  reorderChainForDocumentClass(chain).map((e) => e.providerType);

describe("reorderChainForDocumentClass", () => {
  it("demotes codex last and lifts local first for the default chain", () => {
    // The persisted default chain the audit flagged: codex at priority 1.
    const chain = [
      entry("codex"),
      entry("openai"),
      entry("anthropic"),
      entry("local"),
      entry("admin-openai"),
    ];
    expect(order(chain)).toEqual([
      "local",
      "openai",
      "anthropic",
      "admin-openai",
      "codex",
    ]);
  });

  it("keeps codex behind local even when codex is the only cheap option", () => {
    expect(order([entry("codex"), entry("local")])).toEqual(["local", "codex"]);
  });

  it("demotes the shared central codex (admin-codex) to the subscription tier (rank 3)", () => {
    // Same train-by-default subscription tier as `codex` — behind local, BYOK,
    // and the operator's no-train admin key.
    expect(
      order([
        entry("admin-codex"),
        entry("local"),
        entry("openai"),
        entry("admin-openai"),
      ]),
    ).toEqual(["local", "openai", "admin-openai", "admin-codex"]);
  });

  it("is stable within a rank tier (preserves user order for BYOK keys)", () => {
    expect(order([entry("anthropic"), entry("openai")])).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(order([entry("openai"), entry("anthropic")])).toEqual([
      "openai",
      "anthropic",
    ]);
  });

  it("does not mutate the input array", () => {
    const chain = [entry("codex"), entry("local")];
    reorderChainForDocumentClass(chain);
    expect(chain.map((e) => e.providerType)).toEqual(["codex", "local"]);
  });
});

describe("documentEgressClass", () => {
  it("classifies local as on-machine and everything else as external", () => {
    expect(documentEgressClass("local")).toBe("local");
    expect(documentEgressClass("codex")).toBe("external");
    expect(documentEgressClass("openai")).toBe("external");
    expect(documentEgressClass("anthropic")).toBe("external");
    expect(documentEgressClass("admin-openai")).toBe("external");
    expect(documentEgressClass("admin-codex")).toBe("external");
  });
});

describe("resolveDocumentVisionProvider", () => {
  beforeEach(() => {
    vi.mocked(resolveVisionProvider).mockReset();
    vi.mocked(aiEgressRefusal).mockReset();
    vi.mocked(aiEgressRefusal).mockResolvedValue(null);
  });

  it("invokes the shared resolver with the document reorder that demotes codex", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      localOcrEnabled: false,
      pick: null,
    } as VisionProviderPick);

    await resolveDocumentVisionProvider("u1");

    const call = vi.mocked(resolveVisionProvider).mock.calls[0]!;
    expect(call[0]).toBe("u1");
    expect(call[1]).toBe("documentAi");
    const reorder = call[2]!.reorder!;
    // The reorder the document resolver hands down puts a codex-first chain
    // local-first — proving documents never default to the subscription path.
    expect(
      reorder([entry("codex"), entry("local")]).map((e) => e.providerType),
    ).toEqual(["local", "codex"]);
  });
});

function visionPick(providerType: string): VisionProviderPick {
  return {
    chain: [entry(providerType)],
    localOcrEnabled: false,
    pick: {
      entry: entry(providerType),
      providerType: providerType as never,
      pdfSupported: false,
    },
  };
}

describe("the document pick re-checks documentAi at the wire", () => {
  beforeEach(() => {
    vi.mocked(resolveVisionProvider).mockReset();
    vi.mocked(resolveTextProvider).mockReset();
    vi.mocked(aiEgressRefusal).mockReset();
    vi.mocked(aiEgressRefusal).mockResolvedValue(null);
  });

  it("asks about the picked provider, under documentAi", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(visionPick("openai"));
    const result = await resolveDocumentVisionProvider("u1");
    expect(aiEgressRefusal).toHaveBeenCalledWith("documentAi", "u1", [
      "openai",
    ]);
    expect(result.pick?.providerType).toBe("openai");
    expect(result.withheld).toBeNull();
  });

  it("withholds the pick when the capability closed after the route answered", async () => {
    // A job enqueued before the operator turned the switch off: the pick is
    // resolved, and the wire says no. The caller sees no provider to call.
    const refusal = new AiUnavailableError("documentAi", "operator_disabled");
    vi.mocked(resolveVisionProvider).mockResolvedValue(visionPick("local"));
    vi.mocked(aiEgressRefusal).mockResolvedValue(refusal);
    const result = await resolveDocumentVisionProvider("u1");
    expect(result.pick).toBeNull();
    expect(result.withheld).toBe(refusal);
  });

  it("withholds a text-mode pick the same way", async () => {
    const refusal = new AiUnavailableError("documentAi", "consent_required");
    vi.mocked(resolveTextProvider).mockResolvedValue({
      chain: [entry("codex")],
      pick: { entry: entry("codex"), providerType: "codex" },
    });
    vi.mocked(aiEgressRefusal).mockResolvedValue(refusal);
    const result = await resolveDocumentTextProvider("u1");
    expect(aiEgressRefusal).toHaveBeenCalledWith("documentAi", "u1", ["codex"]);
    expect(result.pick).toBeNull();
    expect(result.withheld).toBe(refusal);
  });

  it("does not ask when nothing was picked", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue({
      chain: [],
      localOcrEnabled: false,
      pick: null,
    });
    const result = await resolveDocumentVisionProvider("u1");
    expect(aiEgressRefusal).not.toHaveBeenCalled();
    expect(result.withheld).toBeNull();
  });

  it("the route form throws the refusal", async () => {
    const refusal = new AiUnavailableError("documentAi", "operator_disabled");
    vi.mocked(resolveVisionProvider).mockResolvedValue(visionPick("local"));
    vi.mocked(aiEgressRefusal).mockResolvedValue(refusal);
    await expect(requireDocumentVisionProvider("u1")).rejects.toBe(refusal);
  });

  it("the route form refuses a missing provider with the vault's own code", async () => {
    vi.mocked(resolveTextProvider).mockResolvedValue({ chain: [], pick: null });
    const error = await requireDocumentTextProvider("u1").catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.status).toBe(422);
    expect(error.meta).toEqual({
      errorCode: "documents.inbound.providerUnsupported",
      capability: "documentAi",
      reason: "no_provider",
    });
  });
});

describe("resolveDocumentAiCapability", () => {
  beforeEach(() => {
    vi.mocked(resolveVisionProvider).mockReset();
    vi.mocked(aiEgressRefusal).mockReset();
    vi.mocked(getAiCapability).mockReset();
  });

  it("reports the capability beside the provider answer", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(visionPick("local"));
    vi.mocked(getAiCapability).mockResolvedValue({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    const dto = await resolveDocumentAiCapability("u1");
    expect(dto).toMatchObject({
      available: true,
      mode: "vision",
      egress: "local",
      ai: { available: true, reason: null },
    });
    // A probe never runs the wire re-check: it sends nothing.
    expect(aiEgressRefusal).not.toHaveBeenCalled();
  });

  it("is unavailable when the operator turned document reading off", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(visionPick("local"));
    vi.mocked(getAiCapability).mockResolvedValue({
      available: false,
      reason: "operator_disabled",
      onDeviceAllowed: false,
    });
    const dto = await resolveDocumentAiCapability("u1");
    expect(dto).toEqual({
      available: false,
      mode: null,
      reason: null,
      pdfSupported: false,
      egress: null,
      ai: {
        available: false,
        reason: "operator_disabled",
        onDeviceAllowed: false,
      },
    });
  });

  it("stays available when only a consent receipt is missing, so the read can ask for it", async () => {
    vi.mocked(resolveVisionProvider).mockResolvedValue(visionPick("openai"));
    vi.mocked(getAiCapability).mockResolvedValue({
      available: false,
      reason: "consent_required",
      onDeviceAllowed: true,
    });
    const dto = await resolveDocumentAiCapability("u1");
    expect(dto).toMatchObject({
      available: true,
      mode: "vision",
      egress: "external",
      ai: { reason: "consent_required" },
    });
  });
});
