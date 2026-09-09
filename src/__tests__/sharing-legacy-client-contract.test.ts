/**
 * v1.37.0 — what a client makes of the account payload, old and new.
 *
 * The sharing block gained three fields this release (`level`, `sections`,
 * `recordKind`) and kept the two the v1.36.0 contract published (`access`,
 * `canWrite`). Two questions follow from that, and this file answers both
 * against the payload the SERVER builds rather than against a copy of it:
 *
 *   1. a client that predates the release still decodes a whole-record grant,
 *      and fails closed on a scoped one rather than reading it as the whole
 *      record;
 *   2. the canonical readers consume the new fields off both the entry and the
 *      active record, without a shim in between.
 *
 * ## Why it drives `resolveAccountAccess` and not a literal
 *
 * `src/lib/sharing/__tests__/account-access.test.ts` already runs the legacy
 * decoder over the FIXTURE objects, which carry an `access` and a `sections`
 * key of their own. That proves the decoder and proves the fixture; it cannot
 * prove that a payload the server actually emits decodes, because no server
 * code runs between them. This file resolves each fixture case through the real
 * resolver and hands the decoder the entry that comes out — both ends and the
 * pipe. The fixture's canonical fields are asserted against that entry too, so
 * a fixture that drifted from the server would fail here rather than quietly
 * describe something the product no longer does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { accountGrant: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { resolveRecordCapabilities } from "@/hooks/use-record-capabilities";
import { resolveAccountAccess } from "@/lib/sharing/account-access";
import {
  decodeLegacyWholeRecordAccess,
  type AccountAccessEntry,
} from "@/lib/sharing/account-access-view";
import {
  LEGACY_ACCOUNT_PAYLOADS,
  type LegacyAccountPayloadFixture,
} from "../../tests/fixtures/v137/legacy-account-payloads";

const OWNER = "record-owner";

/** The grant row behind one fixture case, as Prisma would return it. */
function grantFor(fixture: LegacyAccountPayloadFixture) {
  return {
    id: `grant-${fixture.name}`,
    access:
      fixture.level === "manage"
        ? "MANAGE"
        : fixture.level === "write"
          ? "WRITE"
          : "READ",
    scopeJson: fixture.sections,
    acceptedAt: new Date("2026-08-01T00:00:00.000Z"),
    revokedAt: null,
    expiresAt: null,
    grantor: {
      id: OWNER,
      username: "record-owner",
      displayName: "Record owner",
      managedProfileAt:
        fixture.recordKind === "managed"
          ? new Date("2026-08-01T00:00:00.000Z")
          : null,
    },
  };
}

/** The entry and the active record the server publishes for one case. */
async function publishedFor(fixture: LegacyAccountPayloadFixture): Promise<{
  entry: AccountAccessEntry;
  active: AccountAccessEntry | null;
}> {
  vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
    grantFor(fixture),
  ] as never);
  const access = await resolveAccountAccess({
    user: { id: "delegate" },
    session: { actingAsUserId: OWNER },
  });
  return { entry: access.accounts[0], active: access.active };
}

