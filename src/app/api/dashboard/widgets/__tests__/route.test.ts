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

const transactionUser = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      // v1.32.16 (issue #581) — the guarded optimistic-concurrency write.
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    // The GET probes for an SDNN row to decide whether the `hrv` toggle is
    // a dead switch for this account. Only reached when recovery is off.
    measurement: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  toJson: (v: unknown) => v,
}));

// The GET reads one module flag to decide whether a toggle can do anything.
// Spread the real module so only that one call is stubbed — every other
// export stays live for whatever else pulls this in.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  isModuleEnabled: vi.fn(async () => true),
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
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
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

import { DELETE, GET, PUT, __resetAuditDedupMemoForTests } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import { isModuleEnabled } from "@/lib/modules/gate";
import {
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
  serializeDashboardLayout,
  type DashboardLayout,
  type DashboardLayoutWithToken,
} from "@/lib/dashboard-layout";
import { PRIORITY_ITEM_KINDS } from "@/lib/daily/priority-item";

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
const callDelete = DELETE as unknown as () => Promise<Response>;

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
  // `resetAllMocks` strips the factory's implementation, so state the
  // default here beside the others: modules on, which is the shape every
  // test below the dead-switch block assumes.
  vi.mocked(isModuleEnabled).mockResolvedValue(true as never);
  vi.mocked(prisma.$transaction).mockImplementation((async (
    callback: (tx: { user: typeof transactionUser }) => Promise<unknown>,
  ) => callback({ user: transactionUser })) as never);
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

  it("rejects layouts above the documented 50-widget runtime cap", async () => {
    const widgets = Array.from({ length: 51 }, (_, order) => ({
      id: "weight",
      visible: true,
      tileVisible: true,
      order,
    }));
    const res = await callPut(makeReq({ version: 1, widgets }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string }> };
    };
    expect(body.details.issues.map((issue) => issue.path)).toContain("widgets");
    expect(prisma.user.update).not.toHaveBeenCalled();
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

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
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
    expect(meta.received_shape_excerpt as string).toContain('"version":2');

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

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
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

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
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
    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
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

    const dropAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
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
    const dropAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
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
    expect(persistedIds.sort()).toEqual(
      [...DASHBOARD_WIDGET_CATALOGUE_IDS].sort(),
    );
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

  it("GET preserves an explicit all-off hero-content choice", async () => {
    const stored = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      enabledHeroItemKinds: [],
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { enabledHeroItemKinds: string[] };
    };
    expect(body.data.enabledHeroItemKinds).toEqual([]);
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

describe("dashboard widgets — preserve-when-absent on PUT", () => {
  it("keeps the stored comparisonBaseline when the client omits it", async () => {
    // The regression: a layout save from a client that doesn't know
    // `comparisonBaseline` (the native client documents the field as
    // web-only and never sends it) used to fall through to the serializer,
    // which clamps a missing baseline to "none". The user's web-chosen
    // comparison silently reset on every tile reorder from the phone.
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
      comparisonBaseline: "lastYear",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: "weight", visible: false, tileVisible: true, order: 0 },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { comparisonBaseline: string } };
    };
    expect(updateArg.data.dashboardWidgetsJson.comparisonBaseline).toBe(
      "lastYear",
    );

    const body = (await res.json()) as {
      data: { comparisonBaseline: string };
    };
    expect(body.data.comparisonBaseline).toBe("lastYear");
  });

  it("honours an explicitly sent comparisonBaseline over the stored one", async () => {
    // Preserve-when-absent must not become preserve-always: the web
    // CompareToggle sends the field, including an explicit "none" to clear.
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
      comparisonBaseline: "lastYear",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
        comparisonBaseline: "none",
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { comparisonBaseline: string } };
    };
    expect(updateArg.data.dashboardWidgetsJson.comparisonBaseline).toBe("none");
  });

  it("persists the four clinical tiles the native client pins", async () => {
    // They used to hit the unknown-id filter ahead of Zod and vanish from
    // the persisted layout, so the placement was lost on every save.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const clinicalIds = [
      "gripStrength",
      "painNRS",
      "waistCircumference",
      "waistToHeight",
    ];
    const res = await callPut(
      makeReq({
        version: 1,
        widgets: clinicalIds.map((id, i) => ({
          id,
          visible: true,
          tileVisible: true,
          order: i,
        })),
      }),
    );
    expect(res.status).toBe(200);

    const dropAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
        (c) =>
          (c[0] as { action?: { name?: string } }).action?.name ===
          "dashboard.widgets.unknown-id-dropped",
      );
    expect(dropAnnotate).toBeUndefined();

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    for (const id of clinicalIds) {
      expect(persistedIds).toContain(id);
    }
  });
});

