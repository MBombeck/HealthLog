import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((value: string) => `enc(${value})`),
  decrypt: vi.fn((value: string) => value.replace(/^enc\(|\)$/g, "")),
}));

import { GET, PUT } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";
import { encrypt } from "@/lib/crypto";
import { auditLog } from "@/lib/auth/audit";

const ADMIN_CTX = {
  authMethod: "cookie" as const,
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "admin-1",
    username: "admin",
    role: "ADMIN",
  } as never,
};

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
});

describe("GET /api/admin/settings", () => {
  it("rejects with 401 when no session", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );
    await expect(GET()).rejects.toThrow("Not authenticated");
  });

  it("rejects with 403 for non-admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    await expect(GET()).rejects.toThrow("Admin access required");
  });

  it("reads the singleton row (regression: not the default-typo)", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    await GET();
    expect(prisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.appSettings.findUnique).mock.calls[0]?.[0];
    // Must be "singleton" — the test-endpoints PR previously typo'd this as "default".
    expect(args).toEqual({ where: { id: "singleton" } });
  });

  it("returns sane defaults when no settings row exists", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.registrationEnabled).toBe(true);
    expect(body.data.defaultLocale).toBe("de");
    expect(body.data.webPushVapidConfigured).toBe(false);
    expect(body.data.glitchtipEnabled).toBe(false);
  });

  it("never leaks the encrypted private key fields", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      id: "singleton",
      registrationEnabled: false,
      defaultLocale: "en",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: "pub",
      webPushVapidSubject: "mailto:a@b.com",
      webPushVapidPrivateKeyEncrypted: "secret-blob",
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: "production",
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
    } as never);

    const res = await GET();
    const body = (await res.json()) as { data: Record<string, unknown> };
    // The configured flag must be true …
    expect(body.data.webPushVapidConfigured).toBe(true);
    // … but raw encrypted blobs must never reach the client.
    const serialized = JSON.stringify(body.data);
    expect(serialized).not.toContain("secret-blob");
    expect(body.data).not.toHaveProperty("webPushVapidPrivateKeyEncrypted");
  });
});

