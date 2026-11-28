import { describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";

import { buildPassContent, firstPhoneNumber, FOOTER_MAX } from "../content";
import { buildPassFiles } from "../bundle";
import {
  assertWalletPassJson,
  type PassField,
  type WalletPassJson,
} from "../pass-json";
import { parsePassStrings } from "./pass-strings-reader";

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

  it("fills the front by urgency: name, a pregnancy beside it, a warning below", () => {
    const { passJson } = buildPassContent(SAMPLE_INPUT);
    const poster = passJson.posterGeneric;
    expect(passJson.logoText).toBe("Emergency card");
    expect(poster.headerFields.map((f) => f.key)).toEqual(["as_of"]);
    expect(poster.primaryFields).toEqual([
      { key: "name", label: "Name", value: "Alex Example" },
      { key: "pregnancy", label: "Pregnancy", value: "Week 23+4" },
    ]);
    // Under "Severe allergy" only further severe ones count: there are none.
    expect(poster.footerFields).toEqual([
      { key: "alert", value: "Severe allergy: Penicillin" },
    ]);
    expect(poster.additionalInfoFields.map((f) => f.key)).toEqual([
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
    // Medical detail in the info sheet, where the pass came from on the back.
    expect(poster.backFields.map((f) => f.key)).toEqual([
      "m_valid",
      "m_issuer",
      "m_signer",
      "m_note",
    ]);
    const g = passJson.generic;
    expect(g.headerFields).toEqual(poster.headerFields);
    expect(g.primaryFields).toEqual([poster.primaryFields[0]]);
    expect(g.secondaryFields.map((f) => [f.key, f.value])).toEqual([
      ["allergy", "Penicillin"],
      ["blood", "A positive"],
    ]);
    expect(g.auxiliaryFields).toEqual([
      { key: "pregnancy", label: "Week", value: "23+4" },
    ]);
    expect(g.backFields).toEqual([
      ...poster.additionalInfoFields,
      ...poster.backFields,
    ]);
    expect(passJson.sharingProhibited).toBe(true);
    expect(passJson.barcodes?.[0].message).toBe(SAMPLE_INPUT.linkUrl);
    expect(passJson.barcodes?.[0].altText).toBe("Scan to open the full card");
    expect(passJson.expirationDate).toBe("2027-11-24T10:00:00Z");
  });

  it("puts the most urgent warning first when the name is not shown", () => {
    const without = (...drop: string[]) =>
      buildPassContent({
        ...SAMPLE_INPUT,
        view: {
          ...SAMPLE_VIEW,
          fields: SAMPLE_VIEW.fields.filter((f) => !drop.includes(f)),
        },
      }).passJson;
    const noName = without("NAME");
    expect(noName.posterGeneric.primaryFields).toEqual([
      { key: "allergy", label: "Severe allergy", value: "Penicillin" },
      { key: "pregnancy", label: "Pregnancy", value: "Week 23+4" },
    ]);
    expect(noName.posterGeneric.footerFields).toEqual([
      { key: "alert", value: "Type 1 diabetes" },
    ]);
    // The generic row leaves out what the title already shows.
    expect(noName.generic.secondaryFields.map((f) => f.key)).toEqual([
      "blood",
      "pregnancy",
    ]);
    expect(JSON.stringify(noName)).not.toContain("Alex Example");

    const noWarning = without("NAME", "ALLERGIES", "CONDITIONS");
    expect(noWarning.posterGeneric.primaryFields.map((f) => f.key)).toEqual([
      "blood",
      "pregnancy",
    ]);
    expect(noWarning.posterGeneric.footerFields).toEqual([]);

    // A name and no pregnancy: the blood type stands beside the name.
    const notPregnant = without("PREGNANCY");
    expect(notPregnant.posterGeneric.primaryFields.map((f) => f.key)).toEqual([
      "name",
      "blood",
    ]);

    // Nothing urgent asked for: the card names itself.
    const contactsOnly = buildPassContent({
      ...SAMPLE_INPUT,
      view: { ...SAMPLE_VIEW, fields: ["CONTACTS"] },
    }).passJson;
    expect(contactsOnly.posterGeneric.primaryFields).toEqual([
      { key: "title", value: "Emergency card" },
    ]);
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
          // Only a date.
          expect(f.key).toBe("as_of");
          expect(f.dateStyle).toBe("PKDateStyleMedium");
        }
      }
    }
  });

  it("writes labels in the language's own case", () => {
    for (const locale of locales) {
      const { passJson } = buildPassContent({ ...SAMPLE_INPUT, locale });
      for (const f of allFields(passJson)) {
        if (!f.label || chars(f.label) <= 3) continue; // "SSW", "SA"
        const upper = f.label.toLocaleUpperCase(locale);
        // Scripts without case (Hangul) read the same either way.
        if (upper === f.label.toLocaleLowerCase(locale)) continue;
        expect(f.label, `${locale}: ${f.key}`).not.toBe(upper);
      }
    }
  });

  it("keeps each style inside its field limits, and the schema refuses more", () => {
    const { passJson } = buildPassContent(SAMPLE_INPUT);
    const g = passJson.generic;
    expect(
      g.secondaryFields.length + g.auxiliaryFields.length,
    ).toBeLessThanOrEqual(3);
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
          auxiliaryFields: [...g.auxiliaryFields, extra],
        },
      }),
    ).toThrow(/at most three/);
    expect(() =>
      assertWalletPassJson({ ...passJson, locations: [] }),
    ).toThrow();
  });

  it("counts only what the allergy label claims", () => {
    const front = (allergies: (typeof SAMPLE_VIEW)["allergies"]) => {
      const { passJson } = buildPassContent({
        ...SAMPLE_INPUT,
        view: { ...SAMPLE_VIEW, allergies },
      });
      return {
        field: passJson.generic.secondaryFields.find(
          (f) => f.key === "allergy",
        ),
        footer: passJson.posterGeneric.footerFields[0]?.value,
      };
    };
    expect(
      front([
        { substance: "Penicillin", severity: "SEVERE", reaction: null },
        { substance: "Bee venom", severity: "SEVERE", reaction: null },
        { substance: "Peanuts", severity: "MODERATE", reaction: null },
        { substance: "Latex", severity: null, reaction: null },
      ]),
    ).toEqual({
      field: {
        key: "allergy",
        label: "Severe allergy",
        value: "Penicillin +1",
      },
      footer: "Severe allergy: Penicillin +1",
    });
    expect(
      front([
        { substance: "Peanuts", severity: "MODERATE", reaction: null },
        { substance: "Latex", severity: null, reaction: null },
      ]),
    ).toEqual({
      field: { key: "allergy", label: "Allergy", value: "Peanuts +1" },
      footer: "Allergy: Peanuts +1",
    });
  });

  it("keeps the warning one line in every language, a long substance cut", () => {
    const allergies = [
      {
        substance: "Trimethoprim-sulfamethoxazole and related sulfonamides",
        severity: "SEVERE" as const,
        reaction: null,
      },
      { substance: "Bee venom", severity: "SEVERE" as const, reaction: null },
    ];
    for (const locale of locales) {
      const { passJson } = buildPassContent({
        ...SAMPLE_INPUT,
        locale,
        view: { ...SAMPLE_VIEW, allergies },
      });
      const footer = passJson.posterGeneric.footerFields[0].value;
      expect(chars(footer), `${locale}: ${footer}`).toBeLessThanOrEqual(
        FOOTER_MAX,
      );
      expect(footer, locale).toMatch(/…\s?\+1$/);
    }
  });

  it("writes the blood type the same way front and back, in every language", () => {
    for (const locale of locales) {
      const { passJson } = buildPassContent({
        ...SAMPLE_INPUT,
        locale,
        view: {
          ...SAMPLE_VIEW,
          fields: SAMPLE_VIEW.fields.filter((f) => f !== "PREGNANCY"),
        },
      });
      const front = passJson.posterGeneric.primaryFields.find(
        (f) => f.key === "blood",
      );
      const back = passJson.generic.backFields.find(
        (f) => f.key === "f_blood_type",
      );
      expect(front?.value, locale).toBeTruthy();
      expect(back?.value, locale).toBe(front?.value);
      expect(
        passJson.generic.secondaryFields.find((f) => f.key === "blood")?.value,
      ).toBe(front?.value);
    }
  });

  it("carries a call button only for a contacts card with a number", () => {
    expect(buildPassContent(SAMPLE_INPUT).passJson.featuredActions).toEqual([
      { identifier: "ice", type: "call", url: "tel:+491700000000" },
    ]);
    // No text of ours on the button: Wallet labels a call action itself, in
    // the phone's language, so there is nothing for pass.strings to carry.
    const [action] = buildPassContent({ ...SAMPLE_INPUT, locale: "de" })
      .passJson.featuredActions!;
    expect(Object.keys(action).sort()).toEqual(["identifier", "type", "url"]);
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
    expect(passJson.posterGeneric.headerFields[0]).toMatchObject({
      key: "as_of",
      label: "Withdrawn",
      value: "2026-12-01T12:00:00Z",
    });
    expect(passJson.posterGeneric.primaryFields).toEqual([
      { key: "status", label: "Status", value: "Withdrawn" },
    ]);
    expect(passJson.posterGeneric.footerFields).toEqual([
      { key: "alert", value: "QR code void, no health data" },
    ]);
    expect(
      passJson.posterGeneric.additionalInfoFields.map((f) => f.key),
    ).toEqual(["m_void"]);
    expect(passJson.posterGeneric.backFields.map((f) => f.key)).toEqual([
      "m_issuer",
      "m_signer",
    ]);
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
    expect(text).toContain("A positive");
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
      content.passJson.logoText,
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
    expect(de.get("Severe allergy")).toBe("Schwere Allergie");
    expect(de.get("Severe allergy: Penicillin")).toBe(
      "Schwere Allergie: Penicillin",
    );
    expect(de.get("A positive")).toBe("A positiv");
    expect(
      de.get("Penicillin (severe): Hives\nPeanuts (moderate)\nLatex"),
    ).toBe("Penicillin (schwer): Hives\nPeanuts (mittel)\nLatex");
    expect(de.get("Week 23+4")).toBe("SSW 23+4");
    expect(de.get("Emergency card")).toBe("Notfallkarte");
    expect(table("ko").get("Emergency card")).toBe("응급 카드");
  });

  it("keeps the front short enough in every language", () => {
    for (const locale of locales) {
      for (const input of [
        SAMPLE_INPUT,
        { ...SAMPLE_INPUT, voidedOnDay: "2026-12-01" },
      ]) {
        const { passJson } = buildPassContent({ ...input, locale });
        const poster = passJson.posterGeneric;
        const g = passJson.generic;
        const front = [
          ...poster.primaryFields,
          ...g.primaryFields,
          ...g.secondaryFields,
          ...g.auxiliaryFields,
        ];
        for (const label of front.map((f) => f.label).filter(Boolean)) {
          expect(chars(label!), `${locale}: ${label}`).toBeLessThanOrEqual(18);
        }
        // Beside the name: a short value. A Russian blood type is the
        // longest one there is (15), and stays whole.
        const right = poster.primaryFields[1]?.value ?? "";
        expect(chars(right), `${locale}: ${right}`).toBeLessThanOrEqual(16);
        for (const f of poster.footerFields) {
          expect(chars(f.value), `${locale}: ${f.value}`).toBeLessThanOrEqual(
            FOOTER_MAX,
          );
        }
        expect(
          chars(passJson.logoText),
          `${locale}: ${passJson.logoText}`,
        ).toBeLessThanOrEqual(14);
        const alt = passJson.barcodes?.[0].altText ?? "";
        expect(chars(alt), `${locale}: ${alt}`).toBeLessThanOrEqual(30);
      }
    }
  });
});