describe("dashboard widgets — hero-content visibility persistence", () => {
  it("preserves the stored choice when a stale client omits the field", async () => {
    const stored = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      enabledHeroItemKinds: ["preventive_care", "milestone"],
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: DashboardLayout };
    };
    expect(updateArg.data.dashboardWidgetsJson.enabledHeroItemKinds).toEqual([
      "preventive_care",
      "milestone",
    ]);
  });

  it("round-trips an explicit all-off PUT without writing notification preferences", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: DEFAULT_DASHBOARD_LAYOUT,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
        enabledHeroItemKinds: [],
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: Record<string, unknown> & {
        dashboardWidgetsJson: DashboardLayout;
      };
    };
    expect(updateArg.data.dashboardWidgetsJson.enabledHeroItemKinds).toEqual(
      [],
    );
    expect(Object.keys(updateArg.data)).toEqual(["dashboardWidgetsJson"]);

    const body = (await res.json()) as { data: DashboardLayout };
    expect(body.data.enabledHeroItemKinds).toEqual([]);
  });

  it("omits an all-enabled choice from stored and returned serialization", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
        enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS].reverse(),
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: DashboardLayout };
    };
    expect(
      Object.prototype.hasOwnProperty.call(
        updateArg.data.dashboardWidgetsJson,
        "enabledHeroItemKinds",
      ),
    ).toBe(false);

    const body = (await res.json()) as { data: DashboardLayout };
    expect(
      Object.prototype.hasOwnProperty.call(body.data, "enabledHeroItemKinds"),
    ).toBe(false);
  });

  it("rejects values outside the current priority-item catalogue", async () => {
    const res = await callPut(
      makeReq({
        version: 1,
        widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
        enabledHeroItemKinds: ["future_item"],
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

/**
 * v1.32.16 — optimistic concurrency (issue #581). A Save that carries the
 * `baseUpdatedAt` it was made against writes CONDITIONALLY on the stored row
 * still carrying that token, so a committed Save can never be silently
 * reverted by a later request that started from an older snapshot. A full
 * layout with every top-level field present skips the preserve-read, so the
 * only `findUnique` here is the post-write token read.
 */
describe("dashboard widgets — optimistic concurrency (issue #581)", () => {
  // A full layout carrying every preserved field so `needsPreserveRead`
  // is false and the route takes the guarded write path directly.
  function fullLayoutBody(baseUpdatedAt?: string) {
    return {
      version: 1,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
      comparisonBaseline: "none",
      chartOverlayPrefs: {},
      selectedScoreRings: ["MED_COMPLIANCE"],
      heroRingOrder: ["HEALTH_SCORE", "MED_COMPLIANCE"],
      enabledHeroItemKinds: [...PRIORITY_ITEM_KINDS],
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    };
  }

  it("guards the write on the base token and returns the advanced token", async () => {
    const base = new Date("2026-07-24T10:00:00.000Z");
    const advanced = new Date("2026-07-24T10:05:00.000Z");
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    // The post-write token read.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      updatedAt: advanced,
    } as never);

    const res = await callPut(makeReq(fullLayoutBody(base.toISOString())));
    expect(res.status).toBe(200);

    // Wrote conditionally on the exact base token — never unconditionally.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect(whereArg.id).toBe("user-1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(base.toISOString());
    expect(prisma.user.update).not.toHaveBeenCalled();

    // The response echoes the advanced token so the client can rebase.
    const body = (await res.json()) as { data: { updatedAt: string } };
    expect(body.data.updatedAt).toBe(advanced.toISOString());
  });

  it("rejects a stale base token with 409 and writes nothing", async () => {
    // The guarded update matches zero rows — someone advanced updatedAt.
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await callPut(
      makeReq(fullLayoutBody("2026-07-24T09:00:00.000Z")),
    );
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("dashboard_layout_conflict");

    // The conditional write matched no row; there is NO unconditional
    // fallback, so the stored layout is left exactly as it was.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await callPut(makeReq(fullLayoutBody("not-a-date")));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the client omits the token", async () => {
    // Backward-compatible path for older web builds / the native client.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await callPut(makeReq(fullLayoutBody()));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const body = (await res.json()) as { data: { updatedAt: string } };
    expect(body.data.updatedAt).toBe("2026-07-24T11:00:00.000Z");
  });
});

describe("DELETE /api/dashboard/widgets — web-owned reset scope", () => {
  it("resets tiles and Today highlights while preserving stored advanced preferences", async () => {
    const stored = serializeDashboardLayout({
      ...DEFAULT_DASHBOARD_LAYOUT,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((widget, order) => ({
        ...widget,
        visible: false,
        tileVisible: false,
        order: DEFAULT_DASHBOARD_LAYOUT.widgets.length - order,
      })),
      comparisonBaseline: "lastYear",
      chartOverlayPrefs: {
        weight: {
          showTrendIndicator: true,
          showTrendArrow: true,
          showTargetRange: false,
          comparisonBaseline: "lastMonth",
          rangePoints: 90,
        },
      },
      selectedScoreRings: ["READINESS", "SLEEP_SCORE"],
      heroRingOrder: ["SLEEP_SCORE", "HEALTH_SCORE", "READINESS"],
      enabledHeroItemKinds: ["milestone"],
      todayCardVisible: false,
    });
    expect(stored.todayCardVisible).toBe(false);
    const advanced = new Date("2026-07-24T12:00:00.000Z");
    transactionUser.findUnique.mockResolvedValue({
      dashboardWidgetsJson: stored,
    });
    transactionUser.update.mockResolvedValue({ updatedAt: advanced });

    const res = await callDelete();
    expect(res.status).toBe(200);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(vi.mocked(prisma.$transaction).mock.calls[0]?.[1]).toEqual({
      isolationLevel: "Serializable",
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(transactionUser.findUnique).toHaveBeenCalledOnce();
    expect(transactionUser.update).toHaveBeenCalledOnce();

    const updateArg = transactionUser.update.mock.calls[0]?.[0] as {
      data: { dashboardWidgetsJson: DashboardLayout };
      select: { updatedAt: true };
    };
    expect(updateArg.select).toEqual({ updatedAt: true });
    const persisted = updateArg.data.dashboardWidgetsJson;
    expect(persisted.widgets).toEqual(DEFAULT_DASHBOARD_LAYOUT.widgets);
    expect(
      Object.prototype.hasOwnProperty.call(persisted, "enabledHeroItemKinds"),
    ).toBe(false);
    // A reset brings a hidden top card back; shown is stored by omission.
    expect(
      Object.prototype.hasOwnProperty.call(persisted, "todayCardVisible"),
    ).toBe(false);
    expect(persisted.comparisonBaseline).toBe("lastYear");
    expect(persisted.chartOverlayPrefs).toEqual({
      weight: {
        showTrendIndicator: true,
        showTrendArrow: true,
        showTargetRange: false,
        comparisonBaseline: "lastMonth",
        rangePoints: 90,
      },
    });
    expect(persisted.selectedScoreRings).toEqual(["READINESS", "SLEEP_SCORE"]);
    expect(persisted.heroRingOrder).toEqual([
      "SLEEP_SCORE",
      "HEALTH_SCORE",
      "READINESS",
    ]);

    const body = (await res.json()) as { data: DashboardLayoutWithToken };
    expect(body.data.widgets).toEqual(DEFAULT_DASHBOARD_LAYOUT.widgets);
    expect(body.data.enabledHeroItemKinds).toEqual([...PRIORITY_ITEM_KINDS]);
    expect(body.data.comparisonBaseline).toBe("lastYear");
    expect(body.data.chartOverlayPrefs).toEqual(persisted.chartOverlayPrefs);
    expect(body.data.selectedScoreRings).toEqual(persisted.selectedScoreRings);
    expect(body.data.heroRingOrder).toEqual(persisted.heroRingOrder);
    expect(body.data.updatedAt).toBe(advanced.toISOString());
  });
});

describe("dashboard widgets — hero primary content", () => {
  const weightOnly = [
    { id: "weight" as const, visible: true, tileVisible: true, order: 0 },
  ];

  it("accepts and persists hero: 'reminders'", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, widgets: weightOnly, hero: "reminders" }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { hero?: string } };
    };
    expect(updateArg.data.dashboardWidgetsJson.hero).toBe("reminders");

    const body = (await res.json()) as { data: { hero?: string } };
    expect(body.data.hero).toBe("reminders");
  });

  it("rejects a hero value outside the closed enum with 422", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, widgets: weightOnly, hero: "banner" }),
    );
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("keeps the stored hero choice when the client omits the field", async () => {
    // A layout save from a client that predates the field (the native
    // client, or a stale web tab) must not silently reset the choice.
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: weightOnly,
      hero: "reminders",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(makeReq({ version: 1, widgets: weightOnly }));
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { hero?: string } };
    };
    expect(updateArg.data.dashboardWidgetsJson.hero).toBe("reminders");
  });

  it("honours an explicitly sent 'score' over the stored 'reminders'", async () => {
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: weightOnly,
      hero: "reminders",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, widgets: weightOnly, hero: "score" }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { hero?: string } };
    };
    // "score" is the default and serializes as an omitted field.
    expect(updateArg.data.dashboardWidgetsJson.hero).toBeUndefined();

    const body = (await res.json()) as { data: { hero?: string } };
    expect(body.data.hero).toBeUndefined();
  });
});

