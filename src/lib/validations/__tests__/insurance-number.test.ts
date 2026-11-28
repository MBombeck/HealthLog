import { describe, expect, it } from "vitest";
import {
  ISO_COUNTRY_CODES,
  countryHasGroupNumber,
  formatInsuranceNumber,
  insuranceNumberRejectionCode,
  insuranceNumberRule,
  isIsoCountryCode,
  isValidAhv,
  isValidBsn,
  isValidGenericInsuranceId,
  isValidInsuranceNumber,
  isValidNir,
  isValidSvnr,
  normaliseInsuranceNumber,
  resolveInsuranceNumberCountry,
  suggestInsuranceNumberCountry,
} from "../insurance-number";

describe("isValidSvnr (AT)", () => {
  // 1237 010180 is the worked example of the published check-digit rule;
  // 4564 150395 is computed by hand from the same weights.
  it.each(["1237010180", "4564150395"])("accepts %s", (svnr) => {
    expect(isValidSvnr(svnr)).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidSvnr("1238010180")).toBe(false);
    expect(isValidSvnr("4565150395")).toBe(false);
  });

  it("rejects every number whose remainder is 10", () => {
    // Serial 100 with date part 010180 sums to 21, remainder 10.
    for (let check = 0; check <= 9; check++) {
      expect(isValidSvnr(`100${check}010180`)).toBe(false);
    }
  });

  it("rejects a leading zero, a wrong length and non-digits", () => {
    expect(isValidSvnr("0237010180")).toBe(false);
    expect(isValidSvnr("123701018")).toBe(false);
    expect(isValidSvnr("12370101800")).toBe(false);
    expect(isValidSvnr("1237 010180")).toBe(false);
    expect(isValidSvnr("A237010180")).toBe(false);
  });
});

describe("isValidAhv (CH)", () => {
  // 756.9217.0769.85 is the published sample number.
  it("accepts the sample number", () => {
    expect(isValidAhv("7569217076985")).toBe(true);
  });

  it("rejects a wrong check digit, a foreign prefix and a wrong length", () => {
    expect(isValidAhv("7569217076984")).toBe(false);
    expect(isValidAhv("7559217076985")).toBe(false);
    expect(isValidAhv("756921707698")).toBe(false);
  });
});

describe("isValidBsn (NL)", () => {
  // Both are the published valid examples.
  it.each(["111222333", "123456782"])("accepts %s", (bsn) => {
    expect(isValidBsn(bsn)).toBe(true);
  });

  it("rejects a failed eleven-test, all zeros and a wrong length", () => {
    expect(isValidBsn("111222334")).toBe(false);
    expect(isValidBsn("123456789")).toBe(false);
    expect(isValidBsn("000000000")).toBe(false);
    expect(isValidBsn("11122233")).toBe(false);
  });
});

describe("isValidNir (FR)", () => {
  it.each([
    // 1850575056123 mod 97 = 9, key 88.
    "185057505612388",
    // Corsica: 2A reads as 19, 2B as 18.
    "269052A12345688",
    "185122B04567859",
  ])("accepts %s", (nir) => {
    expect(isValidNir(nir)).toBe(true);
  });

  it("rejects a wrong key, a wrong first digit and a bad department", () => {
    expect(isValidNir("185057505612387")).toBe(false);
    expect(isValidNir("585057505612388")).toBe(false);
    expect(isValidNir("269052C12345688")).toBe(false);
    expect(isValidNir("18505750561238")).toBe(false);
  });
});

describe("generic rule", () => {
  it("accepts a member ID as entered", () => {
    expect(isValidGenericInsuranceId("XYZ 123-456.7")).toBe(true);
    expect(isValidGenericInsuranceId("ABC")).toBe(true);
    expect(isValidGenericInsuranceId("A".repeat(30))).toBe(true);
  });

  it("rejects too short, too long, other characters and untrimmed", () => {
    expect(isValidGenericInsuranceId("AB")).toBe(false);
    expect(isValidGenericInsuranceId("A".repeat(31))).toBe(false);
    expect(isValidGenericInsuranceId("ABC/123")).toBe(false);
    expect(isValidGenericInsuranceId(" ABC")).toBe(false);
  });
});

