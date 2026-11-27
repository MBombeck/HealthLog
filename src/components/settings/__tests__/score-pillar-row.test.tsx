/**
 * The row states of the "what counts toward your score" surface, rendered.
 *
 * `rows.test.ts` pins the decisions; this pins that the decisions reach the
 * markup, and that each row carries the stable attributes the e2e spec
 * selects on rather than viewport-dependent text.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { Locale } from "@/lib/i18n/config";
import type { ScoreConfigRow } from "@/lib/score-config/rows";
import { ScorePillarRow } from "../score-pillar-row";
import { primeLocales } from "@/__tests__/helpers/prime-locales";

primeLocales("de", "es", "fr", "it", "pl");

function render(row: ScoreConfigRow, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ScorePillarRow row={row} onToggle={() => {}} />
    </I18nProvider>,
  );
}

const base: ScoreConfigRow = {
  id: "SLEEP",
  domain: "sleep",
  counts: true,
  eligibility: "counting",
};

describe("the row", () => {
  it("offers exactly one switch, and it is the score one", () => {
    const html = render(base);

    expect(html).toContain('data-slot="score-pillar-switch"');
    expect(html.match(/role="switch"/g) ?? []).toHaveLength(1);
    expect(html).toContain("Count Sleep toward the score");
  });

  it("says nothing about recording or showing", () => {
    // Those two belong to the modules screen. Restating them under every
    // pillar put the same two words on every row of a page about a third
    // question, and the sentence above the rows already says so once.
    const html = render(base);

    expect(html).not.toContain('data-slot="score-pillar-axes"');
    expect(html).not.toContain("Being recorded");
    expect(html).not.toContain("Shown in the app");
  });
});

describe("row attributes", () => {
  it("carries the pillar, its domain and its state", () => {
    const html = render({ ...base, counts: false, eligibility: "waiting" });

    expect(html).toContain('data-pillar="SLEEP"');
    expect(html).toContain('data-domain="sleep"');
    expect(html).toContain('data-counts="false"');
    expect(html).toContain('data-eligibility="waiting"');
  });
});

describe("selected, waiting for data", () => {
  it("renders the line for a counted pillar with nothing to score", () => {
    const html = render({ ...base, counts: true, eligibility: "waiting" });

    expect(html).toContain('data-state="waiting"');
    expect(html).toContain("Selected, waiting for data");
  });

  it("does not render it once the person switches the pillar off", () => {
    const html = render({ ...base, counts: false, eligibility: "waiting" });

    expect(html).not.toContain("Selected, waiting for data");
  });

  it("does not render it while the server has said nothing", () => {
    const html = render({ ...base, eligibility: "unknown" });

    expect(html).not.toContain('data-slot="score-pillar-state"');
  });
});

describe("wellbeing under crisis signposting", () => {
  it("is named as not counted, never as a configuration problem", () => {
    const html = render({
      ...base,
      id: "WELLBEING",
      domain: "wellbeing",
      eligibility: "crisis",
    });

    expect(html).toContain('data-state="crisis"');
    expect(html).toContain("Not counted after your last check-in");
    expect(html).toContain("Your selection is fine");
    expect(html).not.toContain("Selected, waiting for data");
  });
});

describe("a failed read", () => {
  it("is named as a failure, not as absence", () => {
    const html = render({ ...base, eligibility: "read_failed" });

    expect(html).toContain('data-state="read_failed"');
    expect(html).toContain("could not be read");
    expect(html).not.toContain("Selected, waiting for data");
  });
});

describe("localisation", () => {
  // Asserting the absence of a key path would prove nothing: `t()` falls
  // back to the English bundle, so a missing locale key renders English
  // rather than the key. Locale PARITY is already a repo-wide guard
  // (`i18n-locale-integrity`); what belongs here is that the row actually
  // reaches each locale's own words, which fails on a missing key, on an
  // English value copied into a bundle, and on a locale wired to the
  // wrong strings.
  const WAITING: Record<string, string> = {
    de: "Ausgewählt, wartet auf Daten",
    fr: "Sélectionné, en attente de données",
    es: "Seleccionado, esperando datos",
    it: "Selezionato, in attesa di dati",
    pl: "Wybrany, czeka na dane",
  };

  it("renders each locale's own words, not the English fallback", () => {
    for (const [locale, expected] of Object.entries(WAITING)) {
      const html = render(
        { ...base, eligibility: "waiting" },
        locale as Locale,
      );
      expect(html, `${locale} row`).toContain(expected);
      expect(html, `${locale} row fell back to English`).not.toContain(
        "Selected, waiting for data",
      );
    }
  });
});
