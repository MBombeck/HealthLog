/**
 * #1430 — the registry search table. Every template, the encoding of the
 * medication name (umlauts, Polish and Spanish letters, slashes, the
 * characters a registry's own parser splits on), and the property the table
 * exists for: a link is only ever `https:` on the entry's own host.
 */
import { describe, expect, it } from "vitest";

import {
  MEDICINE_REGISTRIES,
  MEDICINE_REGISTRY_CHOICES,
  buildLeafletSearch,
  isMedicineRegistryChoice,
  registryHost,
  strengthFromDose,
  type MedicineRegistry,
} from "@/lib/medications/leaflet-registries";

const RAMIPRIL = { name: "Ramipril", dose: "5mg" };

/** Where each registry's own search reads the query from. */
function queryOf(registry: MedicineRegistry, url: string): string | null {
  const parsed = new URL(url);
  switch (registry) {
    case "PL":
      return parsed.searchParams.get("name");
    case "ES":
      return parsed.searchParams.get("multiple");
    case "FR":
      return parsed.searchParams.get("txtCaracteres");
    case "GB":
      return parsed.searchParams.get("search");
    case "BE": {
      const raw = parsed.searchParams.get("search");
      return raw === null ? null : (JSON.parse(raw) as { term: string }).term;
    }
    case "NL": {
      // `f?p=111:2::SEARCH::2:<items>:<values>`, the value backslash-quoted.
      const p = parsed.searchParams.get("p") ?? "";
      const values = p.split(":").at(-1) ?? "";
      const quoted = /\\(.*)\\$/.exec(values);
      return quoted ? quoted[1] : null;
    }
    case "US":
      return parsed.searchParams.get("query");
    case "AU":
      return parsed.searchParams.get("keywords");
    case "BR": {
      const hashQuery = parsed.hash.split("?")[1] ?? "";
      return new URLSearchParams(hashQuery).get("nomeProduto");
    }
    case "DE":
    case "CA":
    case "EU":
      return null;
  }
}

