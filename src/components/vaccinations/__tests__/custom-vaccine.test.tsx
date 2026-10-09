/**
 * v1.42 (#1005) — the person's own vaccines on the client: the booster offer
 * a dose logged against one raises, the name it carries in the list, and the
 * body the definition sheet sends.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { VaccinationDTO } from "@/lib/vaccinations/dto";

import { boosterOfferFor } from "../booster-mint-prompt";
import { customVaccineBody } from "../custom-vaccine-sheet";
import { draftHasIdentity, draftToBody, emptyDraft } from "../vaccination-form";
import { VaccinationList } from "../vaccination-list";

const OWN = {
  id: "cv-1",
  name: "Travel combo",
  components: ["typhoid", "hepatitis-a"],
  typicalSeriesDoses: 1,
  boosterIntervalMonths: 36,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function dose(over: Partial<VaccinationDTO>): VaccinationDTO {
  return {
    id: "dose-1",
    occurredAt: "2026-02-01T00:00:00.000Z",
    antigenSlug: null,
    vaccineName: null,
    doseNumber: null,
    seriesDoses: null,
    lotNumber: null,
    site: null,
    catalogEntry: null,
    customVaccineId: OWN.id,
    customVaccine: OWN,
    series: [
      { antigen: "typhoid", position: 1, total: 1, booster: false },
      { antigen: "hepatitis-a", position: 1, total: 1, booster: false },
    ],
    practitioner: null,
    encounter: null,
    reminderId: null,
    note: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...over,
  };
}

describe("the booster offer", () => {
  it("is raised for an own vaccine with an interval, under its own name", () => {
    expect(boosterOfferFor(dose({}))).toEqual({
      intervalMonths: 36,
      slug: null,
      name: "Travel combo",
    });
  });

  it("is not raised for an own vaccine without an interval, or a removed one", () => {
    expect(
      boosterOfferFor(
        dose({ customVaccine: { ...OWN, boosterIntervalMonths: null } }),
      ),
    ).toBeNull();
    expect(boosterOfferFor(dose({ customVaccine: null }))).toBeNull();
  });
});

describe("the list", () => {
  it("files the dose under each antigen, marked with the own vaccine's name", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <VaccinationList records={[dose({})]} />
      </I18nProvider>,
    );
    expect(html).toContain('data-antigen="typhoid"');
    expect(html).toContain('data-antigen="hepatitis-a"');
    expect(html.match(/>Travel combo</g)).toHaveLength(2);
  });
});

describe("the forms", () => {
  it("accepts an own vaccine as the dose's only identity and sends it", () => {
    const draft = emptyDraft({ customVaccineId: "cv-1" });
    expect(draftHasIdentity(draft)).toBe(true);
    expect(draftToBody(draft)).toMatchObject({
      customVaccineId: "cv-1",
      antigenSlug: null,
      vaccineName: null,
    });
  });

  it("sends a definition only with a name and a disease, antigens in catalogue order", () => {
    expect(
      customVaccineBody({
        name: "  ",
        components: ["tetanus"],
        typicalSeriesDoses: "",
        boosterIntervalMonths: "",
      }),
    ).toBeNull();
    expect(
      customVaccineBody({
        name: "X",
        components: [],
        typicalSeriesDoses: "",
        boosterIntervalMonths: "",
      }),
    ).toBeNull();
    expect(
      customVaccineBody({
        name: " Travel combo ",
        components: ["typhoid", "tetanus"],
        typicalSeriesDoses: "2",
        boosterIntervalMonths: "",
      }),
    ).toEqual({
      name: "Travel combo",
      components: ["tetanus", "typhoid"],
      typicalSeriesDoses: 2,
      boosterIntervalMonths: null,
    });
  });
});
