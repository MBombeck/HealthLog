/**
 * The bytes a client actually receives from an idempotency 409.
 *
 * `POST /api/anamnesis/facts` is the route the drift was reported against
 * (iOS #75), but nothing here is specific to it — the 409 comes from
 * `withIdempotency`, so every route under that wrapper serves the same
 * envelope. Until v1.35.1 both in-flight arms sent `error` as
 * `{ message: … }`, the only object-shaped error the app emitted and not the
 * `{ data, error: <string> }` envelope the published contract promises.
 *
 * This runs the REAL chain — the real route module, the real `apiHandler`,
 * the real `withIdempotency` — with only the data layer and the session
 * mocked, and asserts on the parsed response body. A schema test would not
 * have caught this: the schema was already right.
 *
 * Both 409 arms are covered:
 *   - a `PENDING_STATUS` row already in the table (the in-flight lookup);
 *   - a lost claim race (the row appears between the lookup and the insert).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEYS", "");
vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
vi.stubEnv("ENCRYPTION_KEY", "0".repeat(64));

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  getSession: vi.fn(),
  createFact: vi.fn(),
  factFindFirst: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    idempotencyKey: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      deleteMany: mocks.deleteMany,
      updateMany: mocks.updateMany,
      delete: vi.fn(),
      update: vi.fn(),
    },
    apiToken: { findUnique: vi.fn() },
    healthProfileFactRevision: { findFirst: mocks.factFindFirst },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/profile/health-facts", () => ({
  readHealthProfileFacts: vi.fn(),
  createHealthProfileFact: mocks.createFact,
  correctHealthProfileFact: vi.fn(),
  removeHealthProfileFact: vi.fn(),
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { requestFingerprint } from "@/lib/idempotency";

/** The pending sentinel `findCached` recognises as "another call is running". */
const PENDING_STATUS = 0;

const BODY = JSON.stringify({ kind: "SMOKING_STATUS", value: "FORMER" });

function request(): NextRequest {
  return new NextRequest("http://localhost/api/anamnesis/facts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "key-in-flight",
    },
    body: BODY,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The whole shape `getSession()` returns. The session half carries the
  // acting-account carrier, which the idempotency wrapper reads to decide
  // whose record a cell belongs to — a fake that omitted it made the wrapper
  // fail on a field production always has.
  mocks.getSession.mockResolvedValue({
    session: {
      id: "session-1",
      expiresAt: new Date(Date.now() + 60_000),
      actingAsUserId: null,
    },
    user: { id: "user-1", role: "USER" },
  });
  mocks.findUnique.mockResolvedValue(null);
  mocks.create.mockResolvedValue({});
  mocks.deleteMany.mockResolvedValue({ count: 0 });
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.factFindFirst.mockResolvedValue(null);
  mocks.createFact.mockResolvedValue({ id: "fact-1" });
});

describe("idempotency 409 envelope, over the real route", () => {
  it("serves `error` as a string when a request is already in flight", async () => {
    mocks.findUnique.mockResolvedValue({
      id: "idem-1",
      // The same request in flight: a different body would run instead.
      requestFingerprint: requestFingerprint(
        "POST",
        "/api/anamnesis/facts",
        new TextEncoder().encode(BODY),
      ),
      responseStatus: PENDING_STATUS,
      responseBody: "",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.data).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe(
      "A request with this Idempotency-Key is already in progress",
    );
    // The shape the drift produced, named explicitly so a revert cannot
    // pass by satisfying only the `typeof` check above.
    expect(body.error).not.toHaveProperty("message");
    expect(response.headers.get("X-Idempotent-Replay")).toBe("false");
    // The side effect must not have run on a refused call.
    expect(mocks.createFact).not.toHaveBeenCalled();
  });

  it("serves `error` as a string when the claim race is lost", async () => {
    // No row on lookup, but the claiming insert collides with the racing
    // request that got there first.
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.data).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe(
      "A request with this Idempotency-Key is already in progress",
    );
    expect(body.error).not.toHaveProperty("message");
    expect(response.headers.get("X-Idempotent-Replay")).toBe("false");
    expect(mocks.createFact).not.toHaveBeenCalled();
  });
});
