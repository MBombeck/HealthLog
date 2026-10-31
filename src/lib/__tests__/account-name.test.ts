import { describe, expect, it } from "vitest";

import { accountName } from "../account-name";

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
