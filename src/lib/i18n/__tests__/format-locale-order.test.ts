/**
 * v1.4.27 B6 — `format.dateShort` / `timeShort` / `dateTime` ordering.
 *
 * Each shipped locale carries a `format.*` namespace that documents
 * its native date-pattern ordering as i18n strings. The actual
 * formatting still routes through `Intl.*` via
 * `src/lib/format-locale.ts`; the format keys exist so downstream
 * surfaces (PDF export, email templates, CSV docstrings) can render
 * the date hint without a JS context.
 *
 * This smoke test pins the ordering per locale so a copy-paste
 * regression that flips DD/MM to MM/DD on the French bundle would
 * fail fast.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGES = join(__dirname, "../../../../messages");

function loadFormat(locale: string): {
  dateShort: string;
  timeShort: string;
  dateTime: string;
} {
  const bundle = JSON.parse(
    readFileSync(join(MESSAGES, `${locale}.json`), "utf8"),
  );
  const fmt = bundle.format as
    | { dateShort?: string; timeShort?: string; dateTime?: string }
    | undefined;
  if (!fmt || !fmt.dateShort || !fmt.timeShort || !fmt.dateTime) {
    throw new Error(`Locale ${locale} is missing the format namespace`);
  }
  return fmt as { dateShort: string; timeShort: string; dateTime: string };
}

describe("locale-native format ordering", () => {
  it("DE renders day-month-year with dot separators", () => {
    const fmt = loadFormat("de");
    expect(fmt.dateShort).toBe("{day}.{month}.{year}");
    expect(fmt.dateTime).toBe("{day}.{month}.{year} {hour}:{minute}");
    expect(fmt.timeShort).toBe("{hour}:{minute}");
  });

  it("EN renders month-day-year with slash separators", () => {
    const fmt = loadFormat("en");
    expect(fmt.dateShort).toBe("{month}/{day}/{year}");
    expect(fmt.dateTime).toBe("{month}/{day}/{year} {hour}:{minute}");
    expect(fmt.timeShort).toBe("{hour}:{minute}");
  });

  it.each([["fr"], ["es"], ["it"]])(
    "%s renders day-month-year with slash separators (native ordering)",
    (locale) => {
      const fmt = loadFormat(locale);
      expect(fmt.dateShort).toBe("{day}/{month}/{year}");
      expect(fmt.dateTime).toBe("{day}/{month}/{year} {hour}:{minute}");
      expect(fmt.timeShort).toBe("{hour}:{minute}");
    },
  );

  it("PL renders day-month-year with dot separators (native ordering)", () => {
    const fmt = loadFormat("pl");
    expect(fmt.dateShort).toBe("{day}.{month}.{year}");
    expect(fmt.dateTime).toBe("{day}.{month}.{year} {hour}:{minute}");
    expect(fmt.timeShort).toBe("{hour}:{minute}");
  });
});