describe("PUT /api/admin/settings", () => {
  it("rejects with 403 for non-admin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    await expect(PUT(jsonReq({}))).rejects.toThrow("Admin access required");
  });

  it("returns 422 for an unknown field (strict schema)", async () => {
    const res = await PUT(jsonReq({ totallyBogus: true }));
    expect(res.status).toBe(422);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  it("returns 422 for invalid Glitchtip DSN URL", async () => {
    const res = await PUT(jsonReq({ glitchtipDsn: "not a url" }));
    expect(res.status).toBe(422);
  });

  it("returns 422 when the body has no actionable fields", async () => {
    const res = await PUT(jsonReq({}));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("No valid fields");
  });

  it("encrypts the VAPID private key before persisting", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "en",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: "enc(plain-private)",
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: "production",
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
    } as never);

    const res = await PUT(jsonReq({ webPushVapidPrivateKey: "plain-private" }));
    expect(res.status).toBe(200);
    expect(encrypt).toHaveBeenCalledWith("plain-private");

    const upsertArgs = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(upsertArgs?.where).toEqual({ id: "singleton" });
    expect(upsertArgs?.update).toEqual({
      webPushVapidPrivateKeyEncrypted: "enc(plain-private)",
    });
    // Audit detail must NOT carry the plaintext private key.
    expect(auditLog).toHaveBeenCalled();
    const auditDetails = vi.mocked(auditLog).mock.calls[0]?.[1]
      ?.details as Record<string, unknown>;
    expect(JSON.stringify(auditDetails)).not.toContain("plain-private");
    expect(auditDetails.webPushVapidPrivateKeyUpdated).toBe(true);
  });

  it("clears the encrypted private key when clear flag is set", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "en",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
    } as never);
    const res = await PUT(jsonReq({ clearWebPushVapidPrivateKey: true }));
    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(args?.update).toEqual({ webPushVapidPrivateKeyEncrypted: null });
  });

  it("normalises a Umami URL with no path to /script.js", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "en",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: "https://analytics.example.com/script.js",
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
    } as never);

    const res = await PUT(
      jsonReq({ umamiScriptUrl: "https://analytics.example.com" }),
    );
    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(args?.update).toEqual({
      umamiScriptUrl: "https://analytics.example.com/script.js",
    });
  });

  it("normalises and persists every Zod-allowed field in a single PUT", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: false,
      defaultLocale: "en",
      telegramGlobal: false,
      ntfyGlobal: false,
      webPushGlobal: false,
      webPushVapidPublicKey: "vapid-pub",
      webPushVapidSubject: "mailto:ops@healthlog.dev",
      webPushVapidPrivateKeyEncrypted: "enc(secret)",
      apiGlobal: false,
      umamiEnabled: true,
      umamiScriptUrl: "https://analytics.example.com/custom.js",
      umamiWebsiteId: "site-uuid",
      glitchtipEnabled: true,
      glitchtipDsn: "https://abc@glitchtip.example.com/1",
      glitchtipEnvironment: "staging",
      reminderLateMinutes: 30,
      reminderMissedMinutes: 90,
    } as never);

    const res = await PUT(
      jsonReq({
        registrationEnabled: false,
        defaultLocale: "en",
        telegramGlobal: false,
        ntfyGlobal: false,
        webPushGlobal: false,
        apiGlobal: false,
        umamiEnabled: true,
        glitchtipEnabled: true,
        webPushVapidPublicKey: "vapid-pub",
        webPushVapidSubject: "mailto:ops@healthlog.dev",
        webPushVapidPrivateKey: "secret",
        umamiScriptUrl: "https://analytics.example.com/custom.js",
        umamiWebsiteId: "site-uuid",
        glitchtipDsn: "https://abc@glitchtip.example.com/1",
        glitchtipEnvironment: "staging",
        reminderLateMinutes: 30,
        reminderMissedMinutes: 90,
      }),
    );
    expect(res.status).toBe(200);
    const upsert = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(upsert?.update).toMatchObject({
      registrationEnabled: false,
      defaultLocale: "en",
      telegramGlobal: false,
      apiGlobal: false,
      glitchtipEnabled: true,
      umamiEnabled: true,
      umamiScriptUrl: "https://analytics.example.com/custom.js",
      umamiWebsiteId: "site-uuid",
      glitchtipDsn: "https://abc@glitchtip.example.com/1",
      glitchtipEnvironment: "staging",
      webPushVapidPublicKey: "vapid-pub",
      webPushVapidSubject: "mailto:ops@healthlog.dev",
      webPushVapidPrivateKeyEncrypted: "enc(secret)",
      reminderLateMinutes: 30,
      reminderMissedMinutes: 90,
    });
    expect(encrypt).toHaveBeenCalledWith("secret");
  });

  it("clears nullable string fields when an empty string is submitted", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "en",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
    } as never);

    await PUT(
      jsonReq({
        webPushVapidPublicKey: "",
        webPushVapidSubject: "",
        umamiScriptUrl: "",
        umamiWebsiteId: "",
        glitchtipDsn: "",
        glitchtipEnvironment: "",
      }),
    );
    const upsert = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(upsert?.update).toEqual({
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
    });
  });

  it("returns 415 when content-type is not JSON", async () => {
    const r = new NextRequest("http://localhost/api/admin/settings", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    const res = await PUT(r);
    expect(res.status).toBe(415);
  });

  // v1.4.25 W7 — server-default timezone.
  it("persists a valid defaultUserTimezone", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "de",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      defaultUserTimezone: "Pacific/Auckland",
    } as never);
    const res = await PUT(jsonReq({ defaultUserTimezone: "Pacific/Auckland" }));
    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(args?.update).toEqual({ defaultUserTimezone: "Pacific/Auckland" });
  });

  it("clears the server-default timezone when given empty string", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "de",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      defaultUserTimezone: null,
    } as never);
    const res = await PUT(jsonReq({ defaultUserTimezone: "" }));
    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(args?.update).toEqual({ defaultUserTimezone: null });
  });

  // Every shipped locale is a valid server default, not only de/en.
  it("persists any shipped locale as the default language", async () => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
      defaultLocale: "fr",
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      webPushVapidPublicKey: null,
      webPushVapidSubject: null,
      webPushVapidPrivateKeyEncrypted: null,
      apiGlobal: true,
      umamiEnabled: false,
      umamiScriptUrl: null,
      umamiWebsiteId: null,
      glitchtipEnabled: false,
      glitchtipDsn: null,
      glitchtipEnvironment: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      defaultUserTimezone: null,
    } as never);
    const res = await PUT(jsonReq({ defaultLocale: "fr" }));
    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(args?.update).toEqual({ defaultLocale: "fr" });
  });

  it("returns 422 for a locale the app does not ship", async () => {
    const res = await PUT(jsonReq({ defaultLocale: "xx" }));
    expect(res.status).toBe(422);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  it("returns 422 for an invalid IANA zone in defaultUserTimezone", async () => {
    const res = await PUT(jsonReq({ defaultUserTimezone: "Mars/Olympus" }));
    expect(res.status).toBe(422);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });

  describe("v1.4.43 W6 — multi-issue 422 envelope", () => {
    it("surfaces TWO simultaneous validation errors", async () => {
      // Bad `registrationEnabled` (string not boolean) + bad
      // `reminderLateMinutes` (string not int).
      const res = await PUT(
        jsonReq({
          registrationEnabled: "string",
          reminderLateMinutes: "string",
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        data: null;
        error: string;
        details: {
          issues: Array<{ path: string; code: string; message: string }>;
        };
      };
      expect(body.data).toBeNull();
      expect(body.error).toBe("Validation failed");
      expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
      for (const issue of body.details.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
      }
    });

    it("surfaces THREE simultaneous validation errors", async () => {
      const res = await PUT(
        jsonReq({
          registrationEnabled: "string",
          reminderLateMinutes: "string",
          reminderMissedMinutes: "string",
        }),
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as {
        details: { issues: Array<unknown> };
      };
      expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    });
  });
});

/**
 * The five assistant flags were accepted by `adminSettingsSchema` and then
 * dropped on the floor: sending one alone answered 422 ("No valid fields"),
 * sending it alongside a real field answered 200 and stored nothing. The
 * schema comment promised the opposite, so the route was brought up to the
 * contract rather than the contract down to the route.
 */
describe("PUT /api/admin/settings — assistant flags", () => {
  const STORED = {
    registrationEnabled: true,
    mfaRequired: false,
    defaultLocale: "de",
    telegramGlobal: true,
    ntfyGlobal: true,
    webPushGlobal: true,
    webPushVapidPublicKey: null,
    webPushVapidPrivateKeyEncrypted: null,
    webPushVapidSubject: null,
    apiGlobal: true,
    umamiEnabled: false,
    umamiScriptUrl: null,
    umamiWebsiteId: null,
    glitchtipEnabled: false,
    glitchtipDsn: null,
    glitchtipEnvironment: null,
    reminderLateMinutes: 120,
    reminderMissedMinutes: 240,
    documentMaxFileBytes: 26_214_400,
    documentQuotaBytes: BigInt(1_073_741_824),
    defaultUserTimezone: null,
    assistantEnabled: true,
    assistantCoachEnabled: false,
    assistantBriefingEnabled: true,
    assistantInsightStatusEnabled: true,
    assistantDocumentAiEnabled: true,
  };

  beforeEach(() => {
    vi.mocked(prisma.appSettings.upsert).mockResolvedValue(STORED as never);
  });

  it("persists a lone assistant flag instead of answering 'No valid fields'", async () => {
    const res = await PUT(jsonReq({ assistantCoachEnabled: false }));

    expect(res.status).toBe(200);
    expect(prisma.appSettings.upsert).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(args.update).toEqual({ assistantCoachEnabled: false });
  });

  it("persists an assistant flag sent alongside an unrelated field", async () => {
    const res = await PUT(
      jsonReq({ registrationEnabled: false, assistantCoachEnabled: false }),
    );

    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0] as {
      update: Record<string, unknown>;
    };
    expect(args.update).toEqual({
      registrationEnabled: false,
      assistantCoachEnabled: false,
    });
  });

  it("echoes the stored flags so a scripted write reads back", async () => {
    const res = await PUT(jsonReq({ assistantCoachEnabled: false }));
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({
      assistantEnabled: true,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantDocumentAiEnabled: true,
    });
  });

  it("audits the flag it changed", async () => {
    await PUT(jsonReq({ assistantDocumentAiEnabled: false }));

    expect(auditLog).toHaveBeenCalledWith(
      "admin.settings.update",
      expect.objectContaining({
        details: expect.objectContaining({
          assistantDocumentAiEnabled: false,
        }),
      }),
    );
  });

  it("still refuses an unknown flag-shaped key", async () => {
    const res = await PUT(jsonReq({ assistantNotAThing: false }));
    expect(res.status).toBe(422);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/settings — assistant flags", () => {
  it("defaults every flag to enabled when the row is absent", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await GET();
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantDocumentAiEnabled: true,
    });
  });

  it("surfaces the stored flags", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      assistantEnabled: false,
      assistantCoachEnabled: false,
    } as never);
    const res = await GET();
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data).toMatchObject({
      assistantEnabled: false,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
    });
  });
});
