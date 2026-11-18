/**
 * A managed profile's push fans out to its guardians, except to one the
 * caller names: the guardian who logged the seizure that formed a cluster
 * already knows, and a push about their own entry is noise.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  accountGrant: { findMany: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));

import { resolveManagedGuardianRecipientIds } from "../delivery-identity";

beforeEach(() => {
  db.user.findUnique.mockResolvedValue({ managedProfileAt: new Date() });
  db.accountGrant.findMany.mockResolvedValue([
    { granteeId: "guardian-a", grantee: { managedProfileAt: null } },
    { granteeId: "guardian-b", grantee: { managedProfileAt: null } },
  ]);
});

const payload = {
  userId: "child",
  eventType: "SEIZURE_CLUSTER" as const,
  title: "t",
  message: "m",
};

describe("resolveManagedGuardianRecipientIds", () => {
  it("reaches every guardian by default", async () => {
    expect(await resolveManagedGuardianRecipientIds(payload)).toEqual([
      "guardian-a",
      "guardian-b",
    ]);
  });

  it("leaves out the guardians the payload excludes", async () => {
    expect(
      await resolveManagedGuardianRecipientIds({
        ...payload,
        excludeRecipientUserIds: ["guardian-a"],
      }),
    ).toEqual(["guardian-b"]);
  });
});