describe("buildLeafletSearch", () => {
  it.each(MEDICINE_REGISTRIES)(
    "%s builds an https link on its own host",
    (registry) => {
      const search = buildLeafletSearch(registry, RAMIPRIL);
      expect(search).not.toBeNull();
      const url = new URL(search!.url);
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe(registryHost(registry));
      expect(search!.host).toBe(registryHost(registry));
      expect(search!.registry).toBe(registry);
      expect(search!.authority.length).toBeGreaterThan(0);
    },
  );

  it.each(MEDICINE_REGISTRIES)(
    "%s carries exactly what its prefill says",
    (registry) => {
      const search = buildLeafletSearch(registry, RAMIPRIL)!;
      const query = queryOf(registry, search.url);
      switch (search.prefill) {
        case "nameAndStrength":
          expect(query).toBe("Ramipril 5 mg");
          expect(search.searchTerm).toBe("Ramipril 5 mg");
          break;
        case "name":
          expect(query).toBe("Ramipril");
          expect(search.searchTerm).toBe("Ramipril");
          break;
        case "none":
          // The page opens empty; the person is told what to type.
          expect(query).toBeNull();
          expect(search.url).not.toContain("Ramipril");
          expect(search.searchTerm).toBe("Ramipril");
          break;
      }
    },
  );

  it("pins the verified templates", () => {
    const url = (r: MedicineRegistry) => buildLeafletSearch(r, RAMIPRIL)!.url;
    expect(url("PL")).toBe(
      "https://rejestry.ezdrowie.gov.pl/rpl/search?name=Ramipril",
    );
    expect(url("DE")).toBe("https://portal.bfarm.de/amguifree/");
    expect(url("ES")).toBe(
      "https://cima.aemps.es/cima/publico/lista.html?multiple=Ramipril",
    );
    expect(url("FR")).toBe(
      "https://base-donnees-publique.medicaments.gouv.fr/?choixRecherche=medicament&txtCaracteres=Ramipril",
    );
    expect(url("GB")).toBe(
      "https://products.mhra.gov.uk/search/?search=Ramipril&page=1",
    );
    expect(url("BE")).toBe(
      "https://medicinesdatabase.be/human-use/medicines?search=%7B%22term%22%3A%22Ramipril%205%20mg%22%7D",
    );
    expect(url("NL")).toBe(
      "https://www.geneesmiddeleninformatiebank.nl/ords/f?p=111:2::SEARCH::2:P0_DOMAIN,P0_LANG,P2_QS:H,NL,%5CRamipril%5C",
    );
    expect(url("US")).toBe(
      "https://dailymed.nlm.nih.gov/dailymed/search.cfm?labeltype=all&query=Ramipril",
    );
    expect(url("CA")).toBe("https://health-products.canada.ca/dpd-bdpp/");
    expect(url("AU")).toBe(
      "https://www.tga.gov.au/resources/artg?keywords=Ramipril%205%20mg",
    );
    expect(url("BR")).toBe(
      "https://consultas.anvisa.gov.br/#/bulario/?nomeProduto=Ramipril",
    );
    expect(url("EU")).toBe("https://www.ema.europa.eu/en/medicines");
  });

  it.each([
    ["umlaut", "Bisoprolol-ratiopharm Ä"],
    ["Polish letters", "Polprazol łagodny"],
    ["Spanish letters", "Nolotil España ñ"],
    ["a slash", "Ibuprofen/Paracetamol"],
    ["a question mark and a hash", "Vitamin D? #1"],
    ["a plus", "Amlodipine + Valsartan"],
  ])("encodes %s so the registry reads the name back", (_label, name) => {
    for (const registry of MEDICINE_REGISTRIES) {
      const search = buildLeafletSearch(registry, { name, dose: "" })!;
      const url = new URL(search.url);
      // Nothing in the name may move the link to another origin or path.
      expect(url.host).toBe(registryHost(registry));
      expect(url.protocol).toBe("https:");
      const query = queryOf(registry, search.url);
      if (search.prefill === "none") {
        expect(query).toBeNull();
      } else if (registry === "NL") {
        // APEX reads `:` and `\` as syntax; the template spaces them out.
        expect(query).toBe(name.replace(/[\\:]/g, " "));
      } else {
        expect(query).toBe(name);
      }
    }
  });

  it("spaces out the characters CIMA and APEX split on", () => {
    const es = buildLeafletSearch("ES", { name: "A&B=C 50%", dose: "" })!;
    expect(new URL(es.url).searchParams.get("multiple")).toBe("A B C 50");
    const nl = buildLeafletSearch("NL", { name: "Foo:Bar\\Baz", dose: "" })!;
    expect(nl.url).toContain("%5CFoo%20Bar%20Baz%5C");
    expect(nl.url).not.toContain("%3A");
  });

  it("a name with a comma stays one APEX value", () => {
    const nl = buildLeafletSearch("NL", { name: "Ramipril 2,5", dose: "" })!;
    expect(queryOf("NL", nl.url)).toBe("Ramipril 2,5");
  });

  it("adds the strength only once, and only where the registry takes it", () => {
    expect(
      buildLeafletSearch("AU", { name: "Ramipril 5 mg", dose: "5 mg" })!
        .searchTerm,
    ).toBe("Ramipril 5 mg");
    expect(
      buildLeafletSearch("AU", { name: "Ramipril", dose: "1 tablet" })!
        .searchTerm,
    ).toBe("Ramipril");
    expect(
      buildLeafletSearch("US", { name: "Ramipril", dose: "5mg" })!.searchTerm,
    ).toBe("Ramipril");
  });

  it("answers null for no registry, NONE, or a blank name", () => {
    expect(buildLeafletSearch("NONE", RAMIPRIL)).toBeNull();
    expect(buildLeafletSearch(null, RAMIPRIL)).toBeNull();
    expect(buildLeafletSearch(undefined, RAMIPRIL)).toBeNull();
    expect(buildLeafletSearch("PL", { name: "   ", dose: "5mg" })).toBeNull();
  });

  it("collapses whitespace in the name", () => {
    expect(
      buildLeafletSearch("PL", { name: "  Ramipril \n Teva ", dose: "" })!
        .searchTerm,
    ).toBe("Ramipril Teva");
  });
});

describe("strengthFromDose", () => {
  it.each([
    ["5mg", "5 mg"],
    ["2,5 mg", "2,5 mg"],
    ["0.5 ml", "0.5 ml"],
    ["0.5 mL", "0.5 ml"],
    ["100 µg", "100 µg"],
    ["1000 IE", "1000 IE"],
    ["10 mg/ml", "10 mg"],
  ])("reads %s as %s", (dose, strength) => {
    expect(strengthFromDose(dose)).toBe(strength);
  });

  it.each(["1 tablet", "two puffs", "", "mg 5"])("ignores %j", (dose) => {
    expect(strengthFromDose(dose)).toBeNull();
  });
});

describe("the registry list", () => {
  it("names the twelve registries of #1430 and NONE", () => {
    expect([...MEDICINE_REGISTRY_CHOICES].sort()).toEqual(
      [
        "AU",
        "BE",
        "BR",
        "CA",
        "DE",
        "ES",
        "EU",
        "FR",
        "GB",
        "NL",
        "NONE",
        "PL",
        "US",
      ].sort(),
    );
    expect(isMedicineRegistryChoice("GB")).toBe(true);
    expect(isMedicineRegistryChoice("UK")).toBe(false);
    expect(isMedicineRegistryChoice(null)).toBe(false);
  });
});
