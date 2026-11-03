/**
 * `GET /api/admin/support-report` against real Postgres.
 *
 *   - admin only, through the real `apiHandler` and `requireAdmin`;
 *   - the raw reads (server version, time zone, size, the migrations table,
 *     the queue) and the group-bys run against the real schema;
 *   - accounts with distinctive usernames, emails and names appear only as
 *     "Account n", and their ids never.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

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

import { GET } from "@/app/api/admin/support-report/route";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

function call() {
  const route = GET as unknown as (request: NextRequest) => Promise<Response>;
  return route(new NextRequest("http://localhost/api/admin/support-report"));
}

describe("GET /api/admin/support-report (integration)", () => {
  it("refuses a signed-in non-admin", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "plainmember", email: "plain.member@example.test" },
    });
    await signIn(user.id);
    const res = await call();
    expect(res.status).toBe(403);
  });

  it("answers a redacted report built from the real schema", async () => {
    const prisma = getPrismaClient();
    const admin = await prisma.user.create({
      data: {
        username: "operatorwithaname",
        email: "operator.distinct@example.test",
        fullName: "Ottilie Operatorson",
        role: "ADMIN",
      },
    });
    const member = await prisma.user.create({
      data: {
        username: "memberwithaname",
        email: "member.distinct@example.test",
        fullName: "Mathilda Memberson",
      },
    });
    await prisma.providerHealth.create({
      data: {
        userId: member.id,
        providerType: "LOCAL",
        lastResult: "auth_failed",
        lastStatus: 401,
        consecutiveFailures: 3,
        lastFailureAt: new Date(),
        nextRetryAt: new Date(Date.now() + 3_600_000),
      },
    });
    await prisma.integrationWatch.create({
      data: {
        userId: member.id,
        integration: "nightscout",
        incidentReason: "unexpected_silence",
        incidentOpenedAt: new Date(),
      },
    });
    await prisma.pushAttempt.create({
      data: {
        userId: member.id,
        channel: "NTFY",
        eventType: "MEDICATION_REMINDER",
        result: "error",
        reason: "http_500",
      },
    });
    await signIn(admin.id);

    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    const text: string = body.data.text;

    expect(text).toMatch(/- PostgreSQL: \d+/);
    expect(text).toMatch(/- Server time zone: \S+/);
    expect(text).toMatch(/- Size: \d+ MB/);
    expect(text).toMatch(/- Last migration: \d{4}_\w+ \(/);
    expect(text).toContain("- Unfinished migrations: 0");
    expect(text).toContain(
      "- LOCAL: ok 0, failing 0, credential refused 1, paused 1",
    );
    expect(text).toContain("nightscout: unexpected_silence since");
    expect(text).toContain("Account 2");
    expect(text).toContain("- NTFY: ok 0, failed 1, skipped 0; http_500 1");
    expect(text).toContain("- Accounts: 2");

    for (const value of [
      admin.id,
      member.id,
      admin.username,
      member.username,
      admin.email!,
      member.email!,
      "Ottilie",
      "Mathilda",
    ]) {
      expect(text.toLowerCase(), value).not.toContain(value.toLowerCase());
    }
  });
});
