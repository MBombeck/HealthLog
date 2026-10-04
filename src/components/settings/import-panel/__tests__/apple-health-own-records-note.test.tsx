/**
 * The note under a finished Apple Health import that says how many records
 * were left out because HealthLog wrote them into Apple Health itself.
 *
 * The count is often 1, and a single string rendered "1 Einträge". The note
 * reads the plural tier of the active locale, so each locale's own singular
 * (and the Polish few form) reaches the screen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { MessageBundle } from "@/lib/i18n/load-locale";
import { locales, type Locale } from "@/lib/i18n/config";

import { AppleHealthOwnRecordsNote } from "../apple-health-import-card";

function bundle(locale: Locale): MessageBundle {
  return JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as MessageBundle;
}

function render(locale: Locale, count: number): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale} initialMessages={bundle(locale)}>
      <AppleHealthOwnRecordsNote count={count} />
    </I18nProvider>,
  )
    .replace(/<[^>]+>/g, "")
    .trim();
}

describe("<AppleHealthOwnRecordsNote>", () => {
  it("uses the singular for one record", () => {
    expect(render("de", 1)).toMatch(/^1 Eintrag,/);
    expect(render("en", 1)).toMatch(/^1 record that/);
    expect(render("es", 1)).toContain("1 registro que");
    expect(render("fr", 1)).toMatch(/^1 enregistrement que/);
    expect(render("it", 1)).toMatch(/^1 registrazione che/);
    expect(render("pl", 1)).toContain("1 wpis,");
  });

  it("uses the plural for several, and the Polish few form for 2 to 4", () => {
    expect(render("de", 5)).toMatch(/^5 Einträge,/);
    expect(render("en", 5)).toMatch(/^5 records that/);
    expect(render("pl", 3)).toContain("3 wpisy,");
    expect(render("pl", 5)).toContain("5 wpisów,");
  });

  it("renders a sentence with the count in every locale", () => {
    for (const locale of locales) {
      for (const count of [1, 2, 5]) {
        const text = render(locale, count);
        expect(text, `${locale} ${count}`).toContain(String(count));
        expect(text, `${locale} ${count}`).not.toContain("writtenByHealthLog");
      }
    }
  });
});
