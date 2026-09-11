import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be hoisted before importing the route.
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({
    user: { id: "u-1" },
    session: { id: "s-1" },
  })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((v: string) => `dec:${v}`),
  encrypt: vi.fn((v: string) => `enc:${v}`),
}));

vi.mock("@/lib/ai/provider", () => ({
  resolveProviderAvailability: vi.fn(),
}));

vi.mock("@/lib/validations/notifications", () => ({
  isPublicUrl: vi.fn(() => true),
}));

vi.mock("@/lib/ai/local-host-allowlist", () => ({
  isLocalAiHostAllowed: vi.fn(() => false),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

// v1.38.19 (wave D) — the four preconditions the honest offer rides on.
vi.mock("@/lib/ai/server-provider-health", () => ({
  readServerProviderHealth: vi.fn(),
}));

vi.mock("@/lib/feature-flags", () => ({
  getAssistantFlags: vi.fn(),
}));

vi.mock("@/lib/sharing/provider-work-authority", () => ({
  providerWorkAuthorityForRecord: vi.fn(() => ({ origin: "owner" })),
  providerCredentialPolicy: vi.fn(() => "personal"),
}));

vi.mock("@/lib/ai/consent-guard", () => ({
  hasActiveConsentForSurface: vi.fn(),
}));

import { GET, PATCH } from "../route";
import { prisma } from "@/lib/db";
import { resolveProviderAvailability } from "@/lib/ai/provider";
import { isPublicUrl } from "@/lib/validations/notifications";
import { isLocalAiHostAllowed } from "@/lib/ai/local-host-allowlist";
import { readServerProviderHealth } from "@/lib/ai/server-provider-health";
import { getAssistantFlags } from "@/lib/feature-flags";
import { providerCredentialPolicy } from "@/lib/sharing/provider-work-authority";
import { hasActiveConsentForSurface } from "@/lib/ai/consent-guard";

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/ai-provider", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface AiProviderResponse {
  data: {
    provider: string | null;
    aiAvailable: boolean;
    managedBy: "user" | "local" | "server" | null;
    hasAnthropicKey: boolean;
    hasOpenaiKey: boolean;
  };
  error: null;
}

beforeEach(() => {
  vi.resetAllMocks();
  // The shape every GET needs before a case narrows it: an owning caller on
  // an instance whose assistant surfaces are on, who has not consented yet.
  vi.mocked(readServerProviderHealth).mockResolvedValue("unknown");
  vi.mocked(getAssistantFlags).mockResolvedValue({
    enabled: true,
    coach: true,
    briefing: true,
    insightStatus: true,
    correlations: true,
  });
  vi.mocked(providerCredentialPolicy).mockReturnValue("personal");
  vi.mocked(hasActiveConsentForSurface).mockResolvedValue(false);
});

describe("GET /api/user/ai-provider availability", () => {
  it("reports available + managedBy:user when the user holds a BYO key", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: "OPENAI",
      aiModel: "gpt-4o",
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "user",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as AiProviderResponse;

    expect(vi.mocked(resolveProviderAvailability)).toHaveBeenCalledWith("u-1");
    expect(body.data.aiAvailable).toBe(true);
    expect(body.data.managedBy).toBe("user");
    expect(body.data.hasOpenaiKey).toBe(true);
  });

  it("reports available + managedBy:server when only an admin-managed provider exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "server",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as AiProviderResponse;

    // The user has no personal key, but the Coach must still surface.
    expect(body.data.provider).toBeNull();
    expect(body.data.hasOpenaiKey).toBe(false);
    expect(body.data.aiAvailable).toBe(true);
    expect(body.data.managedBy).toBe("server");
  });

  it("reports aiAvailable:false + managedBy:null when nothing is configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: false,
      managedBy: null,
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as AiProviderResponse;

    expect(body.data.aiAvailable).toBe(false);
    expect(body.data.managedBy).toBeNull();
  });

  it("returns the v1.22 response timeout field", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: "OPENAI",
      aiModel: "gpt-4o",
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
      aiResponseTimeoutSeconds: 240,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "user",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as {
      data: { responseTimeoutSeconds: number | null };
    };

    expect(body.data.responseTimeoutSeconds).toBe(240);
  });
});

