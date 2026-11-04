/**
 * `GET /api/sync/changes?start=now` (#1339) — a cursor at the present.
 *
 * The answer is an empty page whose cursor sits at `serverNow` in every
 * domain, in the feed's own opaque format, and nothing is read: the point is
 * to skip the history walk, so a read here would be the bug. The database is
 * deliberately not mocked and not reachable: any read would fail the request,
 * so the 200 below is itself the proof that none happened.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: vi.fn() }));
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
import { checkRateLimit } from "@/lib/rate-limit";
import {
  decodeCursor,
  decodeCursorIssuedAt,
  SYNC_DOMAINS,
} from "@/lib/sync/cursor";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/sync/changes${query}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(
    SESSION_OK as Awaited<ReturnType<typeof getSession>>,
  );
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 119,
    resetAt: Date.now() + 60_000,
  } as Awaited<ReturnType<typeof checkRateLimit>>);
});

describe("GET /api/sync/changes?start=now", () => {
  it("answers an empty page with a cursor at serverNow in every domain", async () => {
    const before = Date.now();
    const res = await GET(req("?start=now"));
    const after = Date.now();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        serverNow: string;
        cursor: string;
        hasMore: boolean;
        cursorExpired: boolean;
        changes: Record<string, { upserts: unknown[]; tombstones: unknown[] }>;
      };
    };
    expect(data.hasMore).toBe(false);
    expect(data.cursorExpired).toBe(false);
    expect(Object.keys(data.changes).sort()).toEqual([...SYNC_DOMAINS].sort());
    for (const block of Object.values(data.changes)) {
      expect(block).toEqual({ upserts: [], tombstones: [] });
    }
    const nowMs = Date.parse(data.serverNow);
    expect(nowMs).toBeGreaterThanOrEqual(before);
    expect(nowMs).toBeLessThanOrEqual(after);
    const cursor = decodeCursor(data.cursor);
    expect(cursor).not.toBeNull();
    for (const domain of SYNC_DOMAINS) {
      expect(cursor![domain], domain).toEqual({ updatedAtMs: nowMs, id: "0" });
    }
    expect(decodeCursorIssuedAt(data.cursor)).toBe(nowMs);
  });

  it("refuses start together with a cursor, and any start value but now", async () => {
    const both = await GET(req("?start=now&cursor=abc"));
    expect(both.status).toBe(422);
    const other = await GET(req("?start=oldest"));
    expect(other.status).toBe(422);
  });

  it("still requires a session", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(req("?start=now"));
    expect(res.status).toBe(401);
  });
});
