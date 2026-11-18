import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    accountGrant: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/db";
import { resolveAccountAccess } from "../account-access";
import { delegatedDomains } from "@/lib/sharing/domain-write-support";
import { decodeLegacyWholeRecordAccess } from "../account-access-view";
import { LEGACY_ACCOUNT_PAYLOADS } from "../../../../tests/fixtures/v137/legacy-account-payloads";

function activeGrant({
  access,
  managedProfileAt = null,
  scopeJson = null,
}: {
  access: "READ" | "WRITE" | "MANAGE";
  managedProfileAt?: Date | null;
  scopeJson?: string[] | null;
}) {
  return {
    id: `grant-${access.toLowerCase()}`,
    access,
    scopeJson,
    acceptedAt: new Date("2026-08-01T00:00:00.000Z"),
    revokedAt: null,
    expiresAt: null,
    grantor: {
      id: "record-owner",
      username: "record-owner",
      displayName: "Record owner",
      fullName: "Test Full Name",
      managedProfileAt,
    },
  };
}

/** The rows the grant query answers, in the shape the module selects. */
function mockGrants(rows: ReturnType<typeof activeGrant>[]): void {
  vi.mocked(prisma.accountGrant.findMany).mockResolvedValue(rows as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAccountAccess", () => {
  it("keeps MANAGE compatible with legacy access while publishing its canonical level", async () => {
    mockGrants([
      activeGrant({
        access: "MANAGE",
        managedProfileAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ]);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: { actingAsUserId: "record-owner" },
    });

    expect(access.accounts).toEqual([
      expect.objectContaining({
        access: "write",
        level: "manage",
        sections: null,
        canWrite: true,
        recordKind: "managed",
      }),
    ]);
    expect(access.active).toEqual(
      expect.objectContaining({
        level: "manage",
        sections: null,
        recordKind: "managed",
        // v1.38.12 — the routes' answer for a whole-record MANAGE grant: every
        // section with a delegated write route. #1403 — on a managed profile
        // that includes the vault, whose writes admit the guardian.
        writableDomains: delegatedDomains("manage", null, "write", "managed"),
        manageableDomains: delegatedDomains(
          "manage",
          null,
          "manage",
          "managed",
        ),
      }),
    );
    expect(access.active?.manageableDomains).toContain("mind");
    expect(access.active?.manageableDomains).toContain("documents");
    expect(access.active?.writableDomains).toContain("documents");
    expect(access.recordKind).toBe("managed");
  });

  it("never publishes the vault for an adult's MANAGE grant (#1403)", async () => {
    mockGrants([activeGrant({ access: "MANAGE", managedProfileAt: null })]);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: { actingAsUserId: "record-owner" },
    });

    expect(access.active?.recordKind).toBe("shared");
    expect(access.active?.level).toBe("manage");
    expect(access.active?.manageableDomains).toContain("mind");
    expect(access.active?.manageableDomains).not.toContain("documents");
    expect(access.active?.writableDomains).not.toContain("documents");
  });

  it("publishes a WRITE grant's writable sections within its scope and no manageable ones", async () => {
    mockGrants([activeGrant({ access: "WRITE", scopeJson: ["mind", "labs"] })]);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: { actingAsUserId: "record-owner" },
    });

    // `mind` is opened by the scope but has no WRITE route, so it is absent;
    // `labs` has one. Consent order, not scope order.
    expect(access.active?.writableDomains).toEqual(["labs"]);
    expect(access.active?.manageableDomains).toEqual([]);
  });

  it("publishes two empty lists for a READ grant", async () => {
    mockGrants([activeGrant({ access: "READ" })]);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: { actingAsUserId: "record-owner" },
    });

    expect(access.active?.writableDomains).toEqual([]);
    expect(access.active?.manageableDomains).toEqual([]);
  });

  it("resolves an ordinary shared record on the server", async () => {
    mockGrants([activeGrant({ access: "READ" })]);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: {},
    });

    expect(access.accounts[0]).toEqual(
      expect.objectContaining({
        access: "read",
        level: "read",
        recordKind: "shared",
      }),
    );
    expect(access.recordKind).toBe("self");
  });

  it("carries the owner's full name to a read-only delegate", async () => {
    // v1.37.2 — the record owner's full name crosses to whoever they share
    // with, read-only included (maintainer decision 2026-08-08). It is the
    // resolver that lets it cross, so it is the resolver that proves it: a
    // READ grant, and the delegate's resolved entry still names the owner in
    // full. If a future change drops `fullName` from the grantor `select`,
    // this fails rather than silently reverting the disclosure to a nickname.
    mockGrants([activeGrant({ access: "READ" })]);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: {},
    });

    expect(access.accounts[0]).toEqual(
      expect.objectContaining({
        access: "read",
        canWrite: false,
        fullName: "Test Full Name",
      }),
    );
  });

  it("keeps whole-record legacy payloads decodable and scoped payloads closed", () => {
    for (const fixture of LEGACY_ACCOUNT_PAYLOADS) {
      const decoded = decodeLegacyWholeRecordAccess(fixture);
      expect(decoded === null ? "deny" : "allow", fixture.name).toBe(
        fixture.legacyDecoder,
      );
      if (fixture.legacyDecoder === "allow") {
        expect(decoded).toBe(fixture.access);
      }
    }
  });
});
