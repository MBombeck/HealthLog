/**
 * `POST /api/account/grants` — the two things v1.37.0 adds to an invitation.
 *
 * The sections it opens, and the step-up that gates the level which can delete
 * things. Both are asserted on what the route DID rather than on what it
 * answered with: the scope on the `data` object handed to `accountGrant.create`
 * (a response echoing the request would pass either way, and the failure this
 * pins is the one where a field is validated, annotated on, and dropped on the
 * way to the database), and the step-up on the gate having been CALLED, plus
 * the absence of a row when it refuses.
 *
 * What lives where, asserted rather than assumed: an absent `scope` becomes
 * NULL in the schema and nowhere else, and `inviteGrant` writes `Prisma.DbNull`
 * for it — a bare `null` on a nullable Json column stores the JSON value
 * `null`, which the fail-closed normaliser reads as the empty set. That is a
 * grant opening NOTHING written by the path meant to open everything, one
 * keystroke away, so it is pinned.
 *
 * Mutation checks, run and recorded in the stream's report:
 *   - drop the enum from the `scope` schema (`z.array(z.string())`) → the
 *     unknown-section case stops being refused and goes red;
 *   - make the step-up branch unconditional (`if (true)`) → "a read invitation
 *     is not gated" goes red; remove the branch entirely → the MANAGE legs go
 *     red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: never[]) => Promise<Response>>(h: T): T =>
      h,
    requireAuth: vi.fn(),
    requireFreshMfaIfEnrolled: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    accountGrant: { create: vi.fn() },
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
import {
  requireAuth,
  requireFreshMfaIfEnrolled,
  StepUpRequiredError,
} from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";

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

/** Resolve the caller on the transport the argument names. */
function callerOn(transport: "cookie" | "bearer") {
  vi.mocked(requireAuth).mockResolvedValue({
    user: OWNER,
    authMethod: transport,
  } as unknown as Awaited<ReturnType<typeof requireAuth>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  callerOn("cookie");
  vi.mocked(requireFreshMfaIfEnrolled).mockResolvedValue({
    user: OWNER,
  } as unknown as Awaited<ReturnType<typeof requireFreshMfaIfEnrolled>>);
  vi.mocked(prisma.user.findFirst).mockResolvedValue(
    INVITEE as never as Awaited<ReturnType<typeof prisma.user.findFirst>>,
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
    scopeJson: null,
    ...args.data,
  })) as never);
});

