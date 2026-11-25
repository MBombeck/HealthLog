/**
 * The shared clinician share-link CREATE flow. It is mounted from two places
 * — Settings → Sharing and the document detail sheet's Share action — so the
 * test pins the two behaviours the document entry point relies on:
 *   1. Mounted bare (the Settings default) it renders the create form with the
 *      90-day-capped expiry, the attach affordance, the frozen-set warning,
 *      and no pre-attached document.
 *   2. Mounted with `initialDocuments` + `initialLabel` (the document flow) it
 *      pre-fills the label and seeds the attached-document chip, so sharing a
 *      document lands on a create form already scoped to it.
 *
 * SSR-static render only (no jsdom), matching the sibling settings tests. The
 * TanStack hooks are mocked; the QR (`qrcode`) only ever renders in an effect
 * after a create, so it never runs under `renderToStaticMarkup`.
 *
 * Mutation checks (each verified red, then reverted):
 *   - seed `selectedLeaves` from `STANDARD_TEMPLATE_LEAVES` again → "starts a
 *     record link with an empty scope" goes red.
 *   - drop `selectedLeaves.size === 0` from the submit `disabled` expression →
 *     "refuses to mint a record link with an empty scope" goes red.
 */
import type { ReportLeafId } from "@/lib/report-selection/catalogue";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  // The always-mounted ShareDocumentPicker reads via useQuery; the form
  // itself creates via useMutation.
  useQuery: () => ({ data: undefined, isPending: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import {
  ShareLinkCreateForm,
  buildShareLinkCreatePayload,
} from "../share-link-create-form";
import type { PickedDocument } from "../share-document-picker";

function render(
  props: {
    documentOnly?: boolean;
    initialDocuments?: PickedDocument[];
    initialLabel?: string;
  } = {},
  locale: "en" | "de" = "en",
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ShareLinkCreateForm {...props} />
    </I18nProvider>,
  );
}

/** Whether the create control refuses the press. */
function createDisabled(html: string): boolean {
  const button = html.match(
    /<button[^>]*data-testid="share-create-submit"[^>]*>/,
  )?.[0];
  if (!button) throw new Error("the create button did not render");
  return /\sdisabled=""/.test(button);
}

describe("<ShareLinkCreateForm> — shared create flow", () => {
  it("renders the create form with the 90-day-capped expiry and attach affordance", () => {
    const html = render();
    expect(html).toContain('max="90"');
    expect(html).toContain("Create link");
    expect(html).toContain('data-testid="share-attach-open"');
    expect(html).toContain("Choose documents");
  });

  it("surfaces the frozen-set warning so the write-once contract is explicit", () => {
    const html = render();
    expect(html).toContain("fixed once you create the link");
  });

  it("does not reveal a token before a create succeeds", () => {
    const html = render();
    expect(html).not.toContain('data-testid="share-token-reveal"');
  });

  it("mounts bare with no pre-attached document (the Settings default)", () => {
    const html = render();
    expect(html).not.toContain('data-testid="share-attached-chips"');
    expect(html).toContain("0 of 50 selected");
  });

  it("seeds the label and the attached-document chip from the document flow", () => {
    const html = render({
      initialDocuments: [{ id: "doc-1", title: "Blood panel 2026" }],
      initialLabel: "Blood panel 2026",
    });
    // Label pre-filled with the document title.
    expect(html).toContain('value="Blood panel 2026"');
    // The document rides in as a removable chip, and the count reflects it.
    expect(html).toContain('data-testid="share-attached-chips"');
    expect(html).toContain("Blood panel 2026");
    expect(html).toContain("1 of 50 selected");
    // A seeded set surfaces the EXIF note the picker path also shows.
    expect(html).toContain("Camera metadata");
  });

  it("starts a record link with an empty scope and the standard-report button", () => {
    const html = render();
    // A link is handed to another person; nothing rides on it that was not
    // ticked. The template is reachable in one click and applied in none.
    expect(html).toContain("Nothing selected yet");
    expect(html).toContain('data-testid="report-apply-standard-share"');
    expect(html).toContain("Apply Standard doctor report");
  });

  it("refuses to mint a record link with an empty scope, label or not", () => {
    const html = render({ initialLabel: "Cardiology" });
    expect(createDisabled(html)).toBe(true);
    // The same form in documents-only mode mints happily on the same label:
    // the refusal comes from the empty report scope, not from the label.
    const docOnly = render({
      documentOnly: true,
      initialLabel: "Cardiology",
      initialDocuments: [{ id: "doc-1", title: "Blood panel 2026" }],
    });
    expect(createDisabled(docOnly)).toBe(false);
  });

  it("document-only mode hides every record-scope control but keeps expiry + the doc", () => {
    const html = render({
      documentOnly: true,
      initialDocuments: [{ id: "doc-1", title: "Blood panel 2026" }],
      initialLabel: "Blood panel 2026",
    });
    // No record-scope UI: no FHIR toggle, no FHIR resource-type checkboxes, no
    // history-range selector — none of those apply to a document link.
    expect(html).not.toContain('id="share-fhir"');
    expect(html).not.toContain('id="share-range"');
    expect(html).not.toContain('id="share-rt-Observation"');
    // Expiry, label, and the pre-attached document all stay.
    expect(html).toContain('id="share-expiry"');
    expect(html).toContain('value="Blood panel 2026"');
    expect(html).toContain('data-testid="share-attached-chips"');
    expect(html).toContain("1 of 50 selected");
  });
});

describe("buildShareLinkCreatePayload — scope contract", () => {
  const common = {
    label: "  Blood panel 2026  ",
    rangeDays: 30,
    expiryDays: 30,
    leaves: ["WEIGHT", "LAB_RESULTS"] as ReportLeafId[],
  };

  it("document-only: empty report scope and the launched doc always rides along", () => {
    const payload = buildShareLinkCreatePayload({
      ...common,
      documentIds: ["doc-1"],
      documentOnly: true,
    });
    expect(payload.documentOnly).toBe(true);
    // The retired FHIR scope keys are gone from the wire entirely,
    // so a share link can no longer advertise a face that was never served.
    expect(payload).not.toHaveProperty("resourceTypes");
    expect(payload).not.toHaveProperty("allowFhirApi");
    // No report scope is ever sent for a document link, whatever the picker
    // above happened to be showing.
    expect(payload).not.toHaveProperty("selection");
    expect(payload).not.toHaveProperty("sections");
    // The launched document is always in the created link (pre-attach fix).
    expect(payload.documentIds).toEqual(["doc-1"]);
    expect(payload.label).toBe("Blood panel 2026");
  });

  it("record share: keeps the window scope and omits documentIds when none picked", () => {
    const payload = buildShareLinkCreatePayload({
      ...common,
      documentIds: [],
      documentOnly: false,
    });
    expect(payload.rangeEnd).toBeNull();
    // A record share carries the leaves the owner chose, and nothing else.
    expect(payload.selection).toEqual({
      v: 2,
      leaves: ["WEIGHT", "LAB_RESULTS"],
    });
    expect(payload).not.toHaveProperty("resourceTypes");
    expect(payload).not.toHaveProperty("allowFhirApi");
    expect(payload).not.toHaveProperty("documentIds");
    expect(payload).not.toHaveProperty("documentOnly");
  });

  it("record share: attaches the picked documents when the owner chose some", () => {
    const payload = buildShareLinkCreatePayload({
      ...common,
      documentIds: ["a", "b"],
      documentOnly: false,
    });
    expect(payload.documentIds).toEqual(["a", "b"]);
  });
});
