/**
 * A card's action row is its last element (design standards §12). The
 * family-history card on a shared record carries a sentence about relatives;
 * it sits above the list, whose manager closes with the card's actions.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/components/records/allergy-manager", () => ({
  AllergyManager: () => null,
}));
vi.mock("@/components/records/family-history-manager", () => ({
  FamilyHistoryManager: () => (
    <div data-slot="settings-card-actions">family-actions</div>
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { RecordAnamnesisSection } from "../record-anamnesis-section";

describe("<RecordAnamnesisSection> card order", () => {
  it("puts the relatives sentence above the family list and its actions", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <RecordAnamnesisSection />
      </I18nProvider>,
    );
    const note = html.indexOf('data-slot="record-anamnesis-relative-note"');
    const actions = html.indexOf("family-actions");
    expect(note).toBeGreaterThan(-1);
    expect(actions).toBeGreaterThan(note);
  });
});
