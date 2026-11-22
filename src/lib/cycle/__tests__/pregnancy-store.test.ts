import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";

import { pregnancyFieldsOf, pregnancyWriteData } from "../pregnancy-store";

const fields = {
  reproductiveState: "PREGNANT" as const,
  pregnancyStartDate: "2026-06-01",
  pregnancyDueDate: "2027-03-08",
  deliveryDate: null,
  postpartumWeeks: 12,
};

const savedKey = process.env.ENCRYPTION_KEY;
beforeAll(() => {
  process.env.ENCRYPTION_KEY = "ab".repeat(32);
  _resetCryptoCacheForTests();
});
afterAll(() => {
  process.env.ENCRYPTION_KEY = savedKey ?? "";
  _resetCryptoCacheForTests();
});

describe("the sealed pregnancy state", () => {
  it("round-trips, and holds nothing readable", () => {
    const stored = pregnancyWriteData(fields);
    expect(stored.pregnancyEncrypted).not.toBeNull();
    expect(stored.pregnancyEncrypted).not.toContain("2026-06-01");
    expect(stored.pregnancyEncrypted).not.toContain("PREGNANT");
    expect(pregnancyFieldsOf(stored)).toEqual({
      ...fields,
      ownerDecided: false,
    });
  });

  it("stores nothing for no state and no decision", () => {
    expect(
      pregnancyWriteData({
        reproductiveState: null,
        pregnancyStartDate: null,
        pregnancyDueDate: null,
        deliveryDate: null,
        postpartumWeeks: 12,
      }).pregnancyEncrypted,
    ).toBeNull();
  });

  it("keeps the owner's decision after they cleared the state", () => {
    const stored = pregnancyWriteData({
      reproductiveState: null,
      pregnancyStartDate: null,
      pregnancyDueDate: null,
      deliveryDate: null,
      postpartumWeeks: 12,
      ownerDecided: true,
    });
    expect(stored.pregnancyEncrypted).not.toBeNull();
    expect(pregnancyFieldsOf(stored)).toMatchObject({
      reproductiveState: null,
      ownerDecided: true,
    });
  });

  it("reads an envelope it cannot open, or a malformed day, as no state", () => {
    expect(
      pregnancyFieldsOf({
        pregnancyEncrypted: "not-a-cipher",
        postpartumWeeks: 12,
      }).reproductiveState,
    ).toBeNull();
    const odd = pregnancyFieldsOf({
      pregnancyEncrypted: encrypt(
        JSON.stringify({ state: "PREGNANT", startDate: "2026-6-1" }),
      ),
      postpartumWeeks: 12,
    });
    expect(odd.reproductiveState).toBe("PREGNANT");
    expect(odd.pregnancyStartDate).toBeNull();
  });
});
