/**
 * v1.42 (#613) — the timeline's value selector names each option's owning
 * module itself, to keep the signal registry out of its chunk. It must give
 * the same answer the registry gives, or a switched-off module's values
 * would still be offered.
 */
import { describe, expect, it } from "vitest";

import type { MeasurementType } from "@/generated/prisma/client";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";

import { VALUE_OPTION_MODULE } from "../timeline-view";

describe("value options", () => {
  for (const [key, owner] of Object.entries(VALUE_OPTION_MODULE)) {
    if (key === "MOOD") continue;
    it(`${key} is owned by ${owner ?? "no module"}`, () => {
      expect(moduleForMeasurementType(key as MeasurementType)).toBe(owner);
    });
  }

  it("ties mood to the mood module", () => {
    expect(VALUE_OPTION_MODULE.MOOD).toBe("mood");
  });
});