describe("isValidInsuranceNumber", () => {
  it("checks the number under its own country", () => {
    expect(isValidInsuranceNumber("A123456780", "DE")).toBe(true);
    expect(isValidInsuranceNumber("A123456780", "AT")).toBe(false);
    expect(isValidInsuranceNumber("1237010180", "AT")).toBe(true);
    expect(isValidInsuranceNumber("1237010180", "DE")).toBe(false);
    expect(isValidInsuranceNumber("7569217076985", "CH")).toBe(true);
    expect(isValidInsuranceNumber("111222333", "NL")).toBe(true);
    expect(isValidInsuranceNumber("185057505612388", "FR")).toBe(true);
    expect(isValidInsuranceNumber("W123-456789", "US")).toBe(true);
    expect(isValidInsuranceNumber("W1", "US")).toBe(false);
  });
});

describe("normalise, format, rule and country", () => {
  it("compacts strict numbers and keeps generic ones as entered", () => {
    expect(normaliseInsuranceNumber(" 1237 010180 ", "AT")).toBe("1237010180");
    expect(normaliseInsuranceNumber("a123 456 780", "DE")).toBe("A123456780");
    expect(normaliseInsuranceNumber("756.9217.0769.85", "CH")).toBe(
      "7569217076985",
    );
    expect(normaliseInsuranceNumber("12345678", "NL")).toBe("012345678");
    expect(normaliseInsuranceNumber("2 69 05 2a 123 456 88", "FR")).toBe(
      "269052A12345688",
    );
    expect(normaliseInsuranceNumber("  w123 456 ", "US")).toBe("w123 456");
  });

  it("writes each number in its country's form", () => {
    expect(formatInsuranceNumber("1237010180", "AT")).toBe("1237 010180");
    expect(formatInsuranceNumber("7569217076985", "CH")).toBe(
      "756.9217.0769.85",
    );
    expect(formatInsuranceNumber("185057505612388", "FR")).toBe(
      "1 85 05 75 056 123 88",
    );
    expect(formatInsuranceNumber("A123456780", "DE")).toBe("A123456780");
    expect(formatInsuranceNumber("111222333", "NL")).toBe("111222333");
    expect(formatInsuranceNumber("w123 456", "US")).toBe("w123 456");
    expect(formatInsuranceNumber("A123456780", "AT")).toBe("A123456780");
  });

  it("maps countries to rules and rejection codes", () => {
    expect(insuranceNumberRule("US")).toBe("generic");
    expect(insuranceNumberRule("FR")).toBe("FR");
    expect(insuranceNumberRejectionCode("DE")).toBe("invalid_kvnr");
    expect(insuranceNumberRejectionCode("AT")).toBe("invalid_svnr");
    expect(insuranceNumberRejectionCode("CH")).toBe("invalid_ahv");
    expect(insuranceNumberRejectionCode("NL")).toBe("invalid_bsn");
    expect(insuranceNumberRejectionCode("FR")).toBe("invalid_nir");
    expect(insuranceNumberRejectionCode("US")).toBe("invalid_member_id");
  });

  it("reads a missing or unknown country as Germany", () => {
    expect(resolveInsuranceNumberCountry(null)).toBe("DE");
    expect(resolveInsuranceNumberCountry(undefined)).toBe("DE");
    expect(resolveInsuranceNumberCountry("XX")).toBe("DE");
    expect(resolveInsuranceNumberCountry("US")).toBe("US");
  });

  it("knows every assigned code once and only the US group number", () => {
    expect(ISO_COUNTRY_CODES).toHaveLength(249);
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(249);
    expect(isIsoCountryCode("AT")).toBe(true);
    expect(isIsoCountryCode("at")).toBe(false);
    expect(isIsoCountryCode("EU")).toBe(false);
    expect(countryHasGroupNumber("US")).toBe(true);
    expect(countryHasGroupNumber("DE")).toBe(false);
  });
});

describe("suggestInsuranceNumberCountry", () => {
  it("keeps a stored country and reads a stored bare number as German", () => {
    expect(
      suggestInsuranceNumberCountry({
        stored: "AT",
        hasNumber: true,
        languages: ["en-US"],
      }),
    ).toBe("AT");
    expect(
      suggestInsuranceNumberCountry({
        stored: null,
        hasNumber: true,
        languages: ["en-US"],
      }),
    ).toBe("DE");
  });

  it("guesses an empty profile from the browser region, then the language", () => {
    expect(
      suggestInsuranceNumberCountry({
        stored: null,
        hasNumber: false,
        languages: ["de-AT", "de"],
      }),
    ).toBe("AT");
    expect(
      suggestInsuranceNumberCountry({
        stored: null,
        hasNumber: false,
        languages: ["fr"],
        locale: "fr",
      }),
    ).toBe("FR");
    expect(
      suggestInsuranceNumberCountry({ stored: null, hasNumber: false }),
    ).toBe("DE");
  });
});
