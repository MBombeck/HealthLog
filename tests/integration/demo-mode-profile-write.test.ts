/**
 * v1.39 — what `PUT /api/auth/profile` may write on a demo instance.
 *
 * The route is on the proxy's `DEMO_MUTATION_ALLOWLIST` so the setup flow's
 * baseline step can complete in the demo. That allowlist is an EDGE control:
 * it decides which path and method get through, and once a path is through,
 * every field that route writes is writable. This route writes the account's
 * contact email, its display name, its full name and its insurer fields — and
 * the demo is one published account that every visitor signs into, so any of
 * them lands on the record the next visitor sees.
 *
 * The narrowing therefore cannot live in the client. It is a server-side
 * field filter in `applyProfileUpdate`, and this file proves it against real
 * Postgres rather than against a status code: the route answers 200 either
 * way — it answered 200 while writing the email — so the verdict has to be
 * read back off the row.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

/** What the shared demo account carries before any visitor touches it. */
const SEEDED = {
  username: "demo",
  email: "demo@healthlog.test",
  displayName: "HealthLog Demo",
  fullName: "Demo Person",
  insurerName: "Demo Krankenkasse",
};

/** What a visitor could put on the shared record through this one route. */
const HOSTILE = {
  email: "attacker@example.test",
  displayName: "Owned",
  fullName: "Attacker",
  insurerName: "Attacker Insurance",
};

/** The three the baseline step exists to collect, and the only three
 *  the demo may write. */
const BASELINE = {
  heightCm: 181,
  dateOfBirth: "1988-04-12",
  gender: "FEMALE" as const,
};

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
});

async function seedSignedInAccount(): Promise<string> {
  const { hashPassword } = await import("@/lib/auth/password");
  const { createSession } = await import("@/lib/auth/session");
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      ...SEEDED,
      role: "USER",
      passwordHash: await hashPassword("DemoStrongP@ssw0rd!123abc"),
    },
  });
  await createSession(user.id, false);
  return user.id;
}

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putProfile(body: unknown): Promise<number> {
  const { PUT } = await import("@/app/api/auth/profile/route");
  const res = await PUT(makeRequest(body));
  return res.status;
}

describe("PUT /api/auth/profile under DEMO_MODE (real Postgres)", () => {
  it("writes the baseline fields and drops everything else", async () => {
    process.env.DEMO_MODE = "true";
    const userId = await seedSignedInAccount();

    // Everything in one body, exactly as a visitor could send it. The client
    // never offers these, which is precisely why the client cannot be the
    // control: this request does not come from the client.
    const status = await putProfile({ ...HOSTILE, ...BASELINE });
    expect(status).toBe(200);

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
    });

    // The record the next visitor sees is the record the reseed left.
    expect(row.email).toBe(SEEDED.email);
    expect(row.displayName).toBe(SEEDED.displayName);
    expect(row.fullName).toBe(SEEDED.fullName);
    expect(row.insurerName).toBe(SEEDED.insurerName);

    // And the step the allowlist entry exists for still completes.
    expect(row.heightCm).toBe(BASELINE.heightCm);
    expect(row.gender).toBe(BASELINE.gender);
    expect(row.dateOfBirth?.toISOString().slice(0, 10)).toBe(
      BASELINE.dateOfBirth,
    );
  });

  it("does not answer the 'is this email taken?' question either", async () => {
    // The conflict check runs before the write and 409s on a taken address.
    // On a public demo that is an existence oracle over the instance's
    // accounts, so the narrowing has to happen ahead of it, not after.
    process.env.DEMO_MODE = "true";
    const prisma = getPrismaClient();
    await seedSignedInAccount();
    await prisma.user.create({
      data: {
        username: "someone-else",
        email: "taken@healthlog.test",
        role: "USER",
        passwordHash: "x",
      },
    });

    expect(await putProfile({ email: "taken@healthlog.test" })).toBe(200);
  });

  it("writes every field on an ordinary instance — the gate is demo mode, not the route", async () => {
    delete process.env.DEMO_MODE;
    const userId = await seedSignedInAccount();

    expect(await putProfile({ ...HOSTILE, ...BASELINE })).toBe(200);

    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(row.email).toBe(HOSTILE.email);
    expect(row.displayName).toBe(HOSTILE.displayName);
    expect(row.fullName).toBe(HOSTILE.fullName);
    expect(row.insurerName).toBe(HOSTILE.insurerName);
    expect(row.heightCm).toBe(BASELINE.heightCm);
  });
});
