import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IMPORT_RATE_LIMIT_DEFAULT,
  IMPORT_RATE_LIMIT_DOC,
  importRateLimitMessage,
  resetImportRateLimitWarningForTests,
  resolveImportRateLimitPerHour,
} from "../import-rate-limit-policy";

afterEach(() => {
  delete process.env.IMPORT_RATE_LIMIT_PER_HOUR;
  resetImportRateLimitWarningForTests();
  vi.restoreAllMocks();
});

describe("resolveImportRateLimitPerHour", () => {
  it("answers 5 when nothing is set, and when compose forwards an empty value", () => {
    expect(IMPORT_RATE_LIMIT_DEFAULT).toBe(5);
    expect(resolveImportRateLimitPerHour()).toBe(5);
    process.env.IMPORT_RATE_LIMIT_PER_HOUR = "";
    expect(resolveImportRateLimitPerHour()).toBe(5);
  });

  it.each([
    ["1", 1],
    ["50", 50],
    [" 200 ", 200],
    ["1000", 1000],
  ])("takes the configured value %j", (raw, expected) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.IMPORT_RATE_LIMIT_PER_HOUR = raw;
    expect(resolveImportRateLimitPerHour()).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["0", "-5", "7.5", "1e2", "lots", "1001", "99999999999999999999"])(
    "falls back to 5 with a warning for %j",
    (raw) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env.IMPORT_RATE_LIMIT_PER_HOUR = raw;
      expect(resolveImportRateLimitPerHour()).toBe(5);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "IMPORT_RATE_LIMIT_PER_HOUR",
      );
    },
  );

  it("warns once, not on every request", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.IMPORT_RATE_LIMIT_PER_HOUR = "nope";
    resolveImportRateLimitPerHour();
    resolveImportRateLimitPerHour();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("what a caller is told", () => {
  it("the 429 message names the value in force", () => {
    expect(importRateLimitMessage(40)).toBe("Maximum 40 imports per hour");
  });

  it("the OpenAPI sentence names the variable and the default", () => {
    expect(IMPORT_RATE_LIMIT_DOC).toContain("`IMPORT_RATE_LIMIT_PER_HOUR`");
    expect(IMPORT_RATE_LIMIT_DOC).toMatch(/^5 an hour by default/);
  });
});
