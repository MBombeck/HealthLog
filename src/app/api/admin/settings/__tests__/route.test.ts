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
    expect(body.data.bugReportConfigured).toBe(false);
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
      githubIssueRepo: "owner/repo",
      githubIssueTokenEncrypted: "token-blob",
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
    } as never);

    const res = await GET();
    const body = (await res.json()) as { data: Record<string, unknown> };
    // The two configured-flags must be true …
    expect(body.data.webPushVapidConfigured).toBe(true);
    expect(body.data.bugReportConfigured).toBe(true);
    // … but raw encrypted blobs must never reach the client.
    const serialized = JSON.stringify(body.data);
    expect(serialized).not.toContain("secret-blob");
    expect(serialized).not.toContain("token-blob");
    expect(body.data).not.toHaveProperty("webPushVapidPrivateKeyEncrypted");
    expect(body.data).not.toHaveProperty("githubIssueTokenEncrypted");
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
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
      githubIssueRepo: "owner/repo",
      githubIssueTokenEncrypted: "enc(gh-token)",
      reminderLateMinutes: 30,
      reminderMissedMinutes: 90,
      moodLogGlobal: false,
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
        moodLogGlobal: false,
        glitchtipEnabled: true,
        webPushVapidPublicKey: "vapid-pub",
        webPushVapidSubject: "mailto:ops@healthlog.dev",
        webPushVapidPrivateKey: "secret",
        umamiScriptUrl: "https://analytics.example.com/custom.js",
        umamiWebsiteId: "site-uuid",
        glitchtipDsn: "https://abc@glitchtip.example.com/1",
        glitchtipEnvironment: "staging",
        bugReportRepo: "owner/repo",
        bugReportToken: "gh-token",
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
      githubIssueRepo: "owner/repo",
      githubIssueTokenEncrypted: "enc(gh-token)",
      webPushVapidPublicKey: "vapid-pub",
      webPushVapidSubject: "mailto:ops@healthlog.dev",
      webPushVapidPrivateKeyEncrypted: "enc(secret)",
      reminderLateMinutes: 30,
      reminderMissedMinutes: 90,
    });
    expect(encrypt).toHaveBeenCalledWith("secret");
    expect(encrypt).toHaveBeenCalledWith("gh-token");
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
    } as never);

    await PUT(
      jsonReq({
        webPushVapidPublicKey: "",
        webPushVapidSubject: "",
        umamiScriptUrl: "",
        umamiWebsiteId: "",
        glitchtipDsn: "",
        glitchtipEnvironment: "",
        bugReportRepo: "",
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
      githubIssueRepo: null,
    });
  });

  it("clears the encrypted bug-report token when clear flag is set", async () => {
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
    } as never);
    await PUT(jsonReq({ clearBugReportToken: true }));
    const upsert = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(upsert?.update).toEqual({ githubIssueTokenEncrypted: null });
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      bugReportEnabled: true,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
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
      githubIssueRepo: null,
      githubIssueTokenEncrypted: null,
      bugReportEnabled: true,
      reminderLateMinutes: 120,
      reminderMissedMinutes: 240,
      moodLogGlobal: true,
      defaultUserTimezone: null,
    } as never);
    const res = await PUT(jsonReq({ defaultUserTimezone: "" }));
    expect(res.status).toBe(200);
    const args = vi.mocked(prisma.appSettings.upsert).mock.calls[0]?.[0];
    expect(args?.update).toEqual({ defaultUserTimezone: null });
  });

  it("returns 422 for an invalid IANA zone in defaultUserTimezone", async () => {
    const res = await PUT(jsonReq({ defaultUserTimezone: "Mars/Olympus" }));
    expect(res.status).toBe(422);
    expect(prisma.appSettings.upsert).not.toHaveBeenCalled();
  });
});