/** read < write < manage, so "never more than" is a comparison and not prose. */
const RANK = { read: 0, write: 1, manage: 2 } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what an older client makes of the v1.37.0 account payload", () => {
  it("[J8-old-client-compatibility] covers every fixture case, and the fixtures describe the server", async () => {
    // Non-zero discovery, and the assertion that keeps the fixture honest: it
    // is a description of what the resolver emits, not a parallel invention.
    expect(LEGACY_ACCOUNT_PAYLOADS.length).toBeGreaterThan(0);

    for (const fixture of LEGACY_ACCOUNT_PAYLOADS) {
      const { entry } = await publishedFor(fixture);
      expect(entry, fixture.name).toEqual(
        expect.objectContaining({
          access: fixture.access,
          level: fixture.level,
          sections: fixture.sections,
          canWrite: fixture.canWrite,
          recordKind: fixture.recordKind,
        }),
      );
    }
  });

  it.each(LEGACY_ACCOUNT_PAYLOADS)(
    "decodes $name the way the fixture says an old client would",
    async (fixture) => {
      const { entry } = await publishedFor(fixture);
      const decoded = decodeLegacyWholeRecordAccess(entry);

      expect(decoded === null ? "deny" : "allow").toBe(fixture.legacyDecoder);
      if (fixture.legacyDecoder === "allow") {
        expect(decoded).toBe(fixture.access);
        // Never MORE than the grant confers. A MANAGE grant decodes as `write`
        // on an old client — under-reporting what it may do, which costs a
        // control and leaks nothing. The reverse would hand a client a level
        // the server will refuse.
        expect(RANK[decoded!]).toBeLessThanOrEqual(RANK[fixture.level]);
      }
    },
  );

  it("[J8-old-client-compatibility] refuses a scoped grant rather than reading it as the whole record", async () => {
    const scoped = LEGACY_ACCOUNT_PAYLOADS.find(
      (fixture) => fixture.sections !== null,
    );
    expect(scoped, "the fixture set must carry a scoped case").toBeDefined();

    const { entry } = await publishedFor(scoped!);
    expect(entry.sections).not.toBeNull();
    expect(decodeLegacyWholeRecordAccess(entry)).toBeNull();

    // And the reason is the field, not the level: the same grant with the
    // sections removed decodes, so a client on the old contract is refused for
    // carrying a narrowing it cannot express rather than for being at READ.
    expect(decodeLegacyWholeRecordAccess({ ...entry, sections: null })).toBe(
      entry.access,
    );
  });
});

describe("what the canonical readers make of the same payload", () => {
  it.each(LEGACY_ACCOUNT_PAYLOADS)(
    "carries level, sections and recordKind through the active record for $name",
    async (fixture) => {
      const { active } = await publishedFor(fixture);
      expect(active, "the session is switched into the record").not.toBeNull();

      const capabilities = resolveRecordCapabilities(active);
      expect(capabilities.level).toBe(fixture.level);
      expect(capabilities.sections).toEqual(fixture.sections);
      expect(capabilities.recordKind).toBe(fixture.recordKind);
      expect(capabilities.inSharedRecord).toBe(true);
      // Resolved server-side and rendered, never re-derived: `canAdd` follows
      // `canWrite`, and `canManage` follows the published `manageableDomains`
      // list rather than the level — a delegate's management reach is the
      // server's answer, section by section.
      expect(capabilities.canWrite).toBe(fixture.canWrite);
      expect(capabilities.canAdd).toBe(fixture.canWrite);
      const manageable = active?.manageableDomains ?? [];
      expect(capabilities.canManage).toBe(manageable.length > 0);
      expect(manageable.length > 0).toBe(fixture.level === "manage");
    },
  );

  it("[J8-old-client-compatibility] reads a scope the server could not parse as nothing, on both ends", async () => {
    // The fail-closed reading: a stored scope this build cannot make sense of
    // resolves to an EMPTY section list rather than to the whole record. The
    // server refuses every section for it, and the client has to agree — an
    // empty array rendered as "everything" would paint the entire product for
    // a grant that opens none of it.
    vi.mocked(prisma.accountGrant.findMany).mockResolvedValue([
      { ...grantFor(LEGACY_ACCOUNT_PAYLOADS[0]), scopeJson: ["not-a-section"] },
    ] as never);

    const access = await resolveAccountAccess({
      user: { id: "delegate" },
      session: { actingAsUserId: OWNER },
    });

    expect(access.accounts[0].sections).toEqual([]);
    expect(resolveRecordCapabilities(access.active).sections).toEqual([]);
    // An old client is refused outright rather than being handed the whole
    // record, which is the same fail-closed direction.
    expect(decodeLegacyWholeRecordAccess(access.accounts[0])).toBeNull();
  });
});
