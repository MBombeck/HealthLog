import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    documentAiRun: { updateMany: vi.fn() },
    inboundDocument: { updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: vi.fn().mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  }),
}));

vi.mock("@/lib/documents/pdf-isolation", () => ({
  withPdfWork: vi
    .fn()
    .mockImplementation((_opts: unknown, fn: () => unknown) => fn()),
}));

vi.mock("@/lib/documents/ai-route-support", () => ({
  loadOwnedDocument: vi.fn().mockResolvedValue({
    id: "doc-1",
    userId: "user-agy-1",
    mimeType: "application/pdf",
    contentEncrypted: Buffer.from("fake"),
    contentCodec: "binary2",
  }),
}));

vi.mock("@/lib/documents/ai-runs/store", () => ({
  claimAiRun: vi.fn(),
  completeAiRun: vi.fn(),
  failAiRun: vi.fn(),
  settleAiRunBudget: vi.fn(),
}));

vi.mock("@/lib/documents/ai-runs/summary-run", () => ({
  DOCUMENT_SUMMARY_MODEL_CALLS: 1,
  executeDocumentSummary: vi.fn().mockResolvedValue({
    ok: true,
    data: { summary: "A medical summary.", persistence: "stored" },
  }),
  markQueuedSummaryUnavailable: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-client", () => {
  const fakeClient = {
    type: "antigravity",
    generateCompletion: vi.fn(),
    generateCompletionStream: vi.fn(),
    responseTimeoutSeconds: 300,
  };
  return {
    antigravityProfileLocation: vi.fn().mockReturnValue({
      profileDir: "/tmp/fake-prof",
      geminiDir: "/tmp/fake-gemini",
    }),
    antigravityProviderFor: vi.fn().mockReturnValue(fakeClient),
    AntigravityClient: vi.fn().mockImplementation(() => fakeClient),
  };
});

import { prisma } from "@/lib/db";
import {
  clearAntigravityCapabilityCache,
  antigravityReadsMedia,
} from "@/lib/ai/antigravity-capability-cache";
import {
  requireDocumentVisionProvider,
  resolveDocumentVisionProvider,
} from "../provider-order";
import { runDocumentAiRun } from "@/lib/jobs/document-ai-run";
import {
  claimAiRun,
  completeAiRun,
  failAiRun,
} from "@/lib/documents/ai-runs/store";
import { executeDocumentSummary } from "@/lib/documents/ai-runs/summary-run";

describe("Antigravity cold-cache vision provider resolution regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAntigravityCapabilityCache();
  });

  afterEach(() => {
    clearAntigravityCapabilityCache();
  });

  it("hydrates antigravity capabilities from DB when cache is cold and resolves vision pick", async () => {
    const userId = "user-agy-1";
    // Ensure in-memory cache is cold before the call
    expect(antigravityReadsMedia(userId)).toBe(false);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: userId,
      role: "user",
      aiModel: null,
      labsLocalOcrEnabled: false,
      aiProviderChain: [
        { providerType: "antigravity", enabled: true, priority: 1 },
      ],
      antigravityProfileId: "prof-1",
      antigravityModel: "gemini-2.5-pro",
      antigravityCapabilitiesJson: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiModel: null,
    } as never);

    const resolved = await resolveDocumentVisionProvider(userId);
    expect(resolved.pick).not.toBeNull();
    expect(resolved.pick?.providerType).toBe("antigravity");

    const required = await requireDocumentVisionProvider(userId);
    expect(required.providerType).toBe("antigravity");
  });

  it("refuses vision pick when persisted capabilities do not support media", async () => {
    const userId = "user-agy-unsupported";
    expect(antigravityReadsMedia(userId)).toBe(false);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: userId,
      role: "user",
      aiModel: null,
      labsLocalOcrEnabled: false,
      aiProviderChain: [
        { providerType: "antigravity", enabled: true, priority: 1 },
      ],
      antigravityProfileId: "prof-1",
      antigravityModel: "gemini-2.5-pro",
      antigravityCapabilitiesJson: {
        promptCapabilities: { image: false, embeddedContext: false },
      },
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiModel: null,
    } as never);

    const resolved = await resolveDocumentVisionProvider(userId);
    expect(resolved.pick).toBeNull();

    await expect(requireDocumentVisionProvider(userId)).rejects.toMatchObject({
      status: 422,
      meta: { errorCode: "documents.inbound.providerUnsupported" },
    });
  });

  it("executes DOCUMENT_SUMMARY in cold background worker without providerUnsupported refusal", async () => {
    const userId = "user-agy-worker-1";
    expect(antigravityReadsMedia(userId)).toBe(false);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: userId,
      role: "user",
      aiModel: null,
      labsLocalOcrEnabled: false,
      aiProviderChain: [
        { providerType: "antigravity", enabled: true, priority: 1 },
      ],
      antigravityProfileId: "prof-1",
      antigravityModel: "gemini-2.5-pro",
      antigravityCapabilitiesJson: {
        promptCapabilities: { image: true, embeddedContext: true },
      },
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiModel: null,
    } as never);

    const runId = "run-summary-agy-1";
    vi.mocked(claimAiRun).mockResolvedValue({
      id: runId,
      userId,
      documentId: "doc-1",
      kind: "DOCUMENT_SUMMARY",
      status: "RUNNING",
      params: {
        mode: "vision",
        budget: { reserved: 1000, owner: "user", dateKey: "2026-11-17" },
        summary: {
          output: "summary",
          persist: true,
          replace: false,
          locale: "en",
        },
      },
      input: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      claimedAt: new Date(),
    } as never);

    const result = await runDocumentAiRun(runId, Date.now() + 3600_000);
    expect(result).toBe("succeeded");
    expect(executeDocumentSummary).toHaveBeenCalledTimes(1);
    expect(completeAiRun).toHaveBeenCalledWith(
      runId,
      { summary: "A medical summary.", persistence: "stored" },
      expect.any(Date),
    );
    expect(failAiRun).not.toHaveBeenCalled();
  });

  it("worker fails with providerUnsupported when cold agy capabilities do not support media", async () => {
    const userId = "user-agy-worker-unsupported";
    expect(antigravityReadsMedia(userId)).toBe(false);

    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: userId,
      role: "user",
      aiModel: null,
      labsLocalOcrEnabled: false,
      aiProviderChain: [
        { providerType: "antigravity", enabled: true, priority: 1 },
      ],
      antigravityProfileId: "prof-1",
      antigravityModel: "gemini-2.5-pro",
      antigravityCapabilitiesJson: {
        promptCapabilities: { image: false, embeddedContext: false },
      },
    } as never);

    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      adminAiModel: null,
    } as never);

    const runId = "run-summary-agy-unsupported";
    vi.mocked(claimAiRun).mockResolvedValue({
      id: runId,
      userId,
      documentId: "doc-1",
      kind: "DOCUMENT_SUMMARY",
      status: "RUNNING",
      params: {
        mode: "vision",
        budget: { reserved: 1000, owner: "user", dateKey: "2026-11-17" },
        summary: {
          output: "summary",
          persist: true,
          replace: false,
          locale: "en",
        },
      },
      input: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      claimedAt: new Date(),
    } as never);

    const result = await runDocumentAiRun(runId, Date.now() + 3600_000);
    expect(result).toBe("failed");
    expect(executeDocumentSummary).not.toHaveBeenCalled();
    expect(failAiRun).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        status: 422,
        errorCode: "documents.inbound.providerUnsupported",
      }),
      "RUNNING",
      expect.any(Date),
    );
  });
});
