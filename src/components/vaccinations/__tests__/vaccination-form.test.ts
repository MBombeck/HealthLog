import { describe, it, expect } from "vitest";

import type { Vaccination } from "../use-vaccinations";
import {
  draftFromVaccination,
  draftHasIdentity,
  draftInstant,
  draftToBody,
  emptyDraft,
} from "../vaccination-form";

/**
 * The form's one hard rule: a dose saves with a date and ONE identity arm — a
 * catalogue pick OR the person's own wording — and nothing else. These cover
 * the body derivation that the sheet's Save gate reads.
 */
describe("vaccination form draft", () => {
  it("saves with a date and a catalogue pick alone", () => {
    const body = draftToBody(
      emptyDraft({ occurredAt: "2020-03-04", antigenSlug: "tetanus" }),
    );
    expect(body).not.toBeNull();
    expect(body!.antigenSlug).toBe("tetanus");
    expect(body!.occurredAt).toBe("2020-03-04T00:00:00.000Z");
    // Nothing else is required — the optional fields default to absences.
    expect(body!.vaccineName).toBeNull();
    expect(body!.doseNumber).toBeNull();
    expect(body!.lotNumber).toBeNull();
    expect(body!.site).toBeNull();
    expect(body!.practitionerId).toBeNull();
  });

  it("saves with a date and free text alone", () => {
    const body = draftToBody(
      emptyDraft({ occurredAt: "1987-06-01", vaccineName: "  Old brand  " }),
    );
    expect(body).not.toBeNull();
    expect(body!.antigenSlug).toBeNull();
    expect(body!.vaccineName).toBe("Old brand");
  });

  it("refuses a draft with neither identity arm", () => {
    const draft = emptyDraft({ occurredAt: "2020-01-01" });
    expect(draftHasIdentity(draft)).toBe(false);
    expect(draftToBody(draft)).toBeNull();
  });

  it("refuses a draft with no usable date", () => {
    expect(draftInstant("")).toBeNull();
    expect(draftInstant("not-a-date")).toBeNull();
    expect(
      draftToBody(emptyDraft({ occurredAt: "", antigenSlug: "tetanus" })),
    ).toBeNull();
  });

  it("carries the optional fields through when present", () => {
    const body = draftToBody(
      emptyDraft({
        occurredAt: "2021-09-09",
        antigenSlug: "tdap",
        doseNumber: "3",
        seriesDoses: "3",
        lotNumber: "AB123",
        site: "LEFT_ARM",
        note: "sore arm",
      }),
    );
    expect(body).toMatchObject({
      doseNumber: 3,
      seriesDoses: 3,
      lotNumber: "AB123",
      site: "LEFT_ARM",
      note: "sore arm",
    });
  });
});

/**
 * #1024 — a dose opened from the LIST carries no `documents` (the list omits
 * them; only the detail read has them). The edit draft used to seed that
 * absence as an empty link set and send it on Save, and the route reads a
 * present array as "replace the links with this": editing any field of a dose
 * silently unlinked every document filed against it.
 */
describe("vaccination form document links", () => {
  const listRow = {
    id: "dose-1",
    occurredAt: "2025-09-12T00:00:00.000Z",
    antigenSlug: "covid19",
    vaccineName: null,
    doseNumber: null,
    seriesDoses: null,
    lotNumber: null,
    site: null,
    catalogEntry: null,
    series: [],
    practitioner: null,
    encounter: null,
    reminderId: null,
    note: null,
    createdAt: "2025-09-12T00:00:00.000Z",
    updatedAt: "2025-09-12T00:00:00.000Z",
  } as Vaccination;

  it("an edit seeded from a list row does not claim the dose has no documents", () => {
    const draft = draftFromVaccination(listRow);
    expect(draft.documentIds).toBeNull();
  });

  it("saving such an edit leaves the links alone", () => {
    const body = draftToBody({
      ...draftFromVaccination(listRow),
      lotNumber: "AB123",
    });
    expect(body).not.toBeNull();
    expect(body).not.toHaveProperty("documentIds");
  });

  it("a detail row seeds its linked documents", () => {
    const draft = draftFromVaccination({
      ...listRow,
      documents: [
        { id: "doc-1", label: "Record", date: null, redacted: false },
      ],
    });
    expect(draft.documentIds).toEqual(["doc-1"]);
  });

  it("a deliberate unlink of every document is still sent", () => {
    const body = draftToBody({
      ...draftFromVaccination(listRow),
      documentIds: [],
    });
    expect(body!.documentIds).toEqual([]);
  });
});
