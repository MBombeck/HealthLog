import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));

import { checkRateLimit } from "@/lib/rate-limit";

import { checkImportRateLimit } from "../import-rate-limit";

afterEach(() => {
  delete process.env.IMPORT_RATE_LIMIT_PER_HOUR;
  vi.mocked(checkRateLimit).mockClear();
});

describe("checkImportRateLimit", () => {
  it("spends the shared bucket at 5 an hour by default", async () => {
    const rl = await checkImportRateLimit("u-1");
    expect(checkRateLimit).toHaveBeenCalledWith("import:u-1", 5, 3_600_000);
    expect(rl).toMatchObject({ allowed: true, limit: 5 });
  });

  it("spends it at the configured value", async () => {
    process.env.IMPORT_RATE_LIMIT_PER_HOUR = "60";
    const rl = await checkImportRateLimit("u-1");
    expect(checkRateLimit).toHaveBeenCalledWith("import:u-1", 60, 3_600_000);
    expect(rl.limit).toBe(60);
  });

  it("falls back to 5 for an invalid value", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.IMPORT_RATE_LIMIT_PER_HOUR = "0";
    const rl = await checkImportRateLimit("u-1");
    expect(checkRateLimit).toHaveBeenCalledWith("import:u-1", 5, 3_600_000);
    expect(rl.limit).toBe(5);
  });
});
