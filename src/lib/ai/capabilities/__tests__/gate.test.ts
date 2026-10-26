/**
 * The capability gates: which record and scope they resolve for, and how they
 * fail. The resolver itself is covered in `resolve.test.ts`; here the loader
 * is replaced so each case can hand the gate exactly the inputs it needs.
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
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { findActiveGrant } from "@/lib/sharing/grant-access";
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";

import {
  aiCapabilityForJob,
  getAiCapability,
  requireAiCapability,
} from "../gate";
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

beforeEach(() => {
  LOAD.mockReset();
  vi.mocked(findActiveGrant).mockReset();
  auth = { user_id: "actor" };
});

describe("requireAiCapability", () => {
  it("passes an available capability", async () => {
    LOAD.mockResolvedValue(inputs());
    await expect(requireAiCapability("briefing")).resolves.toEqual({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
  });

  it("throws the outermost reason with its code", async () => {
    LOAD.mockResolvedValue(
      inputs({
        switches: { ...inputs().switches, briefing: false },
        providerWorkAdmitted: false,
      }),
    );
    const error = await requireAiCapability("briefing").catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.meta).toEqual({
      errorCode: "assistant.disabled.briefing",
      capability: "briefing",
      reason: "operator_disabled",
    });
  });

  it("names the module behind a module-layer refusal", async () => {
    LOAD.mockResolvedValue(
      inputs({
        moduleAccess: { ...inputs().moduleAccess, workouts: "disabled" },
      }),
    );
    const error = await requireAiCapability("workoutInsights").catch((e) => e);
    expect(error.meta).toMatchObject({
      errorCode: "module.disabled",
      reason: "module_disabled",
      module: "workouts",
    });
  });

  it("applies a route's own no-provider refusal", async () => {
    LOAD.mockResolvedValue(
      inputs({
        provider: { entries: [], localOcrEnabled: false, managedBy: null },
      }),
    );
    const error = await requireAiCapability("documentAi", {
      noProvider: { errorCode: "documents.inbound.providerUnsupported" },
    }).catch((e) => e);
    expect(error.status).toBe(422);
    expect(error.meta.errorCode).toBe("documents.inbound.providerUnsupported");
  });

  it("fails closed when the loader could not read its inputs", async () => {
    LOAD.mockResolvedValue(null);
    const error = await requireAiCapability("coach").catch((e) => e);
    expect(error.status).toBe(503);
    expect(error.meta.reason).toBe("check_failed");
  });

  it("fails closed when the loader throws", async () => {
    LOAD.mockRejectedValue(new Error("boom"));
    const error = await requireAiCapability("coach").catch((e) => e);
    expect(error.meta.reason).toBe("check_failed");
  });

  it("fails closed without an authenticated caller", async () => {
    auth = undefined;
    const error = await requireAiCapability("coach").catch((e) => e);
    expect(error.meta.reason).toBe("check_failed");
    expect(LOAD).not.toHaveBeenCalled();
  });
});

describe("the request scope", () => {
  it("resolves the caller's own record with the whole record in view", async () => {
    LOAD.mockResolvedValue(inputs());
    await getAiCapability("coach");
    expect(LOAD).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "actor",
        sections: null,
        recordKind: "self",
        authority: expect.objectContaining({ origin: "owner" }),
      }),
    );
  });

  it("resolves a switched record through the grant's sections", async () => {
    auth = {
      user_id: "actor",
      acting_as: "owner",
      provider_work_authority: {
        origin: "guardian",
        recordUserId: "owner",
        actorUserId: "actor",
        grantId: "g1",
      },
    };
    vi.mocked(findActiveGrant).mockResolvedValue({
      scopeJson: ["documents"],
    } as never);
    LOAD.mockResolvedValue(inputs());
    await getAiCapability("documentAi");
    const scope = LOAD.mock.calls[0]![0];
    expect(scope.recordId).toBe("owner");
    expect(scope.sections).toEqual(["documents"]);
    expect(scope.recordKind).toBe("managed");
    expect(scope.authority?.origin).toBe("guardian");
    expect(findActiveGrant).toHaveBeenCalledWith({
      grantorId: "owner",
      granteeId: "actor",
    });
  });

  it("opens nothing when the grant is gone", async () => {
    auth = { user_id: "actor", acting_as: "owner" };
    vi.mocked(findActiveGrant).mockResolvedValue(null);
    LOAD.mockResolvedValue(inputs());
    await getAiCapability("coach");
    expect(LOAD.mock.calls[0]![0].sections).toEqual([]);
    expect(LOAD.mock.calls[0]![0].recordKind).toBe("shared");
  });
});

describe("getAiCapability", () => {
  it("returns the state and never throws", async () => {
    LOAD.mockRejectedValue(new Error("boom"));
    await expect(getAiCapability("statusText")).resolves.toEqual({
      available: false,
      reason: "check_failed",
      onDeviceAllowed: false,
    });
  });
});

describe("aiCapabilityForJob", () => {
  it("resolves for the named record with the whole record in view", async () => {
    auth = undefined;
    LOAD.mockResolvedValue(inputs());
    await expect(aiCapabilityForJob("u9", "reactionLines")).resolves.toEqual({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    expect(LOAD).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "u9", sections: null }),
    );
  });

  it("fails closed and never throws", async () => {
    LOAD.mockRejectedValue(new Error("boom"));
    await expect(aiCapabilityForJob("u9", "coach")).resolves.toMatchObject({
      reason: "check_failed",
    });
  });
});
