import { describe, expect, it } from "vitest";

import { owedRegistrations, walletPassChangedAt } from "../push";
import {
  isDeviceId,
  isSerial,
  notModifiedSince,
  parseUpdatedSince,
  walletRegistrationSchema,
} from "../web-service";

describe("the pass web service's small rules", () => {
  it("reads only its own Unix-millisecond tag", () => {
    expect(parseUpdatedSince("1700000000000")?.getTime()).toBe(1700000000000);
    for (const tag of [null, "", "2026-11-24", "-1", "1e9", "9".repeat(16)]) {
      expect(parseUpdatedSince(tag)).toBeNull();
    }
  });

  it("answers 304 on whole seconds", () => {
    const changed = new Date("2026-11-24T10:00:00.900Z");
    expect(notModifiedSince(changed.toUTCString(), changed)).toBe(true);
    expect(
      notModifiedSince(new Date("2026-11-24T09:59:59Z").toUTCString(), changed),
    ).toBe(false);
    expect(notModifiedSince(null, changed)).toBe(false);
    expect(notModifiedSince("not a date", changed)).toBe(false);
  });

  it("checks the shape of every path part", () => {
    expect(isDeviceId("a1B2c3")).toBe(true);
    expect(isDeviceId("")).toBe(false);
    expect(isDeviceId("a/b")).toBe(false);
    expect(isDeviceId("x".repeat(129))).toBe(false);
    expect(isSerial("6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b")).toBe(true);
    expect(isSerial("6F1D2C3B-4A59-4687-9A0B-1C2D3E4F5A6B")).toBe(false);
    expect(
      walletRegistrationSchema.safeParse({ pushToken: "ab".repeat(32) })
        .success,
    ).toBe(true);
    expect(
      walletRegistrationSchema.safeParse({
        pushToken: "ab".repeat(32),
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      walletRegistrationSchema.safeParse({ pushToken: "zz" }).success,
    ).toBe(false);
  });

  it("counts a link's expiry as a change once it has passed", () => {
    const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
    const pass = (expiresAt: Date) => ({
      contentChangedAt: t(10),
      voidedAt: null,
      link: { revokedAt: null, expiresAt },
    });
    expect(walletPassChangedAt(pass(t(30)), t(40))).toEqual(t(30));
    expect(walletPassChangedAt(pass(t(50)), t(40))).toEqual(t(10));
  });

  it("owes a push to a device that has not heard of the last change", () => {
    const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
    const changedAt = walletPassChangedAt({
      contentChangedAt: t(10),
      voidedAt: t(20),
      link: { revokedAt: null, expiresAt: null },
    });
    expect(changedAt).toEqual(t(20));
    const regs = [
      { id: "before", createdAt: t(1), lastPushAt: null },
      { id: "pushed-before", createdAt: t(1), lastPushAt: t(15) },
      { id: "pushed-after", createdAt: t(1), lastPushAt: t(25) },
      { id: "registered-after", createdAt: t(30), lastPushAt: null },
    ];
    expect(owedRegistrations(changedAt, regs).map((r) => r.id)).toEqual([
      "before",
      "pushed-before",
    ]);
  });
});
