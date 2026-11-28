/**
 * The insurance number is checked under the country it follows: the one sent
 * beside it, else the stored one, else DE. These pin that pairing and the
 * US-only group number, end to end through `applyProfileUpdate`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Untyped on purpose: these stand in for the two reads and the one write
// the update makes, and each test hands back only the columns it is about.
const db = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: db.findUnique, update: db.update },
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (value: string) => `sealed:${value}`,
  decrypt: (value: string) => value.replace(/^sealed:/, ""),
}));

import { applyProfileUpdate as applyWithProof } from "../profile-update";

const USER_ID = "user-1";

const apply = (body: unknown) =>
  applyWithProof(USER_ID, body, null, {
    authorizeEmailChange: async () => "ok",
  });

function storedRow(row: {
  insuranceNumberEncrypted?: string | null;
  insuranceNumberCountry?: string | null;
  insuranceGroupNumber?: string | null;
}) {
  db.findUnique.mockResolvedValue({
    insuranceNumberEncrypted: null,
    insuranceNumberCountry: null,
    insuranceGroupNumber: null,
    ...row,
  });
}

const written = () =>
  db.update.mock.calls[0]?.[0]?.data as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  storedRow({});
  db.update.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: USER_ID,
      username: "someone",
      displayName: null,
      email: null,
      role: "USER",
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      timezone: "Europe/Berlin",
      locale: null,
      insuranceNumberEncrypted: args.data.insuranceNumberEncrypted ?? null,
      insuranceNumberCountry: args.data.insuranceNumberCountry ?? null,
      insuranceGroupNumber: args.data.insuranceGroupNumber ?? null,
    }),
  );
});

describe("applyProfileUpdate insurance number", () => {
  it("stores an Austrian SVNR sent with its country, normalised", async () => {
    const result = await apply({
      insuranceNumber: "1237 010180",
      insuranceNumberCountry: "at",
    });
    expect(result.ok).toBe(true);
    expect(written()).toMatchObject({
      insuranceNumberEncrypted: "sealed:1237010180",
      insuranceNumberCountry: "AT",
      insuranceGroupNumber: null,
    });
    if (result.ok) {
      expect(result.rejectedFields).toBeUndefined();
      expect(result.user.insuranceNumberCountry).toBe("AT");
    }
  });

  it("checks a number sent alone under the stored country, DE when none", async () => {
    const result = await apply({ insuranceNumber: "1237010180" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.issues?.[0]).toMatchObject({
        path: "insuranceNumber",
        code: "invalid_kvnr",
      });
    }
    expect(db.update).not.toHaveBeenCalled();
  });

  it("refuses the number and its country together, keeping the rest", async () => {
    const result = await apply({
      fullName: "A Person",
      insuranceNumber: "A123456780",
      insuranceNumberCountry: "AT",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFields).toEqual([
        expect.objectContaining({
          path: "insuranceNumber",
          code: "invalid_svnr",
        }),
      ]);
    }
    expect(written()).toMatchObject({ fullName: "A Person" });
    expect(written()).not.toHaveProperty("insuranceNumberEncrypted");
    expect(written()).not.toHaveProperty("insuranceNumberCountry");
  });

  it("refuses a country change the stored number would fail", async () => {
    storedRow({ insuranceNumberEncrypted: "sealed:A123456780" });
    const result = await apply({ insuranceNumberCountry: "AT" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues?.[0]).toMatchObject({
        path: "insuranceNumberCountry",
        code: "invalid_svnr",
      });
    }
  });

  it.each([
    ["CH", "756.9217.0769.85", "7569217076985"],
    // An eight-digit BSN takes its leading zero.
    ["NL", "12345672", "012345672"],
    ["FR", "2 69 05 2a 123 456 88", "269052A12345688"],
  ])("stores a valid %s number compact", async (country, input, stored) => {
    const result = await apply({
      insuranceNumber: input,
      insuranceNumberCountry: country,
    });
    expect(result.ok).toBe(true);
    expect(written()?.insuranceNumberEncrypted).toBe(`sealed:${stored}`);
  });

  it("keeps a US member ID as entered and stores its group number", async () => {
    const result = await apply({
      insuranceNumber: "  W123-456 789 ",
      insuranceNumberCountry: "US",
      insuranceGroupNumber: " GRP 0042 ",
    });
    expect(result.ok).toBe(true);
    expect(written()).toMatchObject({
      insuranceNumberEncrypted: "sealed:W123-456 789",
      insuranceNumberCountry: "US",
      insuranceGroupNumber: "GRP 0042",
    });
    if (result.ok) expect(result.user.insuranceGroupNumber).toBe("GRP 0042");
  });

  it("refuses a member ID outside the generic rule", async () => {
    const result = await apply({
      insuranceNumber: "W1",
      insuranceNumberCountry: "US",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues?.[0]).toMatchObject({
        path: "insuranceNumber",
        code: "invalid_member_id",
      });
    }
  });

  it("clears the group number for any country but the US", async () => {
    storedRow({
      insuranceNumberEncrypted: "sealed:W123456",
      insuranceNumberCountry: "US",
      insuranceGroupNumber: "GRP 0042",
    });
    const result = await apply({
      insuranceNumber: "A123456780",
      insuranceNumberCountry: "DE",
      insuranceGroupNumber: "GRP 0042",
    });
    expect(result.ok).toBe(true);
    expect(written()).toMatchObject({
      insuranceNumberCountry: "DE",
      insuranceGroupNumber: null,
    });
  });

  it("refuses a group number outside the generic rule for a US plan", async () => {
    const result = await apply({
      insuranceNumber: "W123456",
      insuranceNumberCountry: "US",
      insuranceGroupNumber: "G/1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFields).toEqual([
        expect.objectContaining({
          path: "insuranceGroupNumber",
          code: "invalid_member_id",
        }),
      ]);
    }
    expect(written()).not.toHaveProperty("insuranceGroupNumber");
  });

  it("refuses a country that is no ISO 3166-1 code", async () => {
    const result = await apply({ insuranceNumberCountry: "EU" });
    expect(result.ok).toBe(false);
  });

  it("reads nothing when no insurance field is sent", async () => {
    await apply({ fullName: "A Person" });
    expect(db.findUnique).not.toHaveBeenCalled();
  });
});