describe("PATCH /api/user/ai-provider — v1.22 fields", () => {
  const patch = PATCH as (req: Request) => Promise<Response>;

  it("persists a valid response timeout", async () => {
    const res = await patch(patchRequest({ responseTimeoutSeconds: 120 }));
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiResponseTimeoutSeconds: 120 }),
      }),
    );
  });

  // Was `.rejects.toThrow(/between 10 and 600/)`. The route threw an
  // HttpError for this one field while every other bad value was skipped in
  // silence; it runs one Zod parse now, so the refusal is the standard
  // multi-issue 422 that every sibling route answers with.
  it("rejects an out-of-range response timeout", async () => {
    const res = await patch(patchRequest({ responseTimeoutSeconds: 5 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      meta?: { errorCode?: string };
      details?: { issues?: Array<{ path: string; message?: string }> };
    };
    expect(body.meta?.errorCode).toBe("ai_provider.invalid");
    const issue = body.details?.issues?.find(
      (i) => i.path === "responseTimeoutSeconds",
    );
    expect(issue?.message).toMatch(/between 10 and 600/);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("clears the timeout when null is sent", async () => {
    await patch(patchRequest({ responseTimeoutSeconds: null }));
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ aiResponseTimeoutSeconds: null }),
      }),
    );
  });
});

// v1.33.1 (#470) — the OpenAI-compatible gateway writes three columns of its
// own. What matters at this layer: the SSRF floor applies to the gateway's
// base URL exactly as it does to the Local one, and the column is nobody
// else's — switching the active provider away must not hand a stale URL to a
// key-carrying provider, and must not silently discard the user's gateway
// either.
describe("PATCH /api/user/ai-provider — the gateway's own columns (#470)", () => {
  const patch = PATCH as (req: Request) => Promise<Response>;

  it("persists base URL, model and encrypted key", async () => {
    vi.mocked(isPublicUrl).mockReturnValue(true);
    const res = await patch(
      patchRequest({
        provider: "OPENAI_COMPATIBLE",
        compatBaseUrl: "https://litellm.example.com/v1",
        compatModel: "anthropic/claude-sonnet-4-6",
        compatKey: "gateway-secret",
      }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiProvider: "OPENAI_COMPATIBLE",
          aiCompatBaseUrl: "https://litellm.example.com/v1",
          aiCompatModel: "anthropic/claude-sonnet-4-6",
          aiCompatKeyEncrypted: "enc:gateway-secret",
        }),
      }),
    );
  });

  it("refuses a private base URL the operator has not allowlisted", async () => {
    vi.mocked(isPublicUrl).mockReturnValue(false);
    vi.mocked(isLocalAiHostAllowed).mockReturnValue(false);
    const res = await patch(
      patchRequest({ compatBaseUrl: "http://169.254.169.254/v1" }),
    );
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("accepts a private base URL the operator allowlisted", async () => {
    vi.mocked(isPublicUrl).mockReturnValue(false);
    vi.mocked(isLocalAiHostAllowed).mockReturnValue(true);
    const res = await patch(
      patchRequest({ compatBaseUrl: "http://litellm.lan:4000/v1" }),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiCompatBaseUrl: "http://litellm.lan:4000/v1",
        }),
      }),
    );
  });

  it("leaves the gateway URL alone when the provider switches to OpenAI", async () => {
    vi.mocked(isPublicUrl).mockReturnValue(true);
    await patch(patchRequest({ provider: "OPENAI" }));
    const data = vi.mocked(prisma.user.update).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    // `aiBaseUrl` is the shared LOCAL column and IS cleared. The gateway's is
    // untouched — it belongs to one provider, and that provider is not this
    // one, so there is nothing for a stale value to redirect.
    expect(data.aiBaseUrl).toBeNull();
    expect(data).not.toHaveProperty("aiCompatBaseUrl");
  });
});

