/**
 * The account lookup by e-mail or username against real Postgres: exact
 * equality regardless of case, never a pattern.
 *
 * Prisma's `{ equals, mode: "insensitive" }` compiles to `ILIKE`, so `_` and
 * `%` in a typed name were wildcards: `%` found any account, `a_ice` found
 * `alice`, and an invitation meant for `j_doe` could reach `jxdoe`. The lookup
 * is `lower(col) = lower($1)` now, which is also the expression the case-blind
 * unique keys of migration 0517 are built on; the plan check below shows the
 * lookup reads those keys.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-test-hmac-key-test-hmac-key-0123456789";

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

const prisma = getPrismaClient();
const { findUserIdByEmail, findUserIdByUsername, findUserIdBySignInName } =
  await import("@/lib/auth/identity-lookup");
const { accountNameTaken } = await import("@/lib/auth/account-name-taken");
const { hashPassword } = await import("@/lib/auth/password");

const PASSWORD = "Correct horse battery staple!42";

let alice: string;
let jxdoe: string;

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  alice = (
    await prisma.user.create({
      data: {
        username: "alice",
        email: "alice@example.com",
        passwordHash: await hashPassword(PASSWORD),
      },
    })
  ).id;
  jxdoe = (
    await prisma.user.create({
      data: { username: "jxdoe", email: "jxdoe@example.com" },
    })
  ).id;
});

describe("identity lookup", () => {
  it("matches regardless of case", async () => {
    expect(await findUserIdByUsername("ALICE")).toBe(alice);
    expect(await findUserIdByEmail("Alice@Example.COM")).toBe(alice);
    expect(await findUserIdBySignInName("Alice")).toBe(alice);
    expect(await findUserIdBySignInName("ALICE@example.com")).toBe(alice);
  });

  it("treats % and _ as the characters they are, not as wildcards", async () => {
    for (const typed of ["%", "a%", "a_ice", "_lice", "%lice"]) {
      expect(await findUserIdByUsername(typed)).toBeNull();
      expect(await findUserIdBySignInName(typed)).toBeNull();
    }
    for (const typed of ["%@example.com", "a_ice@example.com", "%"]) {
      expect(await findUserIdByEmail(typed)).toBeNull();
      expect(await findUserIdBySignInName(typed)).toBeNull();
    }
    expect(await accountNameTaken("%@example.com", "a_ice")).toBe(false);
  });

  it("finds j_doe and never jxdoe for j_doe", async () => {
    expect(await findUserIdByUsername("j_doe")).toBeNull();
    expect(await findUserIdBySignInName("j_doe")).toBeNull();
    const jDoe = (
      await prisma.user.create({
        data: { username: "j_doe", email: "j_doe@example.com" },
      })
    ).id;
    expect(await findUserIdByUsername("j_doe")).toBe(jDoe);
    expect(await findUserIdBySignInName("J_DOE")).toBe(jDoe);
    expect(await findUserIdByEmail("j_doe@example.com")).toBe(jDoe);
    expect(await findUserIdByUsername("jxdoe")).toBe(jxdoe);
  });

  it("leaves the excluded account out of the e-mail probe", async () => {
    expect(
      await findUserIdByEmail("ALICE@example.com", { excludeId: alice }),
    ).toBeNull();
    expect(
      await findUserIdByEmail("alice@example.com", { excludeId: jxdoe }),
    ).toBe(alice);
  });

  it("reads the 0517 case-blind keys", async () => {
    // Two rows: the planner prefers a sequential scan on a table this small
    // whatever the index, so the scan is switched off to ask whether the
    // index CAN serve the expression. A pattern match (`ILIKE`) could not.
    const plans = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const plan = async (rows: Promise<Array<{ "QUERY PLAN": string }>>) =>
        (await rows).map((r) => r["QUERY PLAN"]).join("\n");
      return {
        email: await plan(
          tx.$queryRaw`EXPLAIN SELECT "id" FROM "users" WHERE lower("email") = lower(${"a@example.com"}) LIMIT 1`,
        ),
        username: await plan(
          tx.$queryRaw`EXPLAIN SELECT "id" FROM "users" WHERE lower("username") = lower(${"alice"}) LIMIT 1`,
        ),
        either: await plan(
          tx.$queryRaw`EXPLAIN SELECT "id" FROM "users" WHERE lower("email") = lower(${"alice"}) OR lower("username") = lower(${"alice"}) LIMIT 1`,
        ),
      };
    });
    expect(plans.email).toContain("users_email_lower_key");
    expect(plans.username).toContain("users_username_lower_key");
    expect(plans.either).toContain("users_email_lower_key");
    expect(plans.either).toContain("users_username_lower_key");
  });
});

describe("POST /api/auth/login with a pattern for a name", () => {
  async function login(email: string) {
    const { POST } = await import("@/app/api/auth/login/route");
    return POST(
      new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
  }

  it("signs nobody in with % or a_ice, and alice with her own name", async () => {
    for (const typed of ["%", "a_ice", "%@example.com"]) {
      expect((await login(typed)).status).toBe(401);
    }
    expect(await prisma.session.count()).toBe(0);
    const res = await login("ALICE");
    expect(res.status).toBe(200);
    expect(await prisma.session.count({ where: { userId: alice } })).toBe(1);
  });
});
