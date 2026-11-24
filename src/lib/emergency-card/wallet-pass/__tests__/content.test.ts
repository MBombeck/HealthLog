import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";

import { buildPassContent, firstPhoneNumber } from "../content";
import { buildPassFiles } from "../bundle";
import {
  assertWalletPassJson,
  type PassField,
  type WalletPassJson,
} from "../pass-json";
import { parsePassStrings } from "../strings";

import { MINIMAL_INPUT, NONCE, SAMPLE_INPUT, SAMPLE_VIEW } from "./fixture";

const GOLDEN = "./__golden__";

function allFields(pass: WalletPassJson): PassField[] {
  return [
    ...Object.values(pass.posterGeneric),
    ...Object.values(pass.generic),
  ].flat();
}

function chars(text: string): number {
  return [...text].length;
}

describe("pass.json", () => {
  it("matches the golden pass for a full card", async () => {
    const { passJson } = buildPassContent(SAMPLE_INPUT);
    await expect(JSON.stringify(passJson, null, 2)).toMatchFileSnapshot(
      `${GOLDEN}/pass-full.json`,
    );
  });

  it("matches the golden pass for a blood-type-only card", async () => {
    const { passJson } = buildPassContent(MINIMAL_INPUT);
    await expect(JSON.stringify(passJson, null, 2)).toMatchFileSnapshot(
      `${GOLDEN}/pass-minimal.json`,
    );
  });

  it("puts the name large and alone, the facts short, the rest behind", () => {
    const { passJson } = buildPassContent(SAMPLE_INPUT);
    const poster = passJson.posterGeneric;
    expect(poster.primaryFields[0]).toEqual({
      key: "name",
      value: "Alex Example",
    });
    expect(poster.primaryFields.map((f) => f.key)).toEqual([
      "name",
      "blood",
      "allergy",
      "pregnancy",
    ]);
    expect(poster.primaryFields.slice(1).map((f) => f.value)).toEqual([
      "A+",
      "Penicillin +2",
      "Week 23+4",
    ]);
    expect(poster.primaryFields[2].label).toBe("SEVERE ALLERGY");
    expect(poster.footerFields.map((f) => f.key)).toEqual(["as_of"]);
    expect(poster.additionalInfoFields.map((f) => f.key).slice(0, 11)).toEqual([
      "f_blood_type",
      "f_allergies",
      "f_conditions",
      "f_medications",
      "f_pregnancy",
      "f_implants",
      "f_contacts",
      "f_advance_directive",
      "f_organ_donor",
      "f_note",
      "f_date_of_birth",
    ]);
    expect(passJson.generic.backFields).toEqual(poster.additionalInfoFields);
    expect(passJson.sharingProhibited).toBe(true);
    expect(passJson.barcodes?.[0].message).toBe(SAMPLE_INPUT.linkUrl);
    expect(passJson.expirationDate).toBe("2027-11-24T10:00:00Z");
  });

  it("titles the card itself when the name is not shown, and dates the header", () => {
    const { passJson } = buildPassContent({
      ...SAMPLE_INPUT,
      view: {
        ...SAMPLE_VIEW,
        fields: SAMPLE_VIEW.fields.filter((f) => f !== "NAME"),
      },
    });
    expect(passJson.posterGeneric.primaryFields[0]).toEqual({
      key: "name",
      value: "Emergency card",
    });
    expect(passJson.posterGeneric.headerFields[0].key).toBe("as_of");
    expect(JSON.stringify(passJson)).not.toContain("Alex Example");
  });

  it("never puts health data in a header", () => {
    const variants = [SAMPLE_INPUT, MINIMAL_INPUT];
    for (const input of variants) {
      for (const locale of locales) {
        const { passJson } = buildPassContent({ ...input, locale });
        const headers = [
          ...passJson.posterGeneric.headerFields,
          ...passJson.generic.headerFields,
        ];
        for (const f of headers) {
          // The neutral title, or a date.
          expect(["kind", "as_of"]).toContain(f.key);
          if (f.key === "as_of") expect(f.dateStyle).toBe("PKDateStyleMedium");
        }
      }
    }
  });

  it("keeps each style inside its field limits, and the schema refuses more", () => {
    const { passJson } = buildPassContent(SAMPLE_INPUT);
    const g = passJson.generic;
    expect(
      g.secondaryFields.length + g.auxiliaryFields.length,
    ).toBeLessThanOrEqual(4);
    const extra = { key: "extra", value: "x" };
    expect(() =>
      assertWalletPassJson({
        ...passJson,
        posterGeneric: {
          ...passJson.posterGeneric,
          primaryFields: [...passJson.posterGeneric.primaryFields, extra],
        },
      }),
    ).toThrow(/primaryFields/);
    expect(() =>
      assertWalletPassJson({
        ...passJson,
        generic: {
          ...g,
          auxiliaryFields: [...g.auxiliaryFields, extra, extra],
        },
      }),
    ).toThrow(/at most four/);
    expect(() =>
      assertWalletPassJson({ ...passJson, locations: [] }),
    ).toThrow();
  });

  it("carries a call button only for a contacts card with a number", () => {
    expect(buildPassContent(SAMPLE_INPUT).passJson.featuredActions).toEqual([
      { identifier: "ice", type: "call", url: "tel:+491700000000" },
    ]);
    expect(
      buildPassContent({
        ...SAMPLE_INPUT,
        view: {
          ...SAMPLE_VIEW,
          fields: SAMPLE_VIEW.fields.filter((f) => f !== "CONTACTS"),
        },
      }).passJson.featuredActions,
    ).toBeUndefined();
    const contacts = buildPassContent(
      SAMPLE_INPUT,
    ).passJson.generic.backFields.find((f) => f.key === "f_contacts");
    expect(contacts?.dataDetectorTypes).toEqual([
      "PKDataDetectorTypePhoneNumber",
    ]);
  });

  it("reads the first phone number in the contacts", () => {
    expect(firstPhoneNumber("Sam +49 (170) 123-4567")).toBe("+491701234567");
    expect(firstPhoneNumber("River 030 / 1234 5678")).toBe("03012345678");
    expect(firstPhoneNumber("Sam, room 101\n+44 20 7946 0000")).toBe(
      "+442079460000",
    );
    expect(firstPhoneNumber("no number here")).toBeNull();
    expect(firstPhoneNumber("012")).toBeNull();
    expect(firstPhoneNumber(null)).toBeNull();
  });

  it("withdrawn: no code, no button, no name, no health data", () => {
    const { passJson, strings } = buildPassContent({
      ...SAMPLE_INPUT,
      voidedOnDay: "2026-12-01",
    });
    expect(passJson.voided).toBe(true);
    expect(passJson.barcodes).toBeUndefined();
    expect(passJson.featuredActions).toBeUndefined();
    expect(allFields(passJson).some((f) => f.key.startsWith("f_"))).toBe(false);
    const everything = JSON.stringify({ passJson, strings });
    for (const secret of ["Alex Example", "Penicillin", "Insulin", "hlm_"]) {
      expect(everything).not.toContain(secret);
    }
    expect(passJson.posterGeneric.primaryFields[0].value).toBe("Withdrawn");
  });

  it("never carries an item the card was not asked for, in any file", () => {
    // A view that holds more than its fields allow, as a loader bug would.
    const leaky = {
      ...SAMPLE_INPUT,
      view: { ...SAMPLE_VIEW, fields: ["BLOOD_TYPE" as const] },
    };
    const files = buildPassFiles(buildPassContent(leaky), NONCE, new Map());
    const text = [...files.values()]
      .map((b) => new TextDecoder().decode(b))
      .join("\n");
    for (const secret of [
      "Alex Example",
      "Penicillin",
      "Type 1 diabetes",
      "Insulin",
      "Sam Example",
      "glucose tablets",
      "1990",
      "tel:",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("A+");
  });
});

describe("pass.strings", () => {
  const content = buildPassContent(SAMPLE_INPUT);
  const files = buildPassFiles(content, NONCE, new Map());

  function table(locale: string): Map<string, string> {
    const bytes = files.get(`${locale}.lproj/pass.strings`);
    expect(bytes, locale).toBeDefined();
    return parsePassStrings(new TextDecoder().decode(bytes));
  }

  it("exists for every language, with the nonce first", () => {
    for (const locale of locales) {
      const text = new TextDecoder().decode(
        files.get(`${locale}.lproj/pass.strings`),
      );
      expect(text.startsWith(`"_n" = "${NONCE}";\n`)).toBe(true);
    }
  });

  it("has an entry for every text of pass.json in every language", () => {
    const texts = new Set<string>([
      content.passJson.description,
      content.passJson.barcodes?.[0].altText ?? "",
    ]);
    for (const f of allFields(content.passJson)) {
      if (f.label) texts.add(f.label);
      if (!f.dateStyle) texts.add(f.value);
    }
    for (const locale of locales) {
      const entries = table(locale);
      const missing = [...texts].filter((t) => !entries.has(t));
      expect(missing, locale).toEqual([]);
    }
  });

  it("maps whole rows into the language, the owner's free text as entered", () => {
    const de = table("de");
    expect(de.get("SEVERE ALLERGY")).toBe("SCHWERE ALLERGIE");
    expect(de.get("A+")).toBe("A Rh+");
    expect(de.get("Penicillin, Severe, Hives\nPeanuts, Moderate\nLatex")).toBe(
      "Penicillin, Schwer, Hives\nPeanuts, Mittel\nLatex",
    );
    expect(de.get("Week 23+4")).toBe("SSW 23+4");
    expect(table("ko").get("EMERGENCY CARD")).toBe("응급 카드");
  });

  it("keeps the front short enough in every language", () => {
    for (const locale of locales) {
      const { passJson } = buildPassContent({ ...SAMPLE_INPUT, locale });
      const poster = passJson.posterGeneric;
      const frontLabels = [
        ...poster.primaryFields,
        ...poster.footerFields,
        ...passJson.generic.primaryFields,
        ...passJson.generic.secondaryFields,
        ...passJson.generic.auxiliaryFields,
      ]
        .map((f) => f.label)
        .filter((l): l is string => Boolean(l));
      for (const label of frontLabels) {
        expect(chars(label), `${locale}: ${label}`).toBeLessThanOrEqual(18);
      }
      const kind = passJson.generic.headerFields[0].value;
      expect(chars(kind), `${locale}: ${kind}`).toBeLessThanOrEqual(16);
      const alt = passJson.barcodes?.[0].altText ?? "";
      expect(chars(alt), `${locale}: ${alt}`).toBeLessThanOrEqual(40);
    }
  });
});