describe("dashboard widgets — the top card switch", () => {
  const weightOnly = [
    { id: "weight" as const, visible: true, tileVisible: true, order: 0 },
  ];

  function persistedLayout() {
    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { todayCardVisible?: boolean } };
    };
    return updateArg.data.dashboardWidgetsJson;
  }

  it("accepts and persists todayCardVisible: false", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, widgets: weightOnly, todayCardVisible: false }),
    );
    expect(res.status).toBe(200);
    expect(persistedLayout().todayCardVisible).toBe(false);
    const body = (await res.json()) as {
      data: { todayCardVisible?: boolean };
    };
    expect(body.data.todayCardVisible).toBe(false);
  });

  it("rejects a non-boolean with 422", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, widgets: weightOnly, todayCardVisible: "no" }),
    );
    expect(res.status).toBe(422);
    expect(vi.mocked(prisma.user.update)).not.toHaveBeenCalled();
  });

  it("keeps a hidden top card hidden when the client omits the field", async () => {
    // A save from a client that predates the field must not bring it back.
    const stored = serializeDashboardLayout({
      version: 1,
      widgets: weightOnly,
      todayCardVisible: false,
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(makeReq({ version: 1, widgets: weightOnly }));
    expect(res.status).toBe(200);
    expect(persistedLayout().todayCardVisible).toBe(false);
  });

  it("stores showing it again as the omitted default", async () => {
    const stored = serializeDashboardLayout({
      version: 1,
      widgets: weightOnly,
      todayCardVisible: false,
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({ version: 1, widgets: weightOnly, todayCardVisible: true }),
    );
    expect(res.status).toBe(200);
    expect(persistedLayout()).not.toHaveProperty("todayCardVisible");
  });

  it("GET answers true for a layout that never chose", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: serializeDashboardLayout(DEFAULT_DASHBOARD_LAYOUT),
    } as never);
    const res = await callGet();
    const body = (await res.json()) as {
      data: { todayCardVisible?: boolean };
    };
    expect(body.data.todayCardVisible).toBe(true);
  });
});

