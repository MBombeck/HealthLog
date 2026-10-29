import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";

import { crisisResourcesForLocale } from "../crisis-resources";

describe("crisisResourcesForLocale", () => {
  it("gives a Portuguese reader with no region 112 first, then each country's lines by name", () => {
    // The web stores the folded app locale: someone in Portugal reads the
    // pt-BR bundle too, so "pt-BR" is no evidence of Brazil.
    for (const locale of ["pt-BR", "pt_BR", "pt", "pt-AO"]) {
      const set = crisisResourcesForLocale(locale);
      expect(set.emergencyNumber, locale).toBe("112");
      expect(set.resources.map((r) => r.id)).toEqual([
        "findahelpline",
        "cvv",
        "samu",
        "sns24",
        "sosVozAmiga",
      ]);
    }
    const { t } = getServerTranslator("pt-BR");
    expect(t("mentalHealth.crisisResource.cvv.name")).toContain("Brasil");
    expect(t("mentalHealth.crisisResource.samu.name")).toContain("Brasil");
    expect(t("mentalHealth.crisisResource.sns24.name")).toContain("Portugal");
    expect(t("mentalHealth.crisisResource.sosVozAmiga.name")).toContain(
      "Portugal",
    );
  });

  it("gives an explicit Brazilian region CVV and SAMU", () => {
    const set = crisisResourcesForLocale("br");
    expect(set.emergencyNumber).toBe("192");
    expect(set.resources[0]).toEqual({
      id: "cvv",
      contacts: ["188", "cvv.org.br/chat"],
    });
  });

  it("gives an explicit Portuguese region 112, SNS 24 and SOS Voz Amiga, never Brazil's lines", () => {
    for (const locale of ["pt-PT", "pt_PT", "pt-pt"]) {
      const set = crisisResourcesForLocale(locale);
      expect(set.emergencyNumber).toBe("112");
      expect(set.resources[0]).toEqual({
        id: "sns24",
        contacts: ["808 24 24 24"],
      });
      const ids = set.resources.map((r) => r.id);
      expect(ids).toContain("sosVozAmiga");
      expect(ids).not.toContain("cvv");
      expect(ids).not.toContain("samu");
    }
  });

  it("gives a Dutch reader with no region 112, then the Dutch and Belgian lines by name", () => {
    for (const locale of ["nl", "nl-SR"]) {
      const set = crisisResourcesForLocale(locale);
      expect(set.emergencyNumber, locale).toBe("112");
      expect(set.resources).toEqual([
        {
          id: "zelfmoordpreventie113",
          contacts: ["113", "0800-0113", "113.nl"],
        },
        { id: "zelfmoordlijn1813", contacts: ["1813", "zelfmoord1813.be"] },
        { id: "findahelpline", contacts: ["findahelpline.com"] },
      ]);
    }
    const { t } = getServerTranslator("nl");
    expect(
      t("mentalHealth.crisisResource.zelfmoordpreventie113.name"),
    ).toContain("Nederland");
    expect(t("mentalHealth.crisisResource.zelfmoordlijn1813.name")).toContain(
      "België",
    );
  });

  it("gives an explicit Dutch region 113 and an explicit Belgian one 1813", () => {
    for (const locale of ["nl-NL", "nl_NL"]) {
      const ids = crisisResourcesForLocale(locale).resources.map((r) => r.id);
      expect(ids, locale).toEqual(["zelfmoordpreventie113", "findahelpline"]);
    }
    for (const locale of ["nl-BE", "nl_BE", "be"]) {
      const ids = crisisResourcesForLocale(locale).resources.map((r) => r.id);
      expect(ids, locale).toEqual(["zelfmoordlijn1813", "findahelpline"]);
    }
  });

  it("names every crisis resource in every language", () => {
    // History re-derives the set from the row's stored locale and renders it
    // in whatever language the reader uses now.
    const ids = new Set(
      [
        "pt-BR",
        "pt-PT",
        "br",
        "de",
        "de-AT",
        "de-CH",
        "en-US",
        "fr",
        "nl",
      ].flatMap((l) => crisisResourcesForLocale(l).resources.map((r) => r.id)),
    );
    for (const locale of locales) {
      const { t } = getServerTranslator(locale);
      for (const id of ids) {
        const key = `mentalHealth.crisisResource.${id}.name`;
        expect(t(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });

  it("names every resource of every locale's set in that locale", () => {
    for (const locale of locales) {
      const { t } = getServerTranslator(locale);
      for (const resource of crisisResourcesForLocale(locale).resources) {
        const key = `mentalHealth.crisisResource.${resource.id}.name`;
        expect(t(key), `${locale} ${key}`).not.toBe(key);
      }
    }
  });
});
