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

import { GET, PUT, __resetAuditDedupMemoForTests } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import {
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  serializeDashboardLayout,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

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
    // v1.7.0 #9 — unknown ids are now filtered out before Zod, so use a
    // KNOWN id (survives the filter) with an out-of-range `order` (>99)
    // and a long label to keep the payload large AND failing validation.
    const widgets = Array.from({ length: 30 }, (_, i) => ({
      id: DASHBOARD_WIDGET_IDS[0],
      visible: true,
      order: 999 + i,
      label: `${"x".repeat(20)}-${i}`,
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

describe("PUT /api/dashboard/widgets — accept-and-ignore unknown ids (v1.7.0 #9)", () => {
  const knownId = DASHBOARD_WIDGET_IDS[0];

  it("persists known ids, drops unknown ids, returns 200, and annotates", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: knownId, visible: true, order: 0 },
          { id: "ios-only-future-tile", visible: true, order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(200);

    // The persisted blob never carries the unknown id.
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.user.update).mock.calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    expect(persistedIds).toContain(knownId);
    expect(persistedIds).not.toContain("ios-only-future-tile");

    // The drop is greppable via the annotation.
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "dashboard.widgets.unknown-id-dropped" },
        meta: expect.objectContaining({
          dropped_ids: ["ios-only-future-tile"],
          dropped_count: 1,
        }),
      }),
    );
  });

  it("caps the logged dropped_ids array at 20 while keeping the full dropped_count (v1.7.0)", async () => {
    // A large all-unknown payload — the unknown-id filter runs before
    // Zod's `.max(20)`, so the wide-event line must not carry every id.
    const widgets = Array.from({ length: 200 }, (_, i) => ({
      id: `ios-unknown-${i}`,
      visible: true,
      order: i,
    }));

    const res = await callPut(makeReq({ version: 1, widgets }));
    // All widgets unknown → surviving array is empty → 422 (min 1). The
    // annotation fires regardless, before the Zod parse.
    expect(res.status).toBe(422);

    const dropAnnotate = vi.mocked(annotate).mock.calls.find(
      (c) =>
        (c[0] as { action?: { name?: string } }).action?.name ===
        "dashboard.widgets.unknown-id-dropped",
    );
    expect(dropAnnotate, "unknown-id-dropped annotate call").toBeTruthy();
    const meta = (dropAnnotate![0] as { meta?: Record<string, unknown> }).meta!;
    expect(meta.dropped_count).toBe(200);
    expect((meta.dropped_ids as string[]).length).toBe(20);
  });

  it("still 422s when a surviving entry is malformed (missing order)", async () => {
    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: knownId, visible: true }, // no `order`
          { id: "ios-only-future-tile", visible: true, order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });
});

const callGet = GET as unknown as () => Promise<Response>;

describe("dashboard widgets — 27-id catalogue round-trip (v1.7.0 W1)", () => {
  it("PUT of a full 27-id layout persists every id (iOS-only round-trip)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const widgets = DASHBOARD_WIDGET_CATALOGUE_IDS.map((id, i) => ({
      id,
      visible: true,
      tileVisible: true,
      order: i,
    }));
    const res = await callPut(makeReq({ version: 1, widgets }));
    expect(res.status).toBe(200);

    // No id was dropped — the unknown-id annotation must NOT fire.
    const dropAnnotate = vi.mocked(annotate).mock.calls.find(
      (c) =>
        (c[0] as { action?: { name?: string } }).action?.name ===
        "dashboard.widgets.unknown-id-dropped",
    );
    expect(dropAnnotate).toBeUndefined();

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    expect(persistedIds.sort()).toEqual([...DASHBOARD_WIDGET_CATALOGUE_IDS].sort());
    // The response body echoes the full persisted layout.
    const body = (await res.json()) as {
      data: { widgets: Array<{ id: string }> };
    };
    expect(body.data.widgets.map((w) => w.id).sort()).toEqual(
      [...DASHBOARD_WIDGET_CATALOGUE_IDS].sort(),
    );
  });

  it("GET returns the full persisted layout including all 11 iOS-only ids", async () => {
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: DASHBOARD_WIDGET_CATALOGUE_IDS.map((id, i) => ({
        id,
        visible: true,
        tileVisible: true,
        order: i,
      })),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { widgets: Array<{ id: string }> };
    };
    const ids = body.data.widgets.map((w) => w.id);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).toContain(iosId);
    }
    expect(ids.sort()).toEqual([...DASHBOARD_WIDGET_CATALOGUE_IDS].sort());
  });

  it("an id genuinely outside the 27-catalogue still drops on PUT", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: "hrv", visible: true, tileVisible: true, order: 0 }, // iOS-only — survives
          { id: "glp1", visible: true, tileVisible: true, order: 1 }, // retired — drops
        ],
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    expect(persistedIds).toContain("hrv");
    expect(persistedIds).not.toContain("glp1");

    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "dashboard.widgets.unknown-id-dropped" },
        meta: expect.objectContaining({
          dropped_ids: ["glp1"],
          dropped_count: 1,
        }),
      }),
    );
  });
});
