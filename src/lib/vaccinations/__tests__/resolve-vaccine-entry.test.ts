/**
 * v1.42 (#1005) — the one resolver every consumer asks, and what the
 * person's own vaccine definitions do through it: count into each listed
 * antigen's series, take their own series length, and lose all of that the
 * moment the definition is removed, falling back to the dose's name.
 */
import { describe, expect, it } from "vitest";

import {
  componentsForDose,
  customLookupOf,
  knownAntigens,
  resolveVaccineEntry,
  type CustomVaccineDefinition,
} from "@/lib/vaccinations/resolve-vaccine-entry";
import { deriveSeries } from "@/lib/vaccinations/series";

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const monthsAgo = (months: number) => new Date(Date.now() - months * MONTH_MS);

const dtp: CustomVaccineDefinition = {
  id: "cv-dtp",
  name: "DTP from abroad",
  components: ["diphtheria", "tetanus", "pertussis"],
  typicalSeriesDoses: 3,
  boosterIntervalMonths: 120,
};
const customs = customLookupOf([dtp]);

describe("resolveVaccineEntry", () => {
  it("resolves a catalogue slug, with its citation", () => {
    const entry = resolveVaccineEntry({ antigenSlug: "tdap" });
    expect(entry?.kind).toBe("catalog");
    expect(entry?.slug).toBe("tdap");
    expect(entry?.source).not.toBeNull();
    expect(entry?.components).toEqual(["tetanus", "diphtheria", "pertussis"]);
  });

  it("resolves the person's own definition in the same shape, uncited", () => {
    const entry = resolveVaccineEntry({ customVaccineId: "cv-dtp" }, customs);
    expect(entry).toMatchObject({
      kind: "custom",
      slug: null,
      customVaccineId: "cv-dtp",
      name: "DTP from abroad",
      atc: null,
      category: null,
      source: null,
      typicalSeriesDoses: 3,
      boosterIntervalMonths: 120,
    });
    expect(entry?.components).toEqual(["diphtheria", "tetanus", "pertussis"]);
  });

  it("lets the catalogue win when a dose carries both", () => {
    const entry = resolveVaccineEntry(
      { antigenSlug: "influenza", customVaccineId: "cv-dtp" },
      customs,
    );
    expect(entry?.kind).toBe("catalog");
    expect(entry?.components).toEqual(["influenza"]);
  });

  it("answers null for nothing it knows: no arm, a dead slug, an unknown or removed definition", () => {
    expect(resolveVaccineEntry({})).toBeNull();
    expect(resolveVaccineEntry({ antigenSlug: "no-such-slug" })).toBeNull();
    expect(
      resolveVaccineEntry({ customVaccineId: "cv-missing" }, customs),
    ).toBeNull();
    expect(resolveVaccineEntry({ customVaccineId: "cv-dtp" })).toBeNull();
    const removed = customLookupOf([{ ...dtp, deletedAt: new Date() }]);
    expect(
      resolveVaccineEntry({ customVaccineId: "cv-dtp" }, removed),
    ).toBeNull();
  });

  it("drops antigens the catalogue does not know, and duplicates, but keeps the rest", () => {
    expect(
      knownAntigens(["tetanus", "unicorn-pox", "tetanus", "rabies"]),
    ).toEqual(["tetanus", "rabies"]);
    const odd = customLookupOf([
      { ...dtp, id: "cv-odd", components: ["unicorn-pox", "cholera"] },
    ]);
    expect(componentsForDose({ customVaccineId: "cv-odd" }, odd)).toEqual([
      "cholera",
    ]);
  });
});

describe("a dose logged against an own definition, in the series", () => {
  it("counts into each listed antigen, at that antigen's own position", () => {
    const history = [
      // Two catalogue tetanus doses first, then the DTP definition.
      {
        id: "t1",
        occurredAt: monthsAgo(48),
        antigenSlug: "tetanus",
        doseNumber: null,
        seriesDoses: null,
      },
      {
        id: "t2",
        occurredAt: monthsAgo(36),
        antigenSlug: "tetanus",
        doseNumber: null,
        seriesDoses: null,
      },
      {
        id: "own",
        occurredAt: monthsAgo(12),
        antigenSlug: null,
        customVaccineId: "cv-dtp",
        doseNumber: null,
        seriesDoses: null,
      },
    ];
    const series = deriveSeries(history, customs).get("own");
    expect(series).toEqual([
      { antigen: "diphtheria", position: 1, total: 3, booster: false },
      { antigen: "tetanus", position: 3, total: 3, booster: false },
      { antigen: "pertussis", position: 1, total: 3, booster: false },
    ]);
  });

  it("places nothing once the definition is gone from the lookup", () => {
    const series = deriveSeries([
      {
        id: "own",
        occurredAt: monthsAgo(1),
        antigenSlug: null,
        customVaccineId: "cv-dtp",
        doseNumber: null,
        seriesDoses: null,
      },
    ]);
    expect(series.get("own")).toEqual([]);
  });
});