describe("the sections an invitation opens", () => {
  it("stores the set the owner picked", async () => {
    const res = await POST(
      request({ identifier: "housemate", scope: ["labs", "medications"] }),
    );

    expect(res.status).toBe(201);
    expect(writtenRow().scopeJson).toEqual(["labs", "medications"]);
  });

  it("stores the whole record as DbNull, not as a JSON null", async () => {
    // The one-keystroke inversion: a bare `null` on a nullable Json column is
    // the stored JSON value `null`, which the fail-closed normaliser resolves
    // to the empty set — the entire record turned into nothing at all.
    const res = await POST(request({ identifier: "housemate" }));

    expect(res.status).toBe(201);
    expect(writtenRow().scopeJson).toBe(Prisma.DbNull);
  });

  it("treats an explicit null the same as an absent field", async () => {
    const res = await POST(request({ identifier: "housemate", scope: null }));

    expect(res.status).toBe(201);
    expect(writtenRow().scopeJson).toBe(Prisma.DbNull);
  });

  it("refuses a section outside the vocabulary, without writing a row", async () => {
    const res = await POST(
      request({ identifier: "housemate", scope: ["labs", "bank_details"] }),
    );

    expect(res.status).toBe(422);
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("refuses the whole-record sentinel as a section", async () => {
    // `record` is deliberately not a member of the vocabulary: a narrowing
    // that names the whole record is a narrowing that means its own absence,
    // and the resolver would refuse every domain for it.
    const res = await POST(
      request({ identifier: "housemate", scope: ["record"] }),
    );

    expect(res.status).toBe(422);
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("refuses an empty set, without writing a row", async () => {
    const res = await POST(request({ identifier: "housemate", scope: [] }));

    expect(res.status).toBe(422);
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("refuses a scope beside MANAGE, without writing a row", async () => {
    // Management is whole-record by construction. "They can do anything, but
    // only to part of you" promises a boundary an edit cannot keep.
    const res = await POST(
      request({ identifier: "housemate", access: "MANAGE", scope: ["labs"] }),
    );

    expect(res.status).toBe(422);
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("records the sections on the audit row", async () => {
    // "Who was given what" is the question this row exists to answer, and an
    // entry naming the level without the sections answers half of it.
    await POST(request({ identifier: "housemate", scope: ["mind"] }));

    expect(auditLog).toHaveBeenCalledWith(
      "sharing.grant.invited",
      expect.objectContaining({
        userId: OWNER.id,
        details: expect.objectContaining({ scope: ["mind"] }),
      }),
    );
  });

  it("records the whole record as an answer rather than an omission", async () => {
    await POST(request({ identifier: "housemate" }));

    const call = vi.mocked(auditLog).mock.calls[0];
    const details = (call[1] as { details: Record<string, unknown> }).details;
    expect(details).toHaveProperty("scope", null);
  });
});

describe("offering MANAGE", () => {
  it("mints the row once the step-up is satisfied", async () => {
    const res = await POST(
      request({ identifier: "housemate", access: "MANAGE" }),
    );

    expect(res.status).toBe(201);
    expect(writtenRow().access).toBe("MANAGE");
    expect(writtenRow().scopeJson).toBe(Prisma.DbNull);
    expect(requireFreshMfaIfEnrolled).toHaveBeenCalledWith(expect.any(Number));
  });

  it("refuses without a fresh second factor, and writes nothing", async () => {
    // The refusal CODE, not merely the absence of a row: a route that threw
    // for any other reason would also leave no row, and this leg is meant to
    // prove the GATE ran.
    vi.mocked(requireFreshMfaIfEnrolled).mockRejectedValue(
      new StepUpRequiredError(),
    );

    await expect(
      POST(request({ identifier: "housemate", access: "MANAGE" })),
    ).rejects.toMatchObject({ errorCode: "auth.stepup.required" });
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("does not gate a read or a write invitation", async () => {
    // The friction belongs to the level that can delete things. An owner
    // sharing a reading with their partner re-proves nothing.
    for (const access of ["READ", "WRITE"] as const) {
      vi.clearAllMocks();
      callerOn("cookie");
      const res = await POST(request({ identifier: "housemate", access }));
      expect(res.status).toBe(201);
      expect(requireFreshMfaIfEnrolled).not.toHaveBeenCalled();
    }
  });

  it("refuses a Bearer caller with a code it can act on", async () => {
    // The decided consequence of a cookie-only step-up, said comprehensibly.
    // Left to fall through, the gate resolves the session cookie, finds none
    // and answers "Not authenticated" to a caller the route had just
    // authenticated — an obscure failure on the one transport that cannot
    // ever succeed here.
    callerOn("bearer");

    const res = await POST(
      request({ identifier: "housemate", access: "MANAGE" }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("sharing.invite.manage_browser_only");
    expect(requireFreshMfaIfEnrolled).not.toHaveBeenCalled();
    expect(prisma.accountGrant.create).not.toHaveBeenCalled();
  });

  it("refuses the Bearer caller before it discloses whether the account exists", async () => {
    // The identifier lookup answers 404 for a name nobody carries, which is a
    // deliberate disclosure to an authenticated caller — but there is no
    // reason to hand it out on a request that cannot succeed.
    callerOn("bearer");

    await POST(request({ identifier: "housemate", access: "MANAGE" }));

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("lets a Bearer caller keep minting the two levels it always could", async () => {
    callerOn("bearer");

    const res = await POST(
      request({ identifier: "housemate", access: "WRITE" }),
    );

    expect(res.status).toBe(201);
    expect(writtenRow().access).toBe("WRITE");
  });
});
