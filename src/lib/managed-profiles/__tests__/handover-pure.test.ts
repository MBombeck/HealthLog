/**
 * v1.42 (#959) — the pure parts of the managed-profile handover: the token
 * shape, the access policy, the request schemas and the stored-state reader.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildHandoverUrl,
  generateHandoverToken,
  handoverHashMatches,
  hashHandoverToken,
  looksLikeHandoverToken,
} from "@/lib/auth/handover-token";
import {
  DEFAULT_HANDOVER_ACCESS,
  grantAccessFor,
  handoverAccessOf,
  isHandoverMinor,
} from "@/lib/managed-profiles/handover-access";
import { parseHandoverState } from "@/lib/managed-profiles/handover";
import {
  claimSchema,
  createHandoverSchema,
  handoverDecisionSchema,
} from "@/lib/validations/managed-profile-handover";
import { registerSchema } from "@/lib/validations/auth";

beforeAll(() => {
  process.env.API_TOKEN_HMAC_KEY ??= "x".repeat(48);
});

describe("handover token", () => {
  it("mints hlp_ plus 64 lowercase hex characters, fresh every time", () => {
    const a = generateHandoverToken();
    const b = generateHandoverToken();
    expect(a).toMatch(/^hlp_[0-9a-f]{64}$/);
    expect(looksLikeHandoverToken(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it.each([
    `hlv_${"a".repeat(64)}`,
    `hlp_${"A".repeat(64)}`,
    `hlp_${"a".repeat(63)}`,
    `hlp_${"a".repeat(65)}`,
    "",
  ])("refuses %s at the shape gate", (value) => {
    expect(looksLikeHandoverToken(value)).toBe(false);
  });

  it("stores a keyed hash, never the token, and compares it in constant time", () => {
    const token = generateHandoverToken();
    const hash = hashHandoverToken(token);
    expect(hash).not.toContain(token.slice(4));
    expect(handoverHashMatches(hash, hashHandoverToken(token))).toBe(true);
    expect(
      handoverHashMatches(hash, hashHandoverToken(generateHandoverToken())),
    ).toBe(false);
    expect(handoverHashMatches(hash, "short")).toBe(false);
  });

  it("builds the link on the configured origin, not the request's", () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://health.example.org/some/path";
    try {
      expect(buildHandoverUrl("hlp_x", "http://internal:3000/api/x")).toBe(
        "https://health.example.org/claim/hlp_x",
      );
    } finally {
      if (previous === undefined) delete process.env.APP_URL;
      else process.env.APP_URL = previous;
    }
  });
});

describe("handover access policy", () => {
  it("proposes view-only when nobody says otherwise", () => {
    expect(DEFAULT_HANDOVER_ACCESS).toBe("read");
  });

  it("maps each level to a grant level, and end to none", () => {
    expect(grantAccessFor("end")).toBeNull();
    expect(grantAccessFor("read")).toBe("READ");
    expect(grantAccessFor("manage")).toBe("MANAGE");
    expect(handoverAccessOf(null)).toBe("end");
    expect(handoverAccessOf({ access: "WRITE" })).toBe("read");
    expect(handoverAccessOf({ access: "MANAGE" })).toBe("manage");
  });

  it("flags a minor by the birthday, not the birth year", () => {
    const today = new Date("2026-10-08T12:00:00Z");
    expect(isHandoverMinor("2010-10-09", today)).toBe(true);
    expect(isHandoverMinor("2010-10-08", today)).toBe(false);
    expect(isHandoverMinor(null, today)).toBe(false);
    expect(isHandoverMinor("not-a-date", today)).toBe(false);
  });
});

describe("handover request schemas", () => {
  it("defaults the link to seven days and refuses other lifetimes", () => {
    expect(createHandoverSchema.parse({}).expiresInDays).toBe(7);
    expect(createHandoverSchema.safeParse({ expiresInDays: 30 }).success).toBe(
      false,
    );
  });

  it("refuses a guardian named twice and unknown fields", () => {
    const twice = createHandoverSchema.safeParse({
      proposals: [
        { grantId: "g1", proposal: "read" },
        { grantId: "g1", proposal: "end" },
      ],
    });
    expect(twice.success).toBe(false);
    expect(
      createHandoverSchema.safeParse({ proposals: [], profileId: "p" }).success,
    ).toBe(false);
    expect(
      handoverDecisionSchema.safeParse({
        decisions: [
          { grantId: "g1", access: "read" },
          { grantId: "g1", access: "manage" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires an email and refuses the managed- prefix on a claim", () => {
    const base = {
      token: "hlp_x",
      username: "alex",
      email: "alex@example.test",
      password: "a long enough passphrase",
    };
    expect(claimSchema.safeParse(base).success).toBe(true);
    expect(claimSchema.safeParse({ ...base, email: undefined }).success).toBe(
      false,
    );
    expect(
      claimSchema.safeParse({ ...base, username: "Managed-alex" }).success,
    ).toBe(false);
  });

  it("refuses the managed- prefix on registration too", () => {
    expect(
      registerSchema.safeParse({
        email: "a@example.test",
        username: "managed-0123",
        password: "a long enough passphrase",
      }).success,
    ).toBe(false);
  });
});

describe("parseHandoverState", () => {
  const proposals = [{ grantId: "g1", guardianId: "u1", proposal: "read" }];

  it("reads the shape it writes", () => {
    const state = parseHandoverState({
      version: 1,
      proposals,
      claim: {
        claimedAt: "2026-10-08T00:00:00.000Z",
        decidedAt: null,
        guardians: [
          {
            grantId: "g1",
            guardianId: "u1",
            proposal: "read",
            applied: "read",
            currentGrantId: "g2",
          },
        ],
      },
    });
    expect(state?.claim?.guardians[0].currentGrantId).toBe("g2");
  });

  it.each([
    ["a later version", { version: 2, proposals }],
    [
      "an unknown level",
      { version: 1, proposals: [{ ...proposals[0], proposal: "write" }] },
    ],
    [
      "a missing guardian",
      { version: 1, proposals: [{ grantId: "g1", proposal: "read" }] },
    ],
    ["an array", [proposals]],
    ["null", null],
  ])("refuses %s rather than guessing", (_label, value) => {
    expect(parseHandoverState(value)).toBeNull();
  });
});
