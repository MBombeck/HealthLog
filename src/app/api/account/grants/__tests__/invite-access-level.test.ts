/**
 * `POST /api/account/grants` — the level a request carries is the level the row
 * gets.
 *
 * The assertion is deliberately on the WRITE the route performs rather than on
 * the JSON it answers with: a response echoing the request would pass either
 * way, and the failure this pins is the one where a field is validated,
 * annotated on, and then dropped on the way to the database. So every case
 * reads the `data` object handed to `accountGrant.create`.
 *
 * Where the default lives matters and is asserted here rather than assumed: an
 * omitted `access` becomes READ in the invite schema and nowhere else —
 * `inviteGrant` takes the level as a required argument. Move the default and
 * the third case below goes red.
 *
 * What this file cannot see: the browser. That the level a person picks on the
 * invitation form reaches this route at all is proven in
 * `e2e/account-sharing.spec.ts`, which reads the posted body — the component
 * test renders the control and stays green with the control wired to a
 * constant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The exact, case-blind lookup (`@/lib/auth/identity-lookup`) answers with an
// id; the row read by that id is what each case below decides.
vi.mock("@/lib/auth/identity-lookup", () => ({
  findUserIdBySignInName: vi.fn(async () => "matched-account"),
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  const requireAuth = vi.fn();
  return {
    ...actual,
    apiHandler: <T extends (...args: never[]) => Promise<Response>>(h: T): T =>
      h,
    requireAuth,
    // The invitation takes the fresh-proof gate; here it resolves the caller
    // the stubbed `requireAuth` names, so these cases stay about the row.
    // The gate itself has its own case in `invite-recent-proof.test.ts`.
    requireRecentProof: vi.fn(async () => ({
      ...(await requireAuth()),
      commitElevation: async () => {},
    })),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    accountGrant: {
      create: vi.fn(),
      // inviteGrant sweeps expired live-pair rows before the create; nothing to
      // close in these fixtures.
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi
    .fn()
    .mockResolvedValue({ allowed: true, remaining: 9, resetAt: 0 }),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { POST } from "../route";
import { requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";

const OWNER = { id: "owner-1" };
const INVITEE = { id: "invitee-1", username: "housemate", displayName: null };

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/account/grants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The `data` object the route's write reached the client with. */
function writtenRow(): Record<string, unknown> {
  const calls = vi.mocked(prisma.accountGrant.create).mock.calls;
  expect(calls).toHaveLength(1);
  return (calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAuth).mockResolvedValue({
    user: OWNER,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(
    INVITEE as never as Awaited<ReturnType<typeof prisma.user.findUnique>>,
  );
  vi.mocked(prisma.accountGrant.create).mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => ({
    id: "grant-1",
    grantorId: OWNER.id,
    granteeId: INVITEE.id,
    acceptedAt: null,
    revokedAt: null,
    revokedBy: null,
    lastUsedAt: null,
    expiresAt: null,
    ...args.data,
  })) as never);
});

describe("invitation access level", () => {
  it("stores WRITE when the invitation offers it", async () => {
    const res = await POST(
      request({ identifier: "housemate", access: "WRITE" }),
    );

    expect(res.status).toBe(201);
    expect(writtenRow().access).toBe("WRITE");
    const body = (await res.json()) as { data: { access: string } };
    expect(body.data.access).toBe("WRITE");
  });

  it("stores READ when the invitation offers it", async () => {
    const res = await POST(
      request({ identifier: "housemate", access: "READ" }),
    );

    expect(res.status).toBe(201);
    expect(writtenRow().access).toBe("READ");
  });

  it("mints READ for a client that does not send the field", async () => {
    // An older client's payload stays valid, and it stays NARROW. This is the
    // case that must never widen by accident.
    const res = await POST(request({ identifier: "housemate" }));

    expect(res.status).toBe(201);
    expect(writtenRow().access).toBe("READ");
  });

  it("refuses a level that is not one of the two, without writing a row", async () => {
    const res = await POST(
      request({ identifier: "housemate", access: "ADMIN" }),
    );

    expect(res.status).toBe(422);
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("records the level on the audit row", async () => {
    // "Who was given what, and by whom" is the question this row answers. An
    // entry naming the invitation without its level answers half of it.
    await POST(request({ identifier: "housemate", access: "WRITE" }));

    expect(auditLog).toHaveBeenCalledWith(
      "sharing.grant.invited",
      expect.objectContaining({
        userId: OWNER.id,
        details: expect.objectContaining({ access: "WRITE" }),
      }),
    );
  });
});
