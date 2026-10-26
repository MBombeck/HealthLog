/**
 * The capability re-check at the wire, and the gate option that leaves the
 * provider questions to the route's own pick.
 *
 * The loader is replaced so each case hands the gate exactly the inputs it
 * needs; the receipt read is replaced so the exact-pick consent answer can be
 * steered independently of the presence-based one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let auth: Record<string, unknown> | undefined;
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ getAuth: () => auth, addWarning: vi.fn() }),
}));
vi.mock("@/lib/sharing/grant-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sharing/grant-access")>()),
  findActiveGrant: vi.fn(),
}));
vi.mock("../load", () => ({ loadAiCapabilityInputs: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: { consentReceipt: { findFirst: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";

import { aiEgressRefusal, assertAiEgress } from "../egress";
import { requireAiCapability } from "../gate";
import { loadAiCapabilityInputs } from "../load";
import { AiUnavailableError } from "../refusal";
import type { AiCapabilityInputs } from "../resolve";

function inputs(
  overrides: Partial<AiCapabilityInputs> = {},
): AiCapabilityInputs {
  const moduleAccess = {} as Record<ModuleKey, ModuleAccessState>;
  for (const key of MODULE_KEYS) moduleAccess[key] = "enabled";
  return {
    switches: {
      enabled: true,
      coach: true,
      briefing: true,
      insightStatus: true,
      documentAi: true,
    },
    moduleAccess,
    providerWorkAdmitted: true,
    provider: {
      entries: [{ providerType: "local", vision: true }],
      localOcrEnabled: false,
      managedBy: "local",
    },
    activeConsentKinds: new Set(),
    recordKind: "self",
    ...overrides,
  };
}

const LOAD = vi.mocked(loadAiCapabilityInputs);
const RECEIPT = vi.mocked(prisma.consentReceipt.findFirst);

beforeEach(() => {
  LOAD.mockReset();
  RECEIPT.mockReset();
  RECEIPT.mockResolvedValue(null);
  auth = { user_id: "user-1" };
});

describe("requireAiCapability with pickDecides", () => {
  it("leaves no_provider to the route's pick", async () => {
    LOAD.mockResolvedValue(
      inputs({
        provider: { entries: [], localOcrEnabled: false, managedBy: null },
      }),
    );
    await expect(
      requireAiCapability("documentAi", { pickDecides: true }),
    ).resolves.toMatchObject({ available: true });
  });

  it("leaves consent_required to the route's pick", async () => {
    LOAD.mockResolvedValue(
      inputs({
        provider: {
          entries: [{ providerType: "openai", vision: true }],
          localOcrEnabled: false,
          managedBy: "user",
        },
      }),
    );
    await expect(
      requireAiCapability("documentAi", { pickDecides: true }),
    ).resolves.toMatchObject({ available: true });
  });

  it("still refuses a layer the pick cannot answer", async () => {
    LOAD.mockResolvedValue(
      inputs({ switches: { ...inputs().switches, documentAi: false } }),
    );
    const error = await requireAiCapability("documentAi", {
      pickDecides: true,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.meta.errorCode).toBe("assistant.disabled.documentAi");
  });
});

describe("aiEgressRefusal inside a request", () => {
  it("refuses when the operator switch is off, whatever the pick", async () => {
    LOAD.mockResolvedValue(
      inputs({ switches: { ...inputs().switches, documentAi: false } }),
    );
    const refusal = await aiEgressRefusal("documentAi", "user-1", ["local"]);
    expect(refusal).toBeInstanceOf(AiUnavailableError);
    expect(refusal?.meta).toEqual({
      errorCode: "assistant.disabled.documentAi",
      capability: "documentAi",
      reason: "operator_disabled",
    });
  });

  it("refuses the master switch through every extraction capability", async () => {
    LOAD.mockResolvedValue(
      inputs({ switches: { ...inputs().switches, enabled: false } }),
    );
    for (const key of ["documentAi", "labsOcr", "medicationExtract"] as const) {
      const refusal = await aiEgressRefusal(key, "user-1", ["local"]);
      expect(refusal?.reason, key).toBe("operator_disabled");
    }
  });

  it("asks for a receipt when the actual pick leaves the machine", async () => {
    // Presence says a local model would read it; the route picked an external
    // provider anyway (text mode reads the chain head). The pick decides.
    LOAD.mockResolvedValue(inputs());
    const refusal = await aiEgressRefusal("documentAi", "user-1", ["openai"]);
    expect(refusal?.meta).toEqual({
      errorCode: "consent.ai.required",
      capability: "documentAi",
      reason: "consent_required",
    });
    expect(RECEIPT).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          revokedAt: null,
          kind: { in: ["ai_extraction", "ai_full"] },
        }),
      }),
    );
  });

  it("admits an external pick with an extraction receipt", async () => {
    LOAD.mockResolvedValue(inputs());
    RECEIPT.mockResolvedValue({ id: "r1" } as never);
    await expect(
      aiEgressRefusal("documentAi", "user-1", ["openai"]),
    ).resolves.toBeNull();
  });

  it("needs no receipt for a local pick, even when presence says one is needed", async () => {
    LOAD.mockResolvedValue(
      inputs({
        provider: {
          entries: [{ providerType: "openai", vision: true }],
          localOcrEnabled: false,
          managedBy: "user",
        },
      }),
    );
    await expect(
      aiEgressRefusal("documentAi", "user-1", ["local"]),
    ).resolves.toBeNull();
    expect(RECEIPT).not.toHaveBeenCalled();
  });

  it("checks every entry of a cascading chain under the document rule", async () => {
    LOAD.mockResolvedValue(inputs());
    const refusal = await aiEgressRefusal("medicationExtract", "user-1", [
      "local",
      "admin-openai",
    ]);
    expect(refusal?.reason).toBe("consent_required");
    await expect(
      aiEgressRefusal("medicationExtract", "user-1", ["local"]),
    ).resolves.toBeNull();
  });

  it("uses the self-snapshot rule for the Coach: a person's own key needs nothing", async () => {
    LOAD.mockResolvedValue(inputs());
    await expect(
      aiEgressRefusal("coach", "user-1", ["openai"]),
    ).resolves.toBeNull();
    const refusal = await aiEgressRefusal("coach", "user-1", ["admin-openai"]);
    expect(refusal?.reason).toBe("consent_required");
    expect(RECEIPT).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { in: ["ai_coach", "ai_full"] },
        }),
      }),
    );
  });

  it("fails closed when the inputs cannot be loaded", async () => {
    LOAD.mockResolvedValue(null);
    const refusal = await aiEgressRefusal("labsOcr", "user-1", ["local"]);
    expect(refusal?.reason).toBe("check_failed");
    expect(refusal?.status).toBe(503);
  });
});

describe("aiEgressRefusal outside a request (a job)", () => {
  beforeEach(() => {
    auth = undefined;
  });

  it("resolves for the record the job names", async () => {
    LOAD.mockResolvedValue(
      inputs({ switches: { ...inputs().switches, documentAi: false } }),
    );
    const refusal = await aiEgressRefusal("documentAi", "user-9", ["local"]);
    expect(refusal?.reason).toBe("operator_disabled");
    expect(LOAD).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "user-9" }),
    );
  });

  it("admits the wire when every layer is open", async () => {
    LOAD.mockResolvedValue(inputs());
    await expect(
      aiEgressRefusal("documentAi", "user-9", ["local"]),
    ).resolves.toBeNull();
  });
});

describe("assertAiEgress", () => {
  it("throws the refusal", async () => {
    LOAD.mockResolvedValue(
      inputs({ switches: { ...inputs().switches, documentAi: false } }),
    );
    await expect(
      assertAiEgress("medicationExtract", "user-1", ["local"]),
    ).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("returns quietly when the wire is open", async () => {
    LOAD.mockResolvedValue(inputs());
    await expect(
      assertAiEgress("labsOcr", "user-1", ["local"]),
    ).resolves.toBeUndefined();
  });
});
