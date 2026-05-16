import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { MEASUREMENT_CATEGORIES } from "@/lib/measurements/categories";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function req(): NextRequest {
  return new NextRequest("http://localhost/api/measurement-categories", {
    method: "GET",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/measurement-categories", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("returns the categories + assignments envelope to a logged-in user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        version: number;
        categories: Array<{ id: string; labelKey: string; order: number }>;
        assignments: Record<string, string>;
      };
      error: null;
    };

    expect(body.error).toBeNull();
    expect(body.data.version).toBe(1);
    expect(body.data.categories.length).toBe(8);
    // Stable order — vitals first, metabolic last.
    expect(body.data.categories[0]).toEqual({
      id: "vitals",
      labelKey: "categories.vitals",
      order: 0,
    });
    expect(body.data.categories.at(-1)).toEqual({
      id: "metabolic",
      labelKey: "categories.metabolic",
      order: 7,
    });
    // Every category carries a `categories.<id>` translation key.
    for (const entry of body.data.categories) {
      expect(entry.labelKey).toBe(`categories.${entry.id}`);
    }
  });

  it("returns an assignments map covering every MeasurementType in the overlay", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req());
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { assignments: Record<string, string> };
    };

    // Parity with the source map — the endpoint is a thin projection,
    // so the assignment count and per-key category must match exactly.
    expect(Object.keys(body.data.assignments).length).toBe(
      MEASUREMENT_CATEGORIES.size,
    );
    for (const [type, category] of MEASUREMENT_CATEGORIES) {
      expect(body.data.assignments[type]).toBe(category);
    }
  });

  it("sets the 10-minute public cache header", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=600");
  });
});
