import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { VaccinationDTO } from "@/lib/vaccinations/dto";
import type { SeriesPosition } from "@/lib/vaccinations/series";

import { VaccinationList } from "../vaccination-list";

/**
 * The list answers "what have I had" and "where does each series stand": one
 * group per component antigen, a combined dose rendered once in each of its
 * component groups with that component's own resolved position, and a
 * free-text or dead-slug record folded under its verbatim name. The numbers
 * come from the DTO — this suite never asserts a re-derivation.
 */
function record(
  over: Partial<VaccinationDTO> & { id: string; series: SeriesPosition[] },
): VaccinationDTO {
  return {
    occurredAt: "2020-01-01T00:00:00.000Z",
    antigenSlug: null,
    vaccineName: null,
    doseNumber: null,
    seriesDoses: null,
    lotNumber: null,
    site: null,
    catalogEntry: null,
    customVaccineId: null,
    customVaccine: null,
    practitioner: null,
    encounter: null,
    reminderId: null,
    note: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...over,
  };
}

function render(records: VaccinationDTO[]): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <VaccinationList records={records} />
    </I18nProvider>,
  );
}

describe("VaccinationList grouping", () => {
  it("renders a combination dose in every component group", () => {
    const tdap = record({
      id: "tdap-1",
      antigenSlug: "tdap",
      catalogEntry: { slug: "tdap", atc: "J07AJ52", category: "standard" },
      series: [
        { antigen: "tetanus", position: 3, total: 3, booster: false },
        { antigen: "diphtheria", position: 1, total: 3, booster: false },
        { antigen: "pertussis", position: 1, total: 3, booster: false },
      ],
    });
    const html = render([tdap]);

    for (const antigen of ["tetanus", "diphtheria", "pertussis"]) {
      expect(html).toContain(`data-antigen="${antigen}"`);
    }
    // Three appearances of the one record — one per component group.
    const appearances = html.match(/data-vaccination-id="tdap-1"/g) ?? [];
    expect(appearances).toHaveLength(3);
  });

  it("places a monovalent and a combo in the same antigen group with per-component positions", () => {
    const tetanus = record({
      id: "tet-1",
      antigenSlug: "tetanus",
      catalogEntry: { slug: "tetanus", atc: "J07AM01", category: "standard" },
      occurredAt: "2010-05-05T00:00:00.000Z",
      series: [{ antigen: "tetanus", position: 2, total: 3, booster: false }],
    });
    const tdap = record({
      id: "tdap-2",
      antigenSlug: "tdap",
      catalogEntry: { slug: "tdap", atc: "J07AJ52", category: "standard" },
      series: [
        { antigen: "tetanus", position: 3, total: 3, booster: false },
        { antigen: "pertussis", position: 1, total: 3, booster: false },
      ],
    });
    const html = render([tetanus, tdap]);

    // The tetanus group holds both doses; the pertussis group only the Tdap.
    const tetanusSection = html.slice(html.indexOf('data-antigen="tetanus"'));
    expect(tetanusSection).toContain('data-vaccination-id="tet-1"');
    expect(html).toContain('data-antigen="pertussis"');
    // Dose 3 of 3 renders as resolved text, never recomputed.
    expect(html).toContain("Dose 3 of 3");
  });

  it("renders a booster past the series end as a booster, not a position", () => {
    const html = render([
      record({
        id: "boost-1",
        antigenSlug: "tetanus",
        catalogEntry: { slug: "tetanus", atc: "J07AM01", category: "standard" },
        series: [{ antigen: "tetanus", position: 4, total: 3, booster: true }],
      }),
    ]);
    expect(html).toContain("Booster");
    expect(html).not.toContain("Dose 4 of 3");
  });

  it("folds a free-text and a dead-slug record under their verbatim name", () => {
    const free = record({
      id: "free-1",
      vaccineName: "Some old vaccine",
      series: [],
    });
    const deadSlug = record({
      id: "dead-1",
      antigenSlug: "retired-antigen",
      vaccineName: "Retired brand",
      catalogEntry: null,
      series: [],
    });
    const html = render([free, deadSlug]);

    expect(html).toContain('data-antigen="free"');
    expect(html).toContain("Some old vaccine");
    expect(html).toContain("Retired brand");
    // A free-text row shows no series sentence — nothing is guessed.
    const freeSection = html.slice(
      html.indexOf('data-vaccination-id="free-1"'),
    );
    expect(freeSection.slice(0, 400)).not.toContain(
      'data-slot="vaccination-series"',
    );
  });
});

