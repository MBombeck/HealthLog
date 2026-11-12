import { describe, expect, it } from "vitest";

import { accountName, nameInitials, patientName } from "../account-name";

describe("accountName", () => {
  it("names the account by its display name when one is set", () => {
    expect(accountName({ username: "jdoe", displayName: "Jane" })).toBe("Jane");
  });

  it("trims the display name it shows", () => {
    expect(accountName({ username: "jdoe", displayName: "  Jane  " })).toBe(
      "Jane",
    );
  });

  it("falls back to the username when the display name is empty or absent", () => {
    expect(accountName({ username: "jdoe", displayName: "   " })).toBe("jdoe");
    expect(accountName({ username: "jdoe", displayName: null })).toBe("jdoe");
    expect(accountName({ username: "jdoe" })).toBe("jdoe");
  });
});

describe("patientName", () => {
  const own = {
    username: "jdoe",
    displayName: null,
    fullName: null,
    managedProfileAt: null,
  };
  const managed = {
    username: "managed-3f9a0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f",
    displayName: null,
    fullName: null,
    managedProfileAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("prefers the full name, then the display name, then the login", () => {
    expect(
      patientName({ ...own, fullName: "Jane Doe", displayName: "Jane" }),
    ).toBe("Jane Doe");
    expect(patientName({ ...own, fullName: "  ", displayName: "Jane" })).toBe(
      "Jane",
    );
    expect(patientName(own)).toBe("jdoe");
  });

  it("never prints a managed record's generated login", () => {
    expect(patientName({ ...managed, displayName: "Robin" })).toBe("Robin");
    expect(patientName(managed)).toBeNull();
  });
});

describe("nameInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(nameInitials("Jane Doe")).toBe("JD");
    expect(nameInitials("max.mustermann")).toBe("MM");
    expect(nameInitials("Robin")).toBe("R");
  });
});
