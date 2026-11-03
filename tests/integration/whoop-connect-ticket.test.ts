/**
 * v1.12.2 — integration coverage for the WHOOP connect-in-app enhancements
 * against real Postgres:
 *
 *   - POST /api/whoop/connect/ticket (Bearer-auth) mints a single-use ticket;
 *     only its HMAC hash lands in `whoop_connect_tickets`, the raw value never.
 *   - GET /api/whoop/connect?ticket=<raw> resolves the user from the ticket IN
 *     LIEU of a session cookie, consumes it (consumedAt stamped), and 302s to
 *     WHOOP, stamping the `whoop_state` ledger row + nonce cookie.
 *   - A SECOND presentation of the same ticket is rejected (typed 401).
 *   - An expired ticket is rejected (typed 401).
 *   - `?return_scheme=dev.healthlog.app` is validated + persisted on the state
 *     row so the callback can drive the native custom-scheme redirect.
 *
 * The whole point of the ticket is the native-only user with NO web session
 * cookie, so the connect call below carries no cookie at all.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

// Seed deterministic keys before any module that reads them lazily.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-whoop-connect-ticket-integration-32-bytes-12345678";

const { hashToken } = await import("@/lib/auth/hmac");

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

const TEST_USER_ID = "user-whoop-connect-ticket";
const RAW_BEARER = "hlk_whoopconnectticketintegrationrawtokenvalue00000001";
const WHOOP_AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();

  const { encrypt } = await import("@/lib/crypto");
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "whoop-ticket-user",
      email: "whoop-ticket@example.test",
      role: "USER",
      whoopClientIdEncrypted: encrypt("whoop-client-id"),
      whoopClientSecretEncrypted: encrypt("whoop-client-secret"),
    },
  });
  // Bearer token for the native client minting the ticket.
  await prisma.apiToken.create({
    data: {
      userId: TEST_USER_ID,
      name: "native",
      tokenHash: hashToken(RAW_BEARER),
      permissions: ["*"],
    },
  });

  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function mintTicketViaBearer(): Promise<string> {
  // Bearer only — no session cookie.
  headerJar.set("authorization", `Bearer ${RAW_BEARER}`);
  const { POST } = await import("@/app/api/whoop/connect/ticket/route");
  const res = await (POST as unknown as () => Promise<Response>)();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { ticket: string } };
  headerJar.delete("authorization");
  return body.data.ticket;
}

describe("WHOOP connect ticket lifecycle (real Postgres)", () => {
  it("mints a ticket storing only its hash, never the raw value", async () => {
    const ticket = await mintTicketViaBearer();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const prisma = getPrismaClient();
    const rows = await prisma.whoopConnectTicket.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(ticket));
    expect(rows[0].consumedAt).toBeNull();
    // The raw ticket is not stored in any column.
    expect(JSON.stringify(rows[0])).not.toContain(ticket);
  });

  it("connect?ticket=<raw> consumes the ticket (no cookie) and 302s to WHOOP", async () => {
    const ticket = await mintTicketViaBearer();
    cookieJar.clear(); // native-only: NO session cookie on the connect call

    const { GET } = await import("@/app/api/whoop/connect/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/whoop/connect?ticket=${encodeURIComponent(ticket)}`,
      ),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain(WHOOP_AUTH_URL);
    expect(res.headers.get("set-cookie")).toContain("whoop_state=");

    const prisma = getPrismaClient();
    // Ticket consumed.
    const consumed = await prisma.whoopConnectTicket.findUnique({
      where: { tokenHash: hashToken(ticket) },
    });
    expect(consumed?.consumedAt).not.toBeNull();
    // State ledger row was minted for this user.
    const states = await prisma.whoopOAuthState.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(states).toHaveLength(1);
    expect(states[0].returnScheme).toBeNull();
  });

  it("rejects a second use of the same ticket with a typed 401", async () => {
    const ticket = await mintTicketViaBearer();
    cookieJar.clear();

    const { GET } = await import("@/app/api/whoop/connect/route");
    const first = await GET(
      new NextRequest(
        `http://localhost/api/whoop/connect?ticket=${encodeURIComponent(ticket)}`,
      ),
    );
    expect(first.status).toBe(307);

    const second = await GET(
      new NextRequest(
        `http://localhost/api/whoop/connect?ticket=${encodeURIComponent(ticket)}`,
      ),
    );
    expect(second.status).toBe(401);
    const body = (await second.json()) as { error: string | null };
    expect(body.error).toMatch(/invalid, expired, or already used/i);

    // No second state row was minted.
    const prisma = getPrismaClient();
    const states = await prisma.whoopOAuthState.count({
      where: { userId: TEST_USER_ID },
    });
    expect(states).toBe(1);
  });

  it("rejects an expired ticket with a typed 401", async () => {
    const prisma = getPrismaClient();
    // Hand-seed an already-expired ticket row.
    const raw = "expired-raw-ticket-value-deadbeef";
    await prisma.whoopConnectTicket.create({
      data: {
        userId: TEST_USER_ID,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    cookieJar.clear();

    const { GET } = await import("@/app/api/whoop/connect/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/whoop/connect?ticket=${encodeURIComponent(raw)}`,
      ),
    );
    expect(res.status).toBe(401);
    // The expired row was not consumed (consumedAt stays null).
    const row = await prisma.whoopConnectTicket.findUnique({
      where: { tokenHash: hashToken(raw) },
    });
    expect(row?.consumedAt).toBeNull();
  });

  it("persists a valid return_scheme alongside a ticket connect", async () => {
    const ticket = await mintTicketViaBearer();
    cookieJar.clear();

    const { GET } = await import("@/app/api/whoop/connect/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/whoop/connect?ticket=${encodeURIComponent(ticket)}&return_scheme=dev.healthlog.app`,
      ),
    );
    expect(res.status).toBe(307);

    const prisma = getPrismaClient();
    const states = await prisma.whoopOAuthState.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(states).toHaveLength(1);
    expect(states[0].returnScheme).toBe("dev.healthlog.app");
  });

  it("drops a forbidden return_scheme (http) to null", async () => {
    const ticket = await mintTicketViaBearer();
    cookieJar.clear();

    const { GET } = await import("@/app/api/whoop/connect/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/whoop/connect?ticket=${encodeURIComponent(ticket)}&return_scheme=http`,
      ),
    );
    expect(res.status).toBe(307);

    const prisma = getPrismaClient();
    const states = await prisma.whoopOAuthState.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(states[0].returnScheme).toBeNull();
  });
});
