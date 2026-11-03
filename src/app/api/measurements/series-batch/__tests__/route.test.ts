/**
 * v1.18.6 — `GET /api/measurements/series-batch` unit + parity tests.
 *
 * The endpoint reads each requested type through the SHARED
 * `readDailySeries` reader — the exact same reader the single-type
 * `GET /api/measurements?aggregate=daily&source=rollup` route delegates
 * to (see `src/app/api/measurements/route.ts`). The parity guarantee is
 * therefore structural: both routes call `readDailySeries`, so the rows
 * are identical by construction. These tests pin that the batch route
 * (a) validates its query, (b) calls the reader once per requested type
 * with the right window, and (c) returns each type's reader output
 * verbatim under `series[type]`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
vi.mock("@/lib/measurements/daily-series-read", () => ({
  readDailySeries: vi.fn(),
}));

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { readDailySeries } from "@/lib/measurements/daily-series-read";

const SESSION_OK = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "u", role: "USER" as const },
};

const FROM = "2026-05-01T00:00:00.000Z";
const TO = "2026-05-31T23:59:59.000Z";

function req(query: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/measurements/series-batch?${query}`,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("GET /api/measurements/series-batch", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req(`types=WEIGHT&from=${FROM}&to=${TO}`));
    expect(res.status).toBe(401);
  });

  it("returns 422 when types is missing", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req(`from=${FROM}&to=${TO}`));
    expect(res.status).toBe(422);
  });

  it("returns 422 for an unknown type", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(req(`types=GARBAGE&from=${FROM}&to=${TO}`));
    expect(res.status).toBe(422);
  });

  it("reads each type through readDailySeries and keys the result by type", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const weightRows = [
      { type: "WEIGHT", value: 80, measuredAt: FROM, count: 1 },
    ];
    const bpRows = [
      { type: "BLOOD_PRESSURE_SYS", value: 126, measuredAt: FROM, count: 1 },
    ];
    vi.mocked(readDailySeries).mockImplementation(async ({ type }) => {
      if (type === "WEIGHT") return weightRows as never;
      if (type === "BLOOD_PRESSURE_SYS") return bpRows as never;
      return [] as never;
    });

    const res = await GET(
      req(`types=WEIGHT,BLOOD_PRESSURE_SYS&from=${FROM}&to=${TO}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.series.WEIGHT).toEqual(weightRows);
    expect(body.data.series.BLOOD_PRESSURE_SYS).toEqual(bpRows);

    // One reader call per unique type, with the parsed window.
    expect(vi.mocked(readDailySeries)).toHaveBeenCalledTimes(2);
    const call = vi.mocked(readDailySeries).mock.calls[0][0];
    expect(call.userId).toBe("user-1");
    expect(call.from.toISOString()).toBe(FROM);
    expect(call.to.toISOString()).toBe(TO);
  });

  it("de-dupes a repeated type to one reader call", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(readDailySeries).mockResolvedValue([] as never);
    const res = await GET(req(`types=WEIGHT,WEIGHT&from=${FROM}&to=${TO}`));
    expect(res.status).toBe(200);
    expect(vi.mocked(readDailySeries)).toHaveBeenCalledTimes(1);
  });

  it("isolates a single type's failure to an empty slice, others still return", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const weightRows = [
      { type: "WEIGHT", value: 80, measuredAt: FROM, count: 1 },
    ];
    vi.mocked(readDailySeries).mockImplementation(async ({ type }) => {
      if (type === "WEIGHT") return weightRows as never;
      throw new Error("transient db reject");
    });

    const res = await GET(
      req(`types=WEIGHT,BLOOD_PRESSURE_SYS&from=${FROM}&to=${TO}`),
    );
    // One type rejecting must NOT 500 the whole batch.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.series.WEIGHT).toEqual(weightRows);
    expect(body.data.series.BLOOD_PRESSURE_SYS).toEqual([]);
  });
});