/**
 * A wrongly-typed field must be refused, not skipped.
 *
 * The route inspected the body key by key with `typeof` guards. A value of
 * the wrong type failed every guard and simply produced no entry in the
 * update object, so the write went ahead WITHOUT it and answered 200 — the
 * caller was told the save succeeded while the field they set was discarded.
 * A body of nothing but such keys fell through to "No valid fields", naming
 * none of them, which is the same silence with a worse message.
 */
describe("PATCH /api/user/ai-provider — wrongly-typed fields are named", () => {
  const patch = PATCH as (req: Request) => Promise<Response>;

  it.each([
    ["model", 42],
    ["baseUrl", true],
    ["compatModel", { nested: "object" }],
    ["anthropicKey", 12345],
    ["openaiKey", ["array"]],
    ["responseTimeoutSeconds", "120"],
  ])("refuses a %s of the wrong type and names its path", async (key, bad) => {
    const res = await patch(patchRequest({ [key]: bad }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      meta?: { errorCode?: string };
      details?: { issues?: Array<{ path: string }> };
    };
    expect(body.meta?.errorCode).toBe("ai_provider.invalid");
    expect(body.details?.issues?.map((i) => i.path)).toContain(key);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("refuses the whole write when one field of several is wrongly typed", async () => {
    vi.mocked(isPublicUrl).mockReturnValue(true);
    const res = await patch(
      patchRequest({ provider: "OPENAI", model: 42, openaiKey: "sk-real" }),
    );
    expect(res.status).toBe(422);
    // Partial application would have persisted the provider and dropped the
    // model, leaving the account in a state the caller never asked for.
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("refuses an unrecognised provider and names its path", async () => {
    const res = await patch(patchRequest({ provider: "GEMINI" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details?: { issues?: Array<{ path: string }> };
    };
    expect(body.details?.issues?.map((i) => i.path)).toContain("provider");
  });

  it("never echoes a rejected credential back in the error body", async () => {
    const res = await patch(
      patchRequest({ anthropicKey: 12345, openaiKey: "sk-super-secret" }),
    );
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain("sk-super-secret");
  });

  it("still answers 'No valid fields' for a body of nothing it knows", async () => {
    const res = await patch(patchRequest({ somethingElse: "value" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.error).toBe("No valid fields");
    expect(body.meta?.errorCode).toBe("ai_provider.no_fields");
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("keeps accepting the three-state contract on a known field", async () => {
    vi.mocked(isPublicUrl).mockReturnValue(true);
    await patch(patchRequest({ model: "  gpt-4o  ", anthropicKey: "" }));
    expect(vi.mocked(prisma.user.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          aiModel: "gpt-4o",
          aiAnthropicKeyEncrypted: null,
        }),
      }),
    );
    // An omitted key is untouched, not cleared.
    const data = vi.mocked(prisma.user.update).mock.calls[0][0].data as Record<
      string,
      unknown
    >;
    expect(data).not.toHaveProperty("aiOpenaiKeyEncrypted");
  });
});

describe("GET /api/user/ai-provider — the gateway's fields (#470)", () => {
  it("reports the base URL and model, and the key as presence only", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: "OPENAI_COMPATIBLE",
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
      aiCompatBaseUrl: "https://litellm.example.com/v1",
      aiCompatKeyEncrypted: "enc-gateway",
      aiCompatModel: "anthropic/claude-sonnet-4-6",
      aiResponseTimeoutSeconds: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "user",
    });

    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as {
      data: {
        compatBaseUrl: string | null;
        compatModel: string | null;
        hasCompatKey: boolean;
      };
    };
    expect(body.data.compatBaseUrl).toBe("https://litellm.example.com/v1");
    expect(body.data.compatModel).toBe("anthropic/claude-sonnet-4-6");
    expect(body.data.hasCompatKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("enc-gateway");
  });
});

/**
 * v1.38.19 (wave D) — the honest shared-provider offer.
 *
 * The setup flow's last screen used to promise that insights "work for you
 * right away" whenever `managedBy` said `server`. That is a presence read:
 * it knows a key is configured, never that it works, and it says nothing
 * about the consent receipt the egress actually needs. These three fields
 * are what makes the promise checkable — and every one of the five
 * preconditions below can only ever take the offer AWAY.
 */
describe("GET /api/user/ai-provider — the shared-provider offer", () => {
  function serverManaged(): void {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: null,
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: null,
      managedProfileAt: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "server",
    });
  }

  async function read(): Promise<{
    serverProviderHealth: string;
    serverProviderOffer: boolean;
    serverProviderConsent: boolean;
  }> {
    const res = await (GET as () => Promise<Response>)();
    const body = (await res.json()) as {
      data: {
        serverProviderHealth: string;
        serverProviderOffer: boolean;
        serverProviderConsent: boolean;
      };
    };
    return body.data;
  }

  it("offers the shared provider when it is demonstrably healthy and nothing forbids it", async () => {
    serverManaged();
    vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
    await expect(read()).resolves.toMatchObject({
      serverProviderHealth: "healthy",
      serverProviderOffer: true,
      serverProviderConsent: false,
    });
  });

  it.each(["unhealthy", "unknown"] as const)(
    "never offers on %s health — unknown is not a maybe",
    async (health) => {
      serverManaged();
      vi.mocked(readServerProviderHealth).mockResolvedValue(health);
      await expect(read()).resolves.toMatchObject({
        serverProviderHealth: health,
        serverProviderOffer: false,
      });
    },
  );

  it("never offers when the operator switched the assistant surfaces off", async () => {
    serverManaged();
    vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
    vi.mocked(getAssistantFlags).mockResolvedValue({
      enabled: true,
      coach: false,
      briefing: true,
      insightStatus: true,
      correlations: true,
    });
    await expect(read()).resolves.toMatchObject({
      serverProviderHealth: "healthy",
      serverProviderOffer: false,
    });
  });

  it("never offers to a managed profile — a child's record does not consent for itself", async () => {
    serverManaged();
    vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
    vi.mocked(providerCredentialPolicy).mockReturnValue("operator-default");
    await expect(read()).resolves.toMatchObject({ serverProviderOffer: false });
  });

  it("stops offering once the user holds a receipt, and says the consent is on file", async () => {
    serverManaged();
    vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
    vi.mocked(hasActiveConsentForSurface).mockResolvedValue(true);
    await expect(read()).resolves.toMatchObject({
      serverProviderOffer: false,
      serverProviderConsent: true,
    });
  });

  it("never offers a provider the operator does not manage", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      aiProvider: "OPENAI",
      aiModel: null,
      aiBaseUrl: null,
      aiAnthropicKeyEncrypted: null,
      aiLocalKeyEncrypted: null,
      aiOpenaiKeyEncrypted: "enc-openai",
      managedProfileAt: null,
    } as never);
    vi.mocked(resolveProviderAvailability).mockResolvedValue({
      aiAvailable: true,
      managedBy: "user",
    });
    vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
    await expect(read()).resolves.toMatchObject({ serverProviderOffer: false });
  });

  it("reads the health without probing anything", async () => {
    serverManaged();
    vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
    await read();
    expect(vi.mocked(readServerProviderHealth)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readServerProviderHealth)).toHaveBeenCalledWith();
  });

  it("never offers on a demo instance, where the grant cannot be made", async () => {
    // The one tap posts `POST /api/consent/ai/web`, which the demo's edge
    // allowlist refuses — and should: the demo is one shared account, so a
    // receipt minted by one visitor would turn the operator's provider on
    // for every later one. Offering a button that can only 403 into a
    // generic toast is the misleading failure this screen exists to remove,
    // so the offer is withheld and the screen falls to its neutral panel.
    const previous = process.env.DEMO_MODE;
    process.env.DEMO_MODE = "true";
    try {
      serverManaged();
      vi.mocked(readServerProviderHealth).mockResolvedValue("healthy");
      await expect(read()).resolves.toMatchObject({
        serverProviderHealth: "healthy",
        serverProviderOffer: false,
      });
    } finally {
      if (previous === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = previous;
    }
  });
});
