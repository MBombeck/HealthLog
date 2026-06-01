/**
 * v1.7.2 W3 — the `/medications/[id]` detail page IS the history view.
 *
 * Editing and advanced settings are reached from the medications-list
 * card kebab only; the detail page is purely history-centric. Source-
 * level guards (the page is a client component with `use()` + hooks, so
 * a full render is heavier than the contract warrants):
 *   - no `TodaysDoseCard` import or render (lives only on the list page);
 *   - no `isToday` / `todayEvent` derivations (dead once the card is
 *     gone);
 *   - no `landingIntent` / `wizardIntent` / `openWizardWithIntent`
 *     plumbing;
 *   - the page no longer hosts the wizard, the `AdvancedSettingsSheet`,
 *     the `MedicationDetailHeader` action row, or an editable cadence
 *     ("Rhythmus") block — those moved to the card kebab. It renders the
 *     read-only `MedicationDetailSummary` + the intake-history table.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/app/medications/[id]/page.tsx"),
  "utf8",
);

describe("medication detail page is the history view (W3)", () => {
  it("does not import or render TodaysDoseCard", () => {
    expect(source).not.toContain("TodaysDoseCard");
    expect(source).not.toContain("todays-dose-card");
  });

  it("drops the dead isToday / todayEvent derivations", () => {
    expect(source).not.toContain("isToday");
    expect(source).not.toContain("todayEvent");
  });

  it("drops the landingIntent plumbing", () => {
    expect(source).not.toContain("landingIntent");
    expect(source).not.toContain("wizardIntent");
    expect(source).not.toContain("openWizardWithIntent");
  });

  it("no longer hosts the wizard, advanced sheet, detail-header, or cadence row", () => {
    // v1.7.2 W3 — editing + advanced moved to the medications-list card
    // kebab; the detail page carries none of those affordances.
    expect(source).not.toContain("AdvancedSettingsSheet");
    expect(source).not.toContain("MedicationWizardDialog");
    expect(source).not.toContain("MedicationDetailHeader");
    expect(source).not.toContain("CadenceSummaryRow");
    expect(source).not.toContain("hideEdit");
  });

  it("renders the read-only summary header + the intake-history table", () => {
    expect(source).toContain("MedicationDetailSummary");
    expect(source).toContain("IntakeHistoryPreview");
  });
});
