import { describe, expect, it } from "vitest";

import { domainsOfMeasurementTypes } from "@/lib/push-relay/data-changed";
import { wakeMessage } from "@/lib/push-relay/wakes";

describe("DATA_CHANGED helpers", () => {
  it("maps sleep types to sleep and every other type to measurements", () => {
    expect(
      domainsOfMeasurementTypes([
        "WEIGHT",
        "SLEEP_DURATION",
        "SLEEP_SCORE",
        "PULSE",
      ]),
    ).toEqual(["measurements", "sleep"]);
  });
});

describe("wake messages", () => {
  it("are silent, one hour, data only", () => {
    expect(wakeMessage("DATA_CHANGED", { domains: ["sleep"] })).toEqual({
      pushClass: "silent",
      type: "DATA_CHANGED",
      lifetimeSeconds: 3600,
      data: { domains: ["sleep"] },
    });
  });
});
