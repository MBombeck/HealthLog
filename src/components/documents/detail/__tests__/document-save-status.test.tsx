import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { DocumentSaveStatus } from "../detail-sections";

/**
 * #1403 — the detail sheet saves title, kind and date on commit and has no
 * Save button, so a person who edited three fields closed it believing
 * nothing had been written. The status line is what tells them.
 */
function render(props: Parameters<typeof DocumentSaveStatus>[0]) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentSaveStatus {...props} />
    </I18nProvider>,
  );
}

describe("DocumentSaveStatus", () => {
  it("renders nothing before any edit", () => {
    expect(render({ error: null, pending: false, saved: false })).toBe("");
  });

  it("says the write is in flight", () => {
    const html = render({ error: null, pending: true, saved: false });
    expect(html).toContain('data-slot="document-detail-saving"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Saving…");
  });

  it("confirms a saved edit as a polite status", () => {
    const html = render({ error: null, pending: false, saved: true });
    expect(html).toContain('data-slot="document-detail-saved"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Changes saved");
  });

  it("shows a newer edit in flight rather than the older confirmation", () => {
    const html = render({ error: null, pending: true, saved: true });
    expect(html).toContain("Saving…");
    expect(html).not.toContain("Changes saved");
  });

  it("lets a failed write win over everything else", () => {
    const html = render({
      error: "Could not save",
      pending: false,
      saved: true,
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not save");
    expect(html).not.toContain('role="status"');
  });
});
