/**
 * v1.11.0 — CRITICAL INVARIANT.
 *
 * A share token can authenticate ONLY the public share surface. Presented on a
 * normal authenticated route it must be REJECTED: `requireAuth` reads only the
 * cookie session and an `Authorization: Bearer` of the app's own format
 * (`hlk_`, against `ApiToken`); it never reads the `X-HealthLog-Share`
 * header, and an `hls_` token is not that format, so it is no credential at
 * all and the request 401s.
 *
 * This locks the boundary structurally — if a future change made `requireAuth`
 * honour a share token, this test fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const headerStore = new Map<string, string>();

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/db", () => ({
  prisma: { apiToken: { findUnique: vi.fn() } },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => headerStore.get(name.toLowerCase()) ?? null,
  })),
}));

import { requireAuth } from "@/lib/api-handler";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const SHARE_TOKEN = `hls_${"a".repeat(48)}`;

describe("share token on a normal authed route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headerStore.clear();
    (getSession as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // No ApiToken row exists for an `hls_` token — share tokens live in a
    // separate table the Bearer path never queries.
    (prisma.apiToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      null,
    );
  });

  it("rejects an hls_ token presented as Authorization: Bearer", async () => {
    headerStore.set("authorization", `Bearer ${SHARE_TOKEN}`);
    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    // Not a token of this app: never looked up, never honoured. The request
    // fell to the cookie path, which found no session.
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalled();
  });

  it("ignores the X-HealthLog-Share header entirely on an authed route", async () => {
    // Present ONLY the share header — no cookie, no Bearer.
    headerStore.set("x-healthlog-share", SHARE_TOKEN);
    await expect(requireAuth()).rejects.toMatchObject({ statusCode: 401 });
    // The share header is never consulted: the Bearer lookup never ran.
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });
});
