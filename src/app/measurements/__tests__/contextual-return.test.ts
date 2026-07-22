import { describe, expect, it } from "vitest";

import { resolveMeasurementReturnTo } from "../page";

describe("resolveMeasurementReturnTo", () => {
  it.each([
    "/insights/weight",
    "/insights/body-temperature",
    "/insights/blood-pressure",
  ])("accepts the canonical metric route %s", (path) => {
    expect(resolveMeasurementReturnTo(path)).toBe(path);
  });

  it.each([
    null,
    undefined,
    "",
    "https://evil.example/steal",
    "//evil.example/steal",
    "/measurements",
    "/insights/not-a-real-metric",
    "/insights/weight?next=https://evil.example",
    "/insights/weight#redirect",
    "/insights/../settings/account",
    "/insights/%77eight",
  ])("rejects an untrusted return target: %s", (path) => {
    expect(resolveMeasurementReturnTo(path)).toBeNull();
  });
});
