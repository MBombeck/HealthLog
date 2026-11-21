import { describe, expect, it } from "vitest";

import type { DayEvent } from "../contract";
import { withDoseOffsets } from "../dose-offsets";

function ev(
  kind: DayEvent["kind"],
  id: string,
  at: string | null,
  title = id,
): DayEvent {
  return {
    at,
    kind,
    section: kind === "intake" ? "medications" : "symptoms",
    id,
    title,
    meta: null,
    note: null,
    docs: [],
    href: null,
  };
}

describe("withDoseOffsets", () => {
  it("anchors a symptom to the nearest dose at or before it", () => {
    const out = withDoseOffsets([
      ev("intake", "i1", "2026-11-20T07:00:00Z", "Metformin"),
      ev("intake", "i2", "2026-11-20T12:00:00Z", "Ibuprofen"),
      ev("symptom", "s1", "2026-11-20T14:10:00Z", "Headache"),
      ev("symptom", "s2", "2026-11-20T09:10:00Z", "Nausea"),
    ]);
    expect(out.find((e) => e.id === "s1")?.doseOffset).toEqual({
      intakeId: "i2",
      title: "Ibuprofen",
      minutes: 130,
    });
    expect(out.find((e) => e.id === "s2")?.doseOffset).toEqual({
      intakeId: "i1",
      title: "Metformin",
      minutes: 130,
    });
  });

  it("falls back to the next dose, as a negative distance", () => {
    const [symptom] = withDoseOffsets([
      ev("symptom", "s1", "2026-11-20T06:20:00Z"),
      ev("intake", "i1", "2026-11-20T07:00:00Z", "Metformin"),
    ]);
    expect(symptom.doseOffset?.minutes).toBe(-40);
  });

  it("leaves everything else alone", () => {
    const events = [
      ev("symptom", "s1", "2026-11-20T06:20:00Z"),
      ev("intake", "i1", null, "Untimed"),
      ev("mood", "m1", "2026-11-20T08:00:00Z"),
    ];
    const out = withDoseOffsets(events);
    expect(out.every((e) => e.doseOffset === undefined)).toBe(true);
    const withDose = withDoseOffsets([
      ...events,
      ev("intake", "i2", "2026-11-20T05:00:00Z"),
    ]);
    expect(withDose.find((e) => e.id === "m1")?.doseOffset).toBeUndefined();
    expect(withDose.find((e) => e.id === "i2")?.doseOffset).toBeUndefined();
  });
});
