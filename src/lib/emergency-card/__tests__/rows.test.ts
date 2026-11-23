import { describe, expect, it } from "vitest";

import type { EmergencyCardView } from "@/lib/emergency-card/card-data";
import { normaliseFields } from "@/lib/emergency-card/fields";
import {
  buildOfflineCardHtml,
  escapeHtml,
} from "@/lib/emergency-card/offline-html";
import { emergencyCardRows } from "@/lib/emergency-card/rows";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;

function view(over: Partial<EmergencyCardView>): EmergencyCardView {
  return {
    fields: [],
    bloodType: null,
    allergies: null,
    conditions: null,
    medications: null,
    pregnancy: null,
    implants: null,
    contacts: null,
    advanceDirective: null,
    organDonor: null,
    note: null,
    dateOfBirth: null,
    asOf: "2026-11-21",
    ...over,
  };
}

describe("emergencyCardRows", () => {
  it("shows only the items the card was asked for", () => {
    const rows = emergencyCardRows(
      view({ fields: ["BLOOD_TYPE"], bloodType: "O_NEG", note: "secret" }),
      t,
      "en",
    );
    expect(rows.map((r) => r.key)).toEqual(["BLOOD_TYPE"]);
    expect(rows[0].lines).toEqual(["records.emergency.bloodTypeValues.O_NEG"]);
  });

  it("says an asked-for item holds nothing rather than dropping it", () => {
    const rows = emergencyCardRows(view({ fields: ["ALLERGIES"] }), t, "en");
    expect(rows[0].lines).toEqual(["records.emergency.notRecorded"]);
    expect(rows[0].emphasise).toBe(false);
  });

  it("names the pregnancy week", () => {
    const rows = emergencyCardRows(
      view({
        fields: ["PREGNANCY"],
        pregnancy: {
          state: "PREGNANT",
          gestationalWeeks: 24,
          gestationalDays: 5,
          dueDate: null,
          deliveryDate: null,
          postpartumWeek: null,
        },
      }),
      t,
      "en",
    );
    expect(rows[0].lines[0]).toBe("emergencyCard.pregnantWeek(24,5)");
  });
});

describe("normaliseFields", () => {
  it("puts the ticked items in reading order, each once", () => {
    expect(normaliseFields(["NOTE", "BLOOD_TYPE", "NOTE"])).toEqual([
      "BLOOD_TYPE",
      "NOTE",
    ]);
  });
});

describe("buildOfflineCardHtml", () => {
  it("escapes every value and carries no script", () => {
    const html = buildOfflineCardHtml(
      view({ fields: ["NOTE"], note: '<script>alert("x")</script>' }),
      t,
      "en",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain(escapeHtml('<script>alert("x")</script>'));
    expect(html).not.toMatch(/https?:\/\//);
  });
});
