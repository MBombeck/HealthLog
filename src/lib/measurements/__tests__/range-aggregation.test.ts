import { describe, it, expect } from "vitest";
import { BUCKET_CAP } from "../range-aggregation";

describe("range-aggregation", () => {
  describe("BUCKET_CAP", () => {
    it("caps daily at 365 buckets and monthly at 24", () => {
      expect(BUCKET_CAP.daily).toBe(365);
      expect(BUCKET_CAP.monthly).toBe(24);
      expect(BUCKET_CAP.weekly).toBeGreaterThan(BUCKET_CAP.monthly);
    });
  });
});
