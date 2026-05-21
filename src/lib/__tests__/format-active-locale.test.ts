/**
 * v1.4.43 QoL (M8) — pin the widened cookie / localStorage decoder in
 * `src/lib/format.ts`. Pre-fix a French user reading the dashboard saw
 * "12/24/2025, 2:30 PM" via the silent `en` fallback; the formatter
 * now honours every supported locale via the full `Locale` union.
 *
 * `activeLocale()` itself is module-private — exercise it through the
 * exported `formatDate` helper, which composes the cookie read with
 * `makeFormatters(locale)`. We stub the bare-minimum `document` /
 * `window` shape the helper actually reads, so the test runs under
 * the default node environment without pulling in `jsdom`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

interface Globals {
  document?: { cookie: string };
  window?: { localStorage?: { getItem: (key: string) => string | null } };
}

describe("formatDate (cookie-driven locale)", () => {
  const globalAny = globalThis as unknown as Globals;
  let cookieValue = "";
  let storageValue: string | null = null;

  beforeEach(() => {
    vi.resetModules();
    cookieValue = "";
    storageValue = null;
    globalAny.document = {
      get cookie() {
        return cookieValue;
      },
      set cookie(value: string) {
        cookieValue = value;
      },
    };
    globalAny.window = {
      localStorage: {
        getItem: () => storageValue,
      },
    };
  });

  afterEach(() => {
    delete globalAny.document;
    delete globalAny.window;
  });

  function setCookie(locale: string) {
    cookieValue = `healthlog-locale=${locale}; path=/`;
  }

  const sample = new Date("2026-04-18T10:00:00Z");

  it("returns the de format when the cookie reads 'de'", async () => {
    setCookie("de");
    const { formatDate } = await import("../format");
    // German short-date is dd.mm.yyyy.
    expect(formatDate(sample)).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it("returns the fr format when the cookie reads 'fr'", async () => {
    setCookie("fr");
    const { formatDate } = await import("../format");
    // French short-date is dd/mm/yyyy.
    expect(formatDate(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("returns the es format when the cookie reads 'es'", async () => {
    setCookie("es");
    const { formatDate } = await import("../format");
    // Spanish short-date is dd/mm/yyyy.
    expect(formatDate(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("returns the it format when the cookie reads 'it'", async () => {
    setCookie("it");
    const { formatDate } = await import("../format");
    // Italian short-date is dd/mm/yyyy.
    expect(formatDate(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("returns the pl format when the cookie reads 'pl'", async () => {
    setCookie("pl");
    const { formatDate } = await import("../format");
    // Polish short-date is dd.mm.yyyy.
    expect(formatDate(sample)).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it("falls back to en for unrecognised cookie values", async () => {
    setCookie("xx");
    const { formatDate } = await import("../format");
    // English short-date is mm/dd/yyyy.
    expect(formatDate(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("falls back to en when the cookie is missing and storage is unset", async () => {
    // cookieValue starts as "" — no match.
    const { formatDate } = await import("../format");
    expect(formatDate(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("falls back to localStorage when the cookie is unrecognised", async () => {
    setCookie("xx");
    storageValue = "fr";
    const { formatDate } = await import("../format");
    // French short-date is dd/mm/yyyy — confirms the storage path is hit.
    expect(formatDate(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });
});
