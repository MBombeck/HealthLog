import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The one product constraint this whole feature exists to hold: **a visit
 * saves with a date and nothing else.**
 *
 * Three properties, each of which has an obvious way to get broken by a later
 * "improvement":
 *
 *   - no field but the date can block Save;
 *   - the status is DERIVED from the date on a new visit, never asked;
 *   - a link picker whose module is off is BLANK, not empty — an empty picker
 *     for a switched-off module advertises a feature that is not there.
 */

let modules: Record<string, boolean> = {};

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ canManage: true, canWrite: true }),
}));

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return {
    ...actual,
    apiGet: () => new Promise(() => {}),
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import {
  EncounterForm,
  draftFromEncounter,
  derivedStatus,
  draftInstant,
  draftToBody,
  emptyDraft,
} from "../encounter-form";

/**
 * The form body, rendered directly rather than through its sheet: the sheet is
 * a Radix portal and renders nothing at all under `renderToStaticMarkup`, so a
 * test that went through it would assert against an empty string and pass for
 * the wrong reason.
 */
function renderForm(over?: {
  modules?: Record<string, boolean>;
  isEdit?: boolean;
}) {
  modules = over?.modules ?? {};
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <EncounterForm
          draft={emptyDraft({ occurredAt: "2026-08-08T10:00" })}
          onChange={() => {}}
          isEdit={over?.isEdit ?? false}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("nothing but the date is required", () => {
  it("admits a draft carrying only a date", () => {
    // `draftInstant(...) !== null` is the sheet's ONLY save gate, so a draft
    // with no practitioner, no reason, no outcome and no link is saveable.
    const draft = emptyDraft({ occurredAt: "2026-08-08T10:00" });
    expect(draft.practitioner).toBeNull();
    expect(draft.reason).toBe("");
    expect(draft.documentIds).toEqual([]);
    expect(draftInstant(draft.occurredAt)).not.toBeNull();
  });

  it("refuses only when the date itself cannot be read", () => {
    expect(draftInstant("not a date")).toBeNull();
  });

  it("marks the date field required and nothing else", () => {
    const html = renderForm();
    const required = html.match(/aria-required="true"/g) ?? [];
    expect(required).toHaveLength(1);
    expect(html).toContain('data-testid="encounter-occurred-at"');
  });

  it("turns a date-only draft into a complete write body", () => {
    const body = draftToBody(emptyDraft({ occurredAt: "2026-08-08T10:00" }), {
      isEdit: false,
    });
    expect(body).not.toBeNull();
    expect(body?.practitionerId).toBeNull();
    expect(body?.reason).toBeNull();
    expect(body?.outcome).toBeNull();
    expect(body?.documentIds).toEqual([]);
  });

  it("refuses to build a body from a date that does not parse", () => {
    expect(
      draftToBody(emptyDraft({ occurredAt: "not a date" }), { isEdit: false }),
    ).toBeNull();
  });
});

describe("editing never unfiles what the visit already collected", () => {
  it("seeds the link arrays from the row's own links", () => {
    // The defect this pins: an edit seeded from a row that did not know its
    // links would save a replace-set of three EMPTY arrays and silently
    // unfile everything. The list carries the links so this cannot happen.
    const draft = draftFromEncounter({
      id: "e1",
      occurredAt: "2026-08-01T09:00:00.000Z",
      status: "DONE",
      kind: "ROUTINE",
      practitioner: null,
      reason: null,
      outcome: null,
      bodySite: null,
      laterality: null,
      reminderNextDueAt: null,
      links: {
        documents: [{ id: "d1", label: "Letter", date: null, redacted: false }],
        labResults: [{ id: "l1", label: "LDL", date: null, redacted: false }],
        conditions: [{ id: "c1", label: "Knee", date: null, redacted: false }],
      },
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
    });
    expect(draft.documentIds).toEqual(["d1"]);
    expect(draft.labResultIds).toEqual(["l1"]);
    expect(draft.episodeIds).toEqual(["c1"]);

    const body = draftToBody(draft, { isEdit: true });
    expect(body?.documentIds).toEqual(["d1"]);
    expect(body?.labResultIds).toEqual(["l1"]);
    expect(body?.episodeIds).toEqual(["c1"]);
  });
});

describe("the status follows the date on a new visit", () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");

  it("reads a future instant as a booked appointment", () => {
    expect(derivedStatus("2026-08-09T09:00", now)).toBe("PLANNED");
  });

  it("reads a past instant as a visit that happened", () => {
    expect(derivedStatus("2026-08-07T09:00", now)).toBe("DONE");
  });

  it("never asks for the status on a new visit", () => {
    // The picker is what "asked" would look like; its absence is the property.
    expect(renderForm()).not.toContain('id="encounter-status"');
  });

  it("carries the derived status into the body rather than the draft default", () => {
    const body = draftToBody(
      emptyDraft({ occurredAt: "2999-01-01T09:00", status: "DONE" }),
      { isEdit: false },
    );
    expect(body?.status).toBe("PLANNED");
  });

  it("uses the draft's own status on an edit, where it is editable", () => {
    const body = draftToBody(
      emptyDraft({ occurredAt: "2999-01-01T09:00", status: "CANCELLED" }),
      { isEdit: true },
    );
    expect(body?.status).toBe("CANCELLED");
  });
});

describe("the link pickers follow the modules that own their targets", () => {
  it("renders no link block at all when all three modules are off", () => {
    const html = renderForm({ modules: {} });
    expect(html).not.toContain('data-slot="encounter-link-pickers"');
    expect(html).not.toContain('data-slot="encounter-link-documents"');
    expect(html).not.toContain('data-slot="encounter-link-labs"');
    expect(html).not.toContain('data-slot="encounter-link-conditions"');
  });

  it("blanks the block of a disabled module while keeping its neighbours", () => {
    const html = renderForm({
      modules: { inboundDocuments: true, labs: false, illness: false },
    });
    expect(html).toContain('data-slot="encounter-link-documents"');
    // Not "renders an empty list" — absent.
    expect(html).not.toContain('data-slot="encounter-link-labs"');
    expect(html).not.toContain('data-slot="encounter-link-conditions"');
  });

  it("offers all three when all three modules are on", () => {
    const html = renderForm({
      modules: { inboundDocuments: true, labs: true, illness: true },
    });
    expect(html).toContain('data-slot="encounter-link-documents"');
    expect(html).toContain('data-slot="encounter-link-labs"');
    expect(html).toContain('data-slot="encounter-link-conditions"');
    // The positive control: without it the three assertions above would pass
    // against a component that never renders any block.
    expect(html).toContain('data-slot="encounter-link-pickers"');
  });
});

/**
 * v1.39.1 — the body site. Shown for a procedure, where it means something,
 * and kept visible on any visit that already carries one, so switching the
 * kind away never hides text the person typed. Never required.
 *
 * Mutation checks (each run, each seen red):
 *   - show the field only for PROCEDURE → "keeps a typed site visible after
 *     the kind moves away" goes red;
 *   - send `bodySite` untrimmed → the whitespace case goes red.
 */
describe("the body site", () => {
  function renderDraft(over: Parameters<typeof emptyDraft>[0]) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLocale="en">
          <EncounterForm
            draft={emptyDraft({ occurredAt: "2026-08-08T10:00", ...over })}
            onChange={() => {}}
            isEdit
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
  }

  it("offers the site and the side for a procedure", () => {
    const html = renderDraft({ kind: "PROCEDURE" });
    expect(html).toContain('id="encounter-body-site"');
    expect(html).toContain('id="encounter-laterality"');
    expect(html).toContain("Body site");
    expect(html).toContain("Not stated");
  });

  it("keeps the fields off an ordinary visit", () => {
    const html = renderDraft({ kind: "ROUTINE" });
    expect(html).not.toContain('id="encounter-body-site"');
  });

  it("keeps a typed site visible after the kind moves away", () => {
    const html = renderDraft({ kind: "HOSPITAL", bodySite: "Knee" });
    expect(html).toContain('id="encounter-body-site"');
  });

  it("offers Procedure or surgery among the kinds", () => {
    const html = renderDraft({ kind: "OTHER" });
    expect(html).toContain('value="PROCEDURE"');
    expect(html).toContain("Procedure or surgery");
  });

  it("sends the site trimmed and the side, and null for an empty site", () => {
    const withSite = draftToBody(
      emptyDraft({
        occurredAt: "2026-08-08T10:00",
        kind: "PROCEDURE",
        bodySite: "  Knee ",
        laterality: "LEFT",
      }),
      { isEdit: false },
    );
    expect(withSite?.bodySite).toBe("Knee");
    expect(withSite?.laterality).toBe("LEFT");

    const empty = draftToBody(
      emptyDraft({ occurredAt: "2026-08-08T10:00", bodySite: "   " }),
      { isEdit: false },
    );
    expect(empty?.bodySite).toBeNull();
    expect(empty?.laterality).toBeNull();
  });

  it("seeds the site and the side from the row being edited", () => {
    const draft = draftFromEncounter({
      id: "e1",
      occurredAt: "2026-08-01T09:00:00.000Z",
      status: "DONE",
      kind: "PROCEDURE",
      practitioner: null,
      reason: null,
      outcome: null,
      bodySite: "Knee",
      laterality: "RIGHT",
      reminderNextDueAt: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      updatedAt: "2026-08-01T09:00:00.000Z",
    });
    expect(draft.bodySite).toBe("Knee");
    expect(draft.laterality).toBe("RIGHT");
  });
});
