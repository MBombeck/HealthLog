/**
 * The owner's card opens every line where it is kept; the same sheet without
 * targets (the read-only view) draws no link at all.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { EmergencyCardView } from "@/lib/emergency-card/card-data";
import { emergencyCardTargets } from "@/lib/emergency-card/edit-targets";

import { EmergencyCardSheet } from "../emergency-card-sheet";

const t = (key: string) => key;

const view: EmergencyCardView = {
  fields: ["ALLERGIES", "CONDITIONS", "MEDICATIONS", "IMPLANTS"],
  name: null,
  bloodType: null,
  allergies: [{ substance: "Penicillin", severity: "SEVERE", reaction: null }],
  conditions: ["Asthma"],
  medications: [{ name: "Metformin", dose: "500 mg" }],
  pregnancy: null,
  implants: null,
  contacts: null,
  advanceDirective: null,
  organDonor: null,
  note: null,
  dateOfBirth: null,
  asOf: "2026-11-24",
};

describe("EmergencyCardSheet", () => {
  it("links each line of the owner's card to its surface", () => {
    const html = renderToStaticMarkup(
      <EmergencyCardSheet
        view={view}
        t={t}
        locale="en"
        targets={emergencyCardTargets({
          conditionEpisodeIds: ["ep1"],
          medicationIds: ["med1"],
          modules: { illness: true, medications: true },
        })}
      />,
    );
    expect(html).toContain('href="/settings/anamnesis#allergies"');
    expect(html).toContain('href="/illness/ep1"');
    expect(html).toContain('href="/medications/med1"');
    // An empty item opens the place to fill it in.
    expect(html).toContain('href="/settings/anamnesis#emergency"');
    expect(html.match(/data-slot="emergency-card-line-link"/g)).toHaveLength(4);
  });

  it("draws no link without targets", () => {
    const html = renderToStaticMarkup(
      <EmergencyCardSheet view={view} t={t} locale="en" />,
    );
    expect(html).not.toContain("<a ");
  });
});
