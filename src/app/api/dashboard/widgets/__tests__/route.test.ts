/**
 * v1.4.42 W2 — multi-issue 422 envelope on PUT.
 *
 * Until v1.4.41 this route returned `parsed.error.issues[0].message`,
 * which dropped every issue past the first. iOS contract debugging
 * needed one round-trip per wrong field. The route now returns every
 * issue under `details.issues` AND writes a
 * `dashboard.widgets.validation-failed` audit-ledger row so the
 * operator can grep `/api/admin/audit` for the same trail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  toJson: (v: unknown) => v,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { PUT, __resetAuditDedupMemoForTests } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
  },
};

const callPut = PUT as unknown as (req: NextRequest) => Promise<Response>;

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/widgets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  __resetAuditDedupMemoForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("PUT /api/dashboard/widgets — 422 multi-issue envelope (v1.4.42 W2)", () => {
  it("surfaces TWO simultaneous validation errors under details.issues", async () => {
    // version=2 (literal mismatch) + widgets=[] (min(1) violation).
    const res = await callPut(makeReq({ version: 2, widgets: [] }));
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
    expect(body.details.issues.length).toBe(2);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["version", "widgets"]);

    // Every issue carries exactly path / code / message — issue.params
    // never leaks (it may echo the offending user input for some codes).
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await callPut(
      makeReq({
        version: 99,
        widgets: [],
        comparisonBaseline: "tomorrow",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBe(3);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["comparisonBaseline", "version", "widgets"]);
  });

  it("writes one audit-ledger row keyed dashboard.widgets.validation-failed", async () => {
    const res = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res.status).toBe(422);

    // The audit row is fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 5));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("dashboard.widgets.validation-failed");
    const details = JSON.parse(call.data.details) as {
      issues: Array<{ path: string; code: string }>;
    };
    expect(details.issues.length).toBe(2);
    for (const issue of details.issues) {
      // v1.4.49 — audit row is the persisted surface. `message`
      // strips here so a future Zod code that embeds the offending
      // value cannot leak into the ledger.
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });

  it("dedups the audit-ledger write across two sequential 422s for the same user (v1.4.43 B2)", async () => {
    // First 422 writes one row; the second 422 inside the 60 s window
    // returns the same envelope but skips the audit insert.
    const res1 = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res1.status).toBe(422);
    const res2 = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res2.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

    // The full multi-issue envelope still rides on every 422 — the
    // dedup only suppresses the breadcrumb write, never the response.
    const body2 = (await res2.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body2.details.issues.length).toBe(2);
  });

  it("surfaces received_keys + received_shape_excerpt + zod_issues in the wide-event meta (v1.4.48 H-iOS-1)", async () => {
    const payload = { version: 2, widgets: [], extraGarbage: "from-ios" };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi.mocked(annotate).mock.calls.find(
      (call) =>
        (call[0] as { action?: { name?: string } })?.action?.name ===
        "dashboard.widgets.validation-failed",
    );
    expect(annotated, "validation-failed annotate call").toBeTruthy();
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;

    // Top-level keys mirror the iOS-sent payload (NOT the schema keys).
    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["version", "widgets", "extraGarbage"]),
    );

    // Excerpt is a JSON-stringified prefix, hard-capped at 256 chars.
    expect(typeof meta.received_shape_excerpt).toBe("string");
    expect((meta.received_shape_excerpt as string).length).toBeLessThanOrEqual(
      256,
    );
    expect(meta.received_shape_excerpt as string).toContain("\"version\":2");

    // zod_issues is the same sanitised array surfaced under details.issues.
    const issues = meta.zod_issues as Array<{ path: string; code: string }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("caps received_shape_excerpt at 256 chars even for a large iOS payload", async () => {
    const widgets = Array.from({ length: 30 }, (_, i) => ({
      id: `widget-${i}-${"x".repeat(20)}`,
      visible: true,
      order: i,
    }));
    const res = await callPut(makeReq({ version: 99, widgets }));
    expect(res.status).toBe(422);

    const annotated = vi.mocked(annotate).mock.calls.find(
      (call) =>
        (call[0] as { action?: { name?: string } })?.action?.name ===
        "dashboard.widgets.validation-failed",
    );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    expect((meta.received_shape_excerpt as string).length).toBe(256);
  });

  it("does not block the 422 response when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );

    const res = await callPut(makeReq({ version: 2, widgets: [] }));
    // The response is the contract — the audit row is best-effort.
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBe(2);
  });

  it("redacts sensitive keys before writing the wide-event received_shape_excerpt (v1.4.49)", async () => {
    // Caller adds a credential-shaped field — must not land in the
    // wide-event excerpt verbatim. The denylist also covers nested
    // members so `payload.apiKey` is redacted, while `version` /
    // `widgets` stay readable for operator debug.
    const payload = {
      version: 2,
      widgets: [],
      apnsToken: "ff".repeat(32),
      authorization: "Bearer leaked",
      payload: { apiKey: "sk_live_xxx" },
    };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi.mocked(annotate).mock.calls.find(
      (call) =>
        (call[0] as { action?: { name?: string } })?.action?.name ===
        "dashboard.widgets.validation-failed",
    );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    const excerpt = meta.received_shape_excerpt as string;

    // Sensitive values are never written into the excerpt.
    expect(excerpt).not.toContain("ff".repeat(32));
    expect(excerpt).not.toContain("Bearer leaked");
    expect(excerpt).not.toContain("sk_live_xxx");
    // The redactor leaves the literal sentinel behind so an operator
    // can still see the shape of the rejected payload.
    expect(excerpt).toContain("[redacted]");
    // Non-sensitive keys still surface for debugging.
    expect(meta.received_keys).toEqual(
      expect.arrayContaining([
        "version",
        "widgets",
        "apnsToken",
        "authorization",
        "payload",
      ]),
    );
  });

  it("strips `message` from the audit-ledger issues row (v1.4.49)", async () => {
    // The wide-event meta keeps full message for operator debugging,
    // but the persisted auditLog row must only carry `path` + `code`
    // so a future Zod code that embeds the offending value cannot
    // leak into the ledger.
    await callPut(makeReq({ version: 2, widgets: [] }));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { details: string };
    };
    const parsed = JSON.parse(call.data.details) as {
      issues: Array<Record<string, unknown>>;
    };
    for (const issue of parsed.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });
});
