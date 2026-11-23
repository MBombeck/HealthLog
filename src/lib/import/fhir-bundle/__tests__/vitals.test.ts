import { describe, expect, it } from "vitest";

import { mapVital } from "../import";

const NOW = new Date("2026-06-01T00:00:00Z");

function observation(extra: Record<string, unknown>) {
  return {
    resourceType: "Observation",
    id: "obs-1",
    status: "final",
    category: [{ coding: [{ code: "vital-signs" }] }],
    effectiveDateTime: "2026-03-02T08:00:00Z",
    ...extra,
  };
}

describe("mapVital", () => {
  it("reads a weight in pounds as kilograms", () => {
    const rows = mapVital(
      observation({
        code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
        valueQuantity: { value: 160, unit: "lb", code: "[lb_av]" },
      }),
      "https://portal.example",
      NOW,
    );
    expect(rows).toEqual([
      expect.objectContaining({ type: "WEIGHT", value: 72.57 }),
    ]);
  });

  it("splits a blood pressure panel into its two readings", () => {
    const rows = mapVital(
      observation({
        code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
        component: [
          {
            code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] },
            valueQuantity: { value: 121, code: "mm[Hg]" },
          },
          {
            code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] },
            valueQuantity: { value: 79, code: "mm[Hg]" },
          },
        ],
      }),
      "https://portal.example",
      NOW,
    );
    expect(Array.isArray(rows) && rows.map((r) => [r.type, r.value])).toEqual([
      ["BLOOD_PRESSURE_SYS", 121],
      ["BLOOD_PRESSURE_DIA", 79],
    ]);
  });

  it("refuses a unit it does not know rather than guessing", () => {
    expect(
      mapVital(
        observation({
          code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
          valueQuantity: { value: 11, code: "[stone_av]" },
        }),
        "x",
        NOW,
      ),
    ).toEqual({ reason: "unit_mismatch" });
  });

  it("keeps one identity per issuer and resource id", () => {
    const resource = observation({
      code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
      valueQuantity: { value: 64, code: "/min" },
    });
    const a = mapVital(resource, "https://a.example", NOW);
    const b = mapVital(resource, "https://a.example", NOW);
    const c = mapVital(resource, "https://b.example", NOW);
    const id = (r: typeof a) => (Array.isArray(r) ? r[0]!.externalId : null);
    expect(id(a)).toBe(id(b));
    expect(id(a)).not.toBe(id(c));
  });

  it("reads a code only under the LOINC system itself, compared whole", () => {
    const pulse = (system: string) =>
      mapVital(
        observation({
          code: { coding: [{ system, code: "8867-4" }] },
          valueQuantity: { value: 64, code: "/min" },
        }),
        "https://a.example",
        NOW,
      );
    const type = (r: ReturnType<typeof pulse>) =>
      Array.isArray(r) ? r.map((row) => row.type) : r;

    expect(type(pulse("http://loinc.org"))).toEqual(["PULSE"]);
    expect(type(pulse("urn:oid:2.16.840.1.113883.6.1"))).toEqual(["PULSE"]);
    for (const hostile of [
      "http://evil.example/loinc.org",
      "http://loinc.org.evil.example",
      "https://notloinc.org",
    ]) {
      expect(Array.isArray(pulse(hostile))).toBe(false);
    }
  });
});
