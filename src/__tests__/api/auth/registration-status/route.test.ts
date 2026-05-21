/**
 * v1.4.40 W-INSIGHTS SB-7 — pin the four discovery branches of
 * `GET /api/auth/registration-status`.
 *
 * The route is read-only; the iOS sign-in flow + the web onboarding
 * dispatcher both depend on its envelope shape (`registrationEnabled`
 * boolean) staying byte-stable. A regression that flipped the
 * fail-closed branch to fail-open would silently allow registration on
 * a self-hosted deployment whose admin set `registrationEnabled: false`
 * and an upstream DB blip lost the row.
 *
 * Four branches walked:
 *
 *   1. **Singleton row exists with `registrationEnabled: true`** →
 *      envelope reports `true`.
 *   2. **Singleton row exists with `registrationEnabled: false`** →
 *      envelope reports `false`. (Admin-disabled tenant — invite-only.)
 *   3. **Singleton row missing (`findUnique` returns `null`)** →
 *      envelope reports the schema default `true` (open registration —
 *      the no-config baseline for a fresh self-hosted instance).
 *   4. **`findUnique` throws** (DB outage / connection drop) → envelope
 *      fails closed with `false`. Critical: a DB blip on a tenant
 *      that has disabled registration must NOT unlock the sign-up
 *      flow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "@/app/api/auth/registration-status/route";
import { prisma } from "@/lib/db";

const callGet = GET as unknown as (...args: never[]) => Promise<Response>;

interface RegistrationStatusBody {
  data: { registrationEnabled: boolean };
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/auth/registration-status", () => {
  it("reports `true` when the singleton row carries registrationEnabled: true", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      id: "singleton",
      registrationEnabled: true,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistrationStatusBody;
    expect(body.data.registrationEnabled).toBe(true);
  });

  it("reports `false` when the singleton row carries registrationEnabled: false (admin-disabled tenant)", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      id: "singleton",
      registrationEnabled: false,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistrationStatusBody;
    expect(body.data.registrationEnabled).toBe(false);
  });

  it("falls back to the schema default `true` when the singleton row is missing (fresh self-hosted instance)", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistrationStatusBody;
    expect(body.data.registrationEnabled).toBe(true);
  });

  it("fails closed with `false` when the DB lookup throws (defense-in-depth against silent unlock)", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockRejectedValue(
      new Error("connection terminated"),
    );

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistrationStatusBody;
    expect(body.data.registrationEnabled).toBe(false);
  });
});
