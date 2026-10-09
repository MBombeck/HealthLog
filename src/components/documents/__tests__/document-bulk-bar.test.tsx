import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The floating bulk bar, pinned via single-pass static renders: a labelled
 * toolbar carrying the selected count and the bulk verbs (set type, link
 * condition, file against a visit, share, delete, clear). Each link menu only
 * renders when the account actually has something to link to — no dead
 * affordance on an account with no episodes, and none on an account with no
 * visits either.
 */
import { I18nProvider } from "@/lib/i18n/context";
import { DocumentBulkBar } from "../document-bulk-bar";

function render(
  episodes: { id: string; label: string }[],
  encounters: { id: string; label: string }[] = [
    { id: "v1", label: "Routine visit · 01/08/2026" },
  ],
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentBulkBar
        selectedCount={3}
        episodes={episodes}
        encounters={encounters}
        busy={false}
        onSetKind={() => {}}
        onLinkEpisode={() => {}}
        onLinkEncounter={() => {}}
        onShare={() => {}}
        onRequestDelete={() => {}}
        onClear={() => {}}
      />
    </I18nProvider>,
  );
}

describe("<DocumentBulkBar>", () => {
  it("renders a labelled toolbar with count and the bulk verbs", () => {
    const html = render([{ id: "ep1", label: "Knee" }]);
    expect(html).toContain('data-slot="document-bulk-bar"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("3 selected");
    expect(html).toContain("Change type");
    expect(html).toContain("Link condition");
    expect(html).toContain("File against visit");
    expect(html).toContain('data-slot="document-bulk-share"');
    expect(html).toContain("Share");
    expect(html).toContain("Delete");
    expect(html).toContain("Clear selection");
  });

  it("clears with an X icon at the right of the count line, not a text button", () => {
    const html = render([{ id: "ep1", label: "Knee" }]);
    const countLine = html.slice(
      html.indexOf('data-slot="document-bulk-count"'),
      html.indexOf('data-slot="document-bulk-actions"'),
    );
    // The clear control lives on the count line, before the action row…
    expect(countLine).toContain('data-slot="document-bulk-clear"');
    expect(countLine).toContain('aria-label="Clear selection"');
    // …and carries no visible label: the name rides on aria-label and title.
    expect(countLine).not.toContain(">Clear selection<");
  });

  it("keeps every verb in ONE action row with Delete alone at its right edge", () => {
    const html = render([{ id: "ep1", label: "Knee" }]);
    const actions = html.slice(
      html.indexOf('data-slot="document-bulk-actions"'),
    );
    const order = [
      "document-bulk-set-kind",
      "document-bulk-link-condition",
      "document-bulk-link-visit",
      "document-bulk-share",
      "document-bulk-delete",
    ].map((slot) => actions.indexOf(`data-slot="${slot}"`));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The row never wraps into a second line, and Delete is pushed right.
    const rowTag = /<div[^>]*data-slot="document-bulk-actions"[^>]*>/.exec(
      html,
    );
    expect(rowTag?.[0]).not.toContain("flex-wrap");
    const deleteTag = /<button[^>]*data-slot="document-bulk-delete"[^>]*>/.exec(
      html,
    );
    expect(deleteTag?.[0]).toContain("ml-auto");
  });

  it("carries the selection-bar slot the Coach launcher steps aside for", () => {
    const html = render([{ id: "ep1", label: "Knee" }]);
    expect(html).toMatch(
      /^<div data-slot="selection-action-bar" class="contents">/,
    );
  });

  it("omits the link-condition verb when the account has no episodes", () => {
    const html = render([]);
    expect(html).not.toContain("Link condition");
    expect(html).toContain("Change type");
  });

  it("omits the file-against-visit verb when the account has no visits", () => {
    const html = render([{ id: "ep1", label: "Knee" }], []);
    expect(html).not.toContain("File against visit");
    expect(html).not.toContain('data-slot="document-bulk-link-visit"');
    // The positive control: the neighbouring verb is still there, so the
    // assertion above is about the visit menu and not about an empty render.
    expect(html).toContain("Link condition");
  });

  it("drops to the page edge only when the bottom bar is gone", () => {
    // The bar follows the shell, not `md`: a phone held sideways is wider
    // than `md` and still shows the bottom bar over a `md:` drop.
    const html = render([]);
    const cls =
      html.match(/data-slot="document-bulk-bar"[^>]*class="([^"]*)"/)?.[1] ??
      "";
    expect(cls).toContain("shell-desktop:bottom-6");
    expect(cls).not.toMatch(/(?<![\w-])md:bottom-/);
  });
});
