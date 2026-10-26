import { describe, expect, it } from "vitest";

import { grantCoversDomain, normaliseScope } from "@/lib/sharing/grant-access";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";
import { inviteGrantSchema } from "@/lib/validations/account-sharing";

describe("scoped sharing contract", () => {
  it("locks the closed eight-domain vocabulary", () => {
    expect(SHARE_DOMAINS).toEqual([
      "measurements",
      "medications",
      "labs",
      "profile",
      "illness",
      "mind",
      "cycle",
      "documents",
    ]);
  });

  it("treats null as whole-record while refusing malformed non-null scopes", () => {
    expect(normaliseScope(null)).toBeNull();

    for (const malformed of [
      [],
      ["labs", "labs"],
      ["labs", "unknown"],
      ["record"],
      "labs",
      { labs: true },
    ]) {
      const resolved = normaliseScope(malformed);
      expect(resolved, JSON.stringify(malformed)).not.toBeNull();
      expect(resolved?.size, JSON.stringify(malformed)).toBe(0);
      for (const domain of SHARE_DOMAINS) {
        expect(
          grantCoversDomain({ scopeJson: malformed }, domain),
          `${JSON.stringify(malformed)} must not open ${domain}`,
        ).toBe(false);
      }
    }
  });

  it("accepts whole or non-empty unique READ and WRITE scopes only", () => {
    for (const access of ["READ", "WRITE"] as const) {
      expect(
        inviteGrantSchema.safeParse({
          identifier: "delegate",
          access,
          scope: null,
        }).success,
      ).toBe(true);
      expect(
        inviteGrantSchema.safeParse({
          identifier: "delegate",
          access,
          scope: ["labs", "medications"],
        }).success,
      ).toBe(true);
    }

    expect(
      inviteGrantSchema.safeParse({
        identifier: "delegate",
        access: "READ",
        scope: ["labs", "labs"],
      }).success,
    ).toBe(false);
  });

  it("allows MANAGE only for the whole record", () => {
    expect(
      inviteGrantSchema.safeParse({
        identifier: "delegate",
        access: "MANAGE",
        scope: null,
      }).success,
    ).toBe(true);
    expect(
      inviteGrantSchema.safeParse({
        identifier: "delegate",
        access: "MANAGE",
        scope: ["labs"],
      }).success,
    ).toBe(false);
  });
});
