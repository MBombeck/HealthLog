import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { locales } from "@/lib/i18n/config";

/**
 * The GKI tile sits in a two-column grid, about 150 px of text wide at phone
 * width and in the 420 px day layer alike. The pair line under the index has
 * to fit there whole, so both readings stay readable; the worded pair goes to
 * assistive tech.
 */

const POINT = {
  at: "2026-11-01T08:00:00.000Z",
  value: 3.8,
  ketoneId: "k1",
  glucoseId: "g1",
  glucoseAt: "2026-11-01T08:00:00.000Z",
  ketonesMmol: 0.25,
  glucoseMmol: 12.5,
};

async function render(locale: string) {
  const { I18nProvider } = await import("@/lib/i18n/context");
  const { DayGkiTile } = await import("../day-gki-tile");
  const messages = (await import(`../../../../messages/${locale}.json`))
    .default;
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale as never} initialMessages={messages}>
      <DayGkiTile points={[POINT]} />
    </I18nProvider>,
  );
}

function visiblePair(html: string): string {
  const match = html.match(
    /<span aria-hidden="true" class="[^"]*truncate text-xs[^"]*">([^<]*)<\/span>/,
  );
  if (!match) throw new Error(`no visible pair line in ${html}`);
  return match[1]!;
}

describe("<DayGkiTile>", () => {
  it.each([...locales])(
    "keeps the pair line short enough for the tile in %s",
    async (locale) => {
      const line = visiblePair(await render(locale));
      expect(line).toMatch(/12[.,]5/);
      expect(line).toMatch(/0[.,]25/);
      expect(line.length).toBeLessThanOrEqual(20);
    },
  );

  it("names both readings for assistive tech", async () => {
    const html = await render("en");
    expect(html).toMatch(
      /<span class="sr-only">Glucose 12\.5 mmol\/L \/ ketones 0\.25 mmol\/L<\/span>/,
    );
  });
});
