import { describe, expect, it } from "vitest";

import { geoLookupState, type AdminGeoStatus } from "../_shared";

const base: AdminGeoStatus = {
  lookup: "online",
  providerChosen: false,
  providerHost: "ipwho.is",
};

describe("geoLookupState", () => {
  it("warns only about the unconfigured default provider", () => {
    expect(geoLookupState(base)).toBe("default");
  });

  it("treats a provider the operator named as a decision", () => {
    expect(geoLookupState({ ...base, providerChosen: true })).toBe("chosen");
  });

  it("reads a switched-off lookup and the offline databases as settled", () => {
    expect(geoLookupState({ ...base, lookup: "off" })).toBe("off");
    expect(geoLookupState({ ...base, lookup: "offline" })).toBe("offline");
  });
});
