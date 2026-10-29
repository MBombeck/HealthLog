/**
 * The labs scan's wire and its probe.
 *
 * `requireLabsOcrProvider` is where a lab report meets a provider: it picks
 * the provider for the scan mode and asks the `labsOcr` capability again about
 * exactly that provider. `resolveOcrCapability` is the probe the Labs page
 * reads to decide whether to offer a scan at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(),
  resolveProvider: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  getAiCapability: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/documents/rasterize-pdf", () => ({
  RASTERIZATION_AVAILABLE: true,
}));

import { prisma } from "@/lib/db";
import { resolveProvider, resolveProviderChain } from "@/lib/ai/provider";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";
import { getAiCapability } from "@/lib/ai/capabilities/gate";
import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";

import {
  requireLabsOcrProvider,
  resolveOcrCapability,
} from "../ocr-capability";

function entry(providerType: string) {
  return { providerType, instance: { type: providerType } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    aiModel: "claude-sonnet-4-5",
    labsLocalOcrEnabled: true,
  } as never);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
    adminAiModel: null,
  } as never);
  vi.mocked(resolveProvider).mockResolvedValue({ type: "none" } as never);
  vi.mocked(aiEgressRefusal).mockResolvedValue(null);
  vi.mocked(getAiCapability).mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
});

describe("requireLabsOcrProvider", () => {
  it("re-checks labsOcr for the vision pick", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([entry("anthropic")]);
    const pick = await requireLabsOcrProvider("u1", "vision");
    expect(pick.providerType).toBe("anthropic");
    expect(aiEgressRefusal).toHaveBeenCalledWith("labsOcr", "u1", [
      "anthropic",
    ]);
  });

  it("re-checks labsOcr for the text-mode chain head, not the first vision entry", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([
      entry("codex"),
      entry("local"),
    ]);
    const pick = await requireLabsOcrProvider("u1", "text");
    expect(pick.providerType).toBe("codex");
    expect(aiEgressRefusal).toHaveBeenCalledWith("labsOcr", "u1", ["codex"]);
  });

  it("throws the wire's refusal and hands back no provider", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([entry("anthropic")]);
    const refusal = new AiUnavailableError("labsOcr", "operator_disabled");
    vi.mocked(aiEgressRefusal).mockResolvedValue(refusal);
    await expect(requireLabsOcrProvider("u1", "vision")).rejects.toBe(refusal);
  });

  it("keeps the scan's own code when nothing can read the report", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([]);
    const error = await requireLabsOcrProvider("u1", "vision").catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.status).toBe(422);
    expect(error.meta).toEqual({
      errorCode: "labs.ocr.providerUnsupported",
      capability: "labsOcr",
      reason: "no_provider",
    });
    expect(aiEgressRefusal).not.toHaveBeenCalled();
  });
});

describe("resolveOcrCapability", () => {
  it("offers the scan and reports the capability beside it", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([entry("anthropic")]);
    const dto = await resolveOcrCapability("u1");
    expect(dto).toMatchObject({
      available: true,
      mode: "vision",
      ai: { available: true },
    });
    expect(getAiCapability).toHaveBeenCalledWith("labsOcr");
  });

  it("offers nothing when the operator turned document reading off", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([entry("anthropic")]);
    vi.mocked(getAiCapability).mockResolvedValue({
      available: false,
      reason: "operator_disabled",
      onDeviceAllowed: false,
    });
    await expect(resolveOcrCapability("u1")).resolves.toEqual({
      available: false,
      mode: null,
      reason: null,
      pdfSupported: false,
      ai: {
        available: false,
        reason: "operator_disabled",
        onDeviceAllowed: false,
      },
    });
  });

  it("offers nothing with the labs module off", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([entry("anthropic")]);
    vi.mocked(getAiCapability).mockResolvedValue({
      available: false,
      reason: "module_disabled",
      onDeviceAllowed: false,
    });
    const dto = await resolveOcrCapability("u1");
    expect(dto.available).toBe(false);
    expect(dto.mode).toBeNull();
  });

  it("keeps the scan offered when only a consent receipt is missing", async () => {
    vi.mocked(resolveProviderChain).mockResolvedValue([entry("anthropic")]);
    vi.mocked(getAiCapability).mockResolvedValue({
      available: false,
      reason: "consent_required",
      onDeviceAllowed: true,
    });
    const dto = await resolveOcrCapability("u1");
    expect(dto).toMatchObject({ available: true, mode: "vision" });
  });
});
