import { describe, it, expect } from "vitest";
import {
  makeFormatters,
  parseLocaleFromAcceptLanguage,
  resolveIntlLocale,
} from "../format-locale";

describe("resolveIntlLocale", () => {
  it("maps short locales to BCP-47 tags", () => {
    expect(resolveIntlLocale("de")).toBe("de-DE");
    expect(resolveIntlLocale("en")).toBe("en-US");
  });
});

describe("parseLocaleFromAcceptLanguage", () => {
  it("returns en for null / empty", () => {
    expect(parseLocaleFromAcceptLanguage(null)).toBe("en");
    expect(parseLocaleFromAcceptLanguage("")).toBe("en");
  });

  it("returns de for primary German tag", () => {
    expect(parseLocaleFromAcceptLanguage("de-DE,en;q=0.9")).toBe("de");
    expect(parseLocaleFromAcceptLanguage("de")).toBe("de");
    expect(parseLocaleFromAcceptLanguage("de-CH")).toBe("de");
  });

  it("returns en for English or unknown locales", () => {
    expect(parseLocaleFromAcceptLanguage("en-US,en;q=0.9")).toBe("en");
    expect(parseLocaleFromAcceptLanguage("fr-FR,fr;q=0.9")).toBe("en");
    expect(parseLocaleFromAcceptLanguage("*")).toBe("en");
  });
});

describe("makeFormatters", () => {
  const deFmt = makeFormatters("de");
  const enFmt = makeFormatters("en");
  const sample = new Date("2026-04-18T14:30:00Z"); // 16:30 Europe/Berlin (CEST)

  it("formats numbers with regional decimal separators", () => {
    expect(deFmt.number(70.5, 1)).toMatch(/70,5/);
    expect(enFmt.number(70.5, 1)).toMatch(/70\.5/);
  });

  it("formats integers with thousands separators", () => {
    expect(deFmt.integer(1234567)).toMatch(/1[.\u202f]234[.\u202f]567/);
    expect(enFmt.integer(1234567)).toBe("1,234,567");
  });

  it("formats percent", () => {
    expect(deFmt.percent(0.835, 1)).toMatch(/83,5\s*%/);
    expect(enFmt.percent(0.835, 1)).toMatch(/83\.5%/);
  });

  it("formats date in Europe/Berlin", () => {
    // Both should include day/month/year; locale-specific order differs.
    expect(deFmt.date(sample)).toContain("2026");
    expect(enFmt.date(sample)).toContain("2026");
  });

  it("formats 24h time in Europe/Berlin regardless of locale", () => {
    expect(deFmt.time(sample)).toBe("16:30");
    expect(enFmt.time(sample)).toBe("16:30");
  });
});
