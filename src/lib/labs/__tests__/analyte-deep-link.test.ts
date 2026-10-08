import { describe, expect, it } from "vitest";

import {
  analyteFromQuery,
  labHrefForAnalyteReading,
} from "@/lib/labs/analyte-deep-link";
import { queryKeys } from "@/lib/query-keys";

/**
 * `/labs?analyte=<name>` (MCP deep links) opens the marker page of the newest
 * reading stored under that name, and keeps the list otherwise.
 */
describe("labs analyte deep link", () => {
  it("follows a named analyte and ignores an empty or oversized one", () => {
    expect(analyteFromQuery(" Ferritin ")).toBe("Ferritin");
    expect(analyteFromQuery(null)).toBeNull();
    expect(analyteFromQuery("   ")).toBeNull();
    expect(analyteFromQuery("x".repeat(121))).toBeNull();
  });

  it("opens the marker page of the reading, and nothing without one", () => {
    expect(labHrefForAnalyteReading({ biomarkerId: "bm_1" })).toBe(
      "/labs/bm_1",
    );
    expect(labHrefForAnalyteReading({ biomarkerId: null })).toBeNull();
    expect(labHrefForAnalyteReading(undefined)).toBeNull();
  });

  it("keeps its read under the lab-results prefix, apart from the list", () => {
    const key = queryKeys.labAnalyteLink("Ferritin");
    expect(key[0]).toBe("lab-results");
    expect(key).not.toEqual(
      queryKeys.labResultsList({
        analyte: "Ferritin",
        panel: undefined,
        from: undefined,
        to: undefined,
        page: 0,
        sortDir: "desc",
      }),
    );
  });
});
