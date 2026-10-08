/**
 * Which sections of a day a caller sees (v1.42, #613): a switched-off module
 * leaves without a word, a section the grant does not cover is named once,
 * and the environment rows are the owner's alone.
 */
import { describe, expect, it } from "vitest";

import { DAY_SECTION_KEYS } from "@/lib/day/contract";
import { MODULE_KEYS, type ModuleKey } from "@/lib/modules/registry";
import { SHARE_DOMAINS } from "@/lib/sharing/scope";

import {
  DAY_SECTION_SHARE_DOMAIN,
  measurementTypeVisible,
  resolveDayAccessFrom,
} from "../sections";

const ALL_ON = Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as Record<
  ModuleKey,
  boolean
>;

describe("day access", () => {
  it("opens every section to the owner", () => {
    const access = resolveDayAccessFrom({
      modules: ALL_ON,
      domainVisible: () => true,
      owner: true,
    });
    expect([...access.readable].sort()).toEqual([...DAY_SECTION_KEYS].sort());
    expect(access.notShared).toEqual([]);
  });

  it("leaves a switched-off module's section out without naming it", () => {
    const access = resolveDayAccessFrom({
      modules: { ...ALL_ON, mood: false, timeline: false },
      domainVisible: () => true,
      owner: true,
    });
    expect(access.readable.has("mood")).toBe(false);
    expect(access.readable.has("lifeEvents")).toBe(false);
    expect(access.notShared).toEqual([]);
    expect(access.moduleOff).toEqual(
      expect.arrayContaining(["mood", "lifeEvents"]),
    );
  });

  it("reads only the domains a scoped grant covers and names the rest", () => {
    const access = resolveDayAccessFrom({
      modules: ALL_ON,
      domainVisible: (d) => d === "measurements",
      owner: false,
    });
    for (const section of DAY_SECTION_KEYS) {
      const domain = DAY_SECTION_SHARE_DOMAIN[section];
      expect(access.readable.has(section), section).toBe(
        domain === "measurements",
      );
    }
    expect(access.notShared).toEqual(
      expect.arrayContaining([
        "medications",
        "mood",
        "lifeEvents",
        "environment",
      ]),
    );
  });

  it("keeps the environment rows for the owner even under a full grant", () => {
    const access = resolveDayAccessFrom({
      modules: ALL_ON,
      domainVisible: () => true,
      owner: false,
    });
    expect(access.readable.has("environment")).toBe(false);
    expect(access.notShared).toEqual(["environment"]);
  });

  it("maps every section to a real sharing domain or to the owner", () => {
    for (const section of DAY_SECTION_KEYS) {
      const domain = DAY_SECTION_SHARE_DOMAIN[section];
      if (domain !== null) expect(SHARE_DOMAINS).toContain(domain);
    }
    expect(DAY_SECTION_SHARE_DOMAIN.lifeEvents).toBe("profile");
  });

  it("narrows readings type by type through their own module", () => {
    expect(measurementTypeVisible("WEIGHT", { ...ALL_ON })).toBe(true);
    expect(
      measurementTypeVisible("HEART_RATE_VARIABILITY", {
        ...ALL_ON,
        recovery: false,
      }),
    ).toBe(false);
  });
});

describe("life-event coverage", () => {
  it("reaches to the end of a coarse date", async () => {
    const { lastDayCovered } = await import("@/lib/life-events/dates");
    expect(lastDayCovered("2023-09-14", "DAY")).toBe("2023-09-14");
    expect(lastDayCovered("2024-02-01", "MONTH")).toBe("2024-02-29");
    expect(lastDayCovered("2023-12-01", "MONTH")).toBe("2023-12-31");
    expect(lastDayCovered("2019-01-01", "YEAR")).toBe("2019-12-31");
  });
});
