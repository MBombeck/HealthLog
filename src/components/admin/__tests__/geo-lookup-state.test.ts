import { describe, expect, it } from "vitest";

import { geoLookupState, type PublicVersion } from "../_shared";

const base: PublicVersion = {
  version: "1.42.0",
  buildSha: null,
  builtAt: null,
};

describe("geoLookupState", () => {
  it("warns only about the unconfigured default provider", () => {
    expect(
      geoLookupState({
        ...base,
        offlineGeoEnabled: false,
        geoLookup: "online",
      }),
    ).toBe("default");
  });

  it("treats a provider the operator named as a decision", () => {
    expect(
      geoLookupState({
        ...base,
        offlineGeoEnabled: false,
        geoLookup: "online",
        geoProviderChosen: true,
      }),
    ).toBe("chosen");
  });

  it("reads a switched-off lookup and the offline databases as settled", () => {
    expect(
      geoLookupState({ ...base, offlineGeoEnabled: false, geoLookup: "off" }),
    ).toBe("off");
    expect(geoLookupState({ ...base, offlineGeoEnabled: true })).toBe(
      "offline",
    );
  });
});
