/**
 * v1.4.43 — pin the widened cookie / localStorage decoder in
 * `src/lib/format.ts`. Pre-fix a French user reading the dashboard saw
 * "12/24/2025, 2:30 PM" via the silent `en` fallback; the formatter
 * now honours every supported locale via the full `Locale` union.
 *
 * `activeLocale()` itself is module-private — exercise it through the
 * exported `formatDateTime` helper, which composes the cookie read with
 * `makeFormatters(locale)`. We stub the bare-minimum `document` /
 * `window` shape the helper actually reads, so the test runs under
 * the default node environment without pulling in `jsdom`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Globals {
  document?: { cookie: string };
  window?: { localStorage?: { getItem: (key: string) => string | null } };
}

describe("formatDateTime (cookie-driven locale)", () => {
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
    const { formatDateTime } = await import("../format");
    // German date part is dd.mm.yyyy.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\.\d{2}\.\d{4}\b/);
  });

  it("returns the fr format when the cookie reads 'fr'", async () => {
    setCookie("fr");
    const { formatDateTime } = await import("../format");
    // French date part is dd/mm/yyyy.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}\b/);
  });

  it("returns the es format when the cookie reads 'es'", async () => {
    setCookie("es");
    const { formatDateTime } = await import("../format");
    // Spanish date part is dd/mm/yyyy.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}\b/);
  });

  it("returns the it format when the cookie reads 'it'", async () => {
    setCookie("it");
    const { formatDateTime } = await import("../format");
    // Italian date part is dd/mm/yyyy.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}\b/);
  });

  it("returns the pl format when the cookie reads 'pl'", async () => {
    setCookie("pl");
    const { formatDateTime } = await import("../format");
    // Polish date part is dd.mm.yyyy.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\.\d{2}\.\d{4}\b/);
  });

  it("falls back to en for unrecognised cookie values", async () => {
    setCookie("xx");
    const { formatDateTime } = await import("../format");
    // English date part is mm/dd/yyyy.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}\b/);
  });

  it("falls back to en when the cookie is missing and storage is unset", async () => {
    // cookieValue starts as "" — no match.
    const { formatDateTime } = await import("../format");
    expect(formatDateTime(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}\b/);
  });

  it("falls back to localStorage when the cookie is unrecognised", async () => {
    setCookie("xx");
    storageValue = "fr";
    const { formatDateTime } = await import("../format");
    // French date part is dd/mm/yyyy — confirms the storage path is hit.
    expect(formatDateTime(sample)).toMatch(/^\d{2}\/\d{2}\/\d{4}\b/);
  });
});