describe("a toggle that cannot do anything is not offered", () => {
  // A switch that is on over a tile that can never paint, with nothing
  // saying why, is the defect the HRV fallback exists to remove — so the
  // GET tells the client which toggles are dead rather than leaving the
  // Settings screen to draw one.
  //
  // `hrv` falls back to nightly RMSSD when an account has no SDNN, and
  // RMSSD is recovery-owned. Recovery off + no SDNN = a dead switch.
  function storeLayout() {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: serializeDashboardLayout(DEFAULT_DASHBOARD_LAYOUT),
    } as never);
  }

  async function getBody() {
    const res = await callGet();
    expect(res.status).toBe(200);
    return (await res.json()) as {
      data: { unavailableWidgetIds?: string[] };
    };
  }

  it("marks hrv unavailable for a ring account with recovery off", async () => {
    storeLayout();
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue(null as never);

    expect((await getBody()).data.unavailableWidgetIds).toEqual(["hrv"]);
  });

  it("leaves hrv available when the account has SDNN", async () => {
    // SDNN is a plain vital no module owns, so the tile still works with
    // recovery off. Taking this row away would be a new bug.
    storeLayout();
    vi.mocked(isModuleEnabled).mockResolvedValue(false);
    vi.mocked(prisma.measurement.findFirst).mockResolvedValue({
      id: "m1",
    } as never);

    expect((await getBody()).data.unavailableWidgetIds).toBeUndefined();
  });

  it("does not probe for SDNN at all when recovery is on", async () => {
    // The probe is the only added read on this hot, cached route; it must
    // not run for the common account.
    storeLayout();
    vi.mocked(isModuleEnabled).mockResolvedValue(true);
    vi.mocked(prisma.measurement.findFirst).mockClear();

    expect((await getBody()).data.unavailableWidgetIds).toBeUndefined();
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
  });
});
