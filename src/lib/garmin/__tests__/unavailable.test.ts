import { describe, expect, it } from "vitest";

import { GarminApiError } from "../client";
import { garminUnavailableCode } from "../unavailable";

function err(
  httpStatus: number | undefined,
  opts: { keyRefused?: boolean } = {},
) {
  return new GarminApiError({
    verb: "x",
    classification: httpStatus === 401 ? "reauth_required" : "persistent",
    httpStatus,
    reason: httpStatus ? `http_${httpStatus}` : "network",
    ...opts,
  });
}

describe("garminUnavailableCode", () => {
  it("takes a lasting 4xx on a resource as unavailable for the account", () => {
    expect(garminUnavailableCode("sleep", err(404))).toBe("http_404");
    expect(garminUnavailableCode("weight", err(403))).toBe("http_403");
    expect(garminUnavailableCode("hrv", err(400))).toBe("http_400");
  });

  it("leaves outages, the allowance and the key to the ordinary paths", () => {
    expect(garminUnavailableCode("sleep", err(500))).toBeNull();
    expect(garminUnavailableCode("sleep", err(429))).toBeNull();
    expect(
      garminUnavailableCode("sleep", err(401, { keyRefused: true })),
    ).toBeNull();
    expect(garminUnavailableCode("sleep", new Error("socket"))).toBeNull();
  });

  it("never lets the cycle leg park the connection", () => {
    expect(garminUnavailableCode("cycle", err(401, { keyRefused: true }))).toBe(
      "key_refused",
    );
    expect(garminUnavailableCode("cycle", err(500))).toBe("http_500");
    expect(garminUnavailableCode("cycle", new Error("socket"))).toBe("error");
    // The allowance is still the allowance.
    expect(garminUnavailableCode("cycle", err(429))).toBeNull();
  });
});
