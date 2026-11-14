/**
 * #1371 — the wizard's last step edits the medication's own note.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { MEDICATION_NOTE_MAX_CHARS } from "@/lib/validations/medication";

import { Step8Summary } from "../steps/step8-summary";
import { emptyWizardPayload } from "../wizard-payload";

function render(note: string) {
  const payload = { ...emptyWizardPayload(), mode: "recurring" as const, note };
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <QueryClientProvider client={new QueryClient()}>
        <Step8Summary
          payload={payload}
          applyPartial={() => {}}
          mode="edit"
          submitError={null}
          onEditSchedule={() => {}}
          onRemoveSchedule={() => {}}
          onAddSchedule={() => {}}
        />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("<Step8Summary> note field (#1371)", () => {
  it("renders a labelled, length-capped textarea holding the note", () => {
    const html = render("30 to 60 minutes before food");
    expect(html).toMatch(/<label[^>]*for="wizard-note"[^>]*>Note<\/label>/);
    expect(html).toMatch(
      new RegExp(
        `<textarea[^>]*id="wizard-note"[^>]*maxLength="${MEDICATION_NOTE_MAX_CHARS}"`,
      ),
    );
    expect(html).toContain(">30 to 60 minutes before food</textarea>");
    expect(html).toContain("Shown on the medication and when you log a dose.");
  });

  it("keeps the iOS zoom floor: the textarea renders at 16 px on touch", () => {
    // The primitive's `text-base` (16 px) holds the viewport on focus.
    expect(render("")).toMatch(/<textarea[^>]*class="[^"]*\btext-base\b/);
  });
});