describe("VaccinationList renewal state (#1005)", () => {
  const tdap = record({
    id: "tdap-1",
    antigenSlug: "tdap",
    catalogEntry: { slug: "tdap", atc: "J07AJ52", category: "standard" },
    series: [
      { antigen: "tetanus", position: 3, total: 3, booster: false },
      { antigen: "pertussis", position: 1, total: 3, booster: false },
    ],
  });

  function renderWith(
    renewals: Parameters<typeof VaccinationList>[0]["renewals"],
  ): string {
    return renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <VaccinationList records={[tdap]} renewals={renewals} />
      </I18nProvider>,
    );
  }

  it("marks an overdue booster on its antigen's heading, and only there", () => {
    const html = renderWith([
      {
        antigen: "tetanus",
        reminderId: "rem-1",
        dueAt: "2026-01-10T09:00:00.000Z",
        daysUntil: -30,
        state: "overdue",
      },
    ]);
    expect(html.match(/data-slot="vaccination-renewal"/g)).toHaveLength(1);
    expect(html).toContain('data-state="overdue"');
    expect(html).toContain("Booster overdue since");
    expect(html).toContain("text-warning");
    // It sits inside the tetanus group, not the pertussis one.
    const tetanusGroup = html.slice(
      html.indexOf('data-antigen="tetanus"'),
      html.indexOf('data-antigen="pertussis"') >
        html.indexOf('data-antigen="tetanus"')
        ? html.indexOf('data-antigen="pertussis"')
        : undefined,
    );
    expect(tetanusGroup).toContain('data-slot="vaccination-renewal"');
  });

  it("tints a booster that is due soon and leaves a distant one as plain meta", () => {
    const soon = renderWith([
      {
        antigen: "tetanus",
        reminderId: "rem-1",
        dueAt: "2026-10-10T09:00:00.000Z",
        daysUntil: 16,
        state: "dueSoon",
      },
    ]);
    expect(soon).toContain("Booster due");
    expect(soon).toContain("text-info");
    const later = renderWith([
      {
        antigen: "tetanus",
        reminderId: "rem-1",
        dueAt: "2034-10-10T09:00:00.000Z",
        daysUntil: 2900,
        state: "current",
      },
    ]);
    expect(later).toContain("Next booster");
    expect(later).not.toContain("text-warning");
    expect(later).not.toContain("text-info");
  });

  it("gives each antigen its own renewal when several are planned", () => {
    const html = renderWith([
      {
        antigen: "pertussis",
        reminderId: "rem-p",
        dueAt: "2034-10-10T09:00:00.000Z",
        daysUntil: 2900,
        state: "current",
      },
      {
        antigen: "tetanus",
        reminderId: "rem-t",
        dueAt: "2026-01-10T09:00:00.000Z",
        daysUntil: -30,
        state: "overdue",
      },
    ]);
    const pertussisAt = html.indexOf('data-antigen="pertussis"');
    const tetanusAt = html.indexOf('data-antigen="tetanus"');
    const [first, second] =
      pertussisAt < tetanusAt
        ? [html.slice(pertussisAt, tetanusAt), html.slice(tetanusAt)]
        : [html.slice(tetanusAt, pertussisAt), html.slice(pertussisAt)];
    const pertussis = pertussisAt < tetanusAt ? first : second;
    const tetanus = pertussisAt < tetanusAt ? second : first;
    expect(pertussis).toContain('data-state="current"');
    expect(pertussis).not.toContain('data-state="overdue"');
    expect(tetanus).toContain('data-state="overdue"');
  });

  it("shows nothing when there is no renewal or the grant withholds it", () => {
    expect(renderWith([])).not.toContain("vaccination-renewal");
    expect(renderWith(null)).not.toContain("vaccination-renewal");
  });
});
