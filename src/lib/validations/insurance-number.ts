/**
 * The health-insurance number, per country: the one place that says what a
 * valid number is, how it is stored, how it is written and which rule it
 * falls under. The FHIR identifier systems live beside the other systems in
 * `src/lib/fhir/resources/common.ts` and are keyed by the same rule.
 *
 * The country is any ISO 3166-1 alpha-2 code. A stored number without one is
 * German: every row written before the country existed holds a KVNR.
 *
 * Countries with a public check algorithm get a strict rule:
 *
 * - `DE` KVNR (`kvnr.ts`): one letter and nine digits, mod-10 check digit.
 * - `AT` SVNR: ten digits `NNNC DDMMYY`. Serial 100 to 999, check digit at
 *   position 4: the other nine digits weighted 3, 7, 9 and 5, 8, 4, 2, 1, 6,
 *   summed, mod 11. A remainder of 10 is never issued, so it is invalid. The
 *   date part is not checked as a date; it is not always the birth date.
 * - `CH` AHV number (AHVN13): thirteen digits starting 756, written
 *   `756.XXXX.XXXX.XX`; the last digit is the EAN-13 check digit (weights 1
 *   and 3 alternating from the left, check = (10 - sum mod 10) mod 10).
 * - `NL` BSN: nine digits (an eight-digit number gets a leading zero); the
 *   eleven-test with weights 9 to 2 and -1 for the last digit, the sum a
 *   multiple of 11.
 * - `FR` NIR: thirteen characters and a two-digit key, key = 97 - (number
 *   mod 97). The first digit is 1, 2, 3, 4, 7 or 8; the department at
 *   positions 6-7 may be 2A or 2B (Corsica), computed as 19 and 18.
 *
 * Every other country, the US included, falls to the generic rule: the value
 * as entered, trimmed, 3 to 30 letters, digits, spaces, hyphens or dots, no
 * checksum. In the US that is the member ID on the insurer's card; the plan's
 * group number is a second field there and nowhere else.
 */
import { isValidKvnr } from "@/lib/validations/kvnr";
import { ownValue } from "@/lib/own-key";

/** ISO 3166-1 alpha-2, every officially assigned code. */
export const ISO_COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM " +
  "PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

const ISO_COUNTRY_SET: ReadonlySet<string> = new Set(ISO_COUNTRY_CODES);

/** Whether a value is an assigned ISO 3166-1 alpha-2 code (uppercase). */
export function isIsoCountryCode(value: unknown): value is string {
  return typeof value === "string" && ISO_COUNTRY_SET.has(value);
}

/** The number rules. `generic` is every country without its own. */
export type InsuranceNumberRule = "DE" | "AT" | "CH" | "NL" | "FR" | "generic";

/** The country a stored number is read under: absent or unknown is `DE`. */
export function resolveInsuranceNumberCountry(
  stored: string | null | undefined,
): string {
  return isIsoCountryCode(stored) ? stored : "DE";
}

/** The rule a country's numbers are checked by. */
export function insuranceNumberRule(country: string): InsuranceNumberRule {
  switch (country) {
    case "DE":
    case "AT":
    case "CH":
    case "NL":
    case "FR":
      return country;
    default:
      return "generic";
  }
}

/** Only US plans carry a group number beside the member ID. */
export function countryHasGroupNumber(country: string): boolean {
  return country === "US";
}

/**
 * The value to store. A strict rule drops spaces, dots and hyphens and
 * uppercases (and pads an eight-digit BSN); the generic rule keeps the value
 * as entered, trimmed. Not a validation; pair it with
 * {@link isValidInsuranceNumber}.
 */
export function normaliseInsuranceNumber(
  value: string,
  country: string,
): string {
  const rule = insuranceNumberRule(country);
  if (rule === "generic") return value.trim();
  const compact = value.replace(/[\s.-]+/g, "").toUpperCase();
  if (rule === "NL" && /^[0-9]{8}$/.test(compact)) return `0${compact}`;
  return compact;
}

const GENERIC_PATTERN = /^[A-Za-z0-9 .-]{3,30}$/;

/** The generic rule: 3 to 30 letters, digits, spaces, hyphens or dots. */
export function isValidGenericInsuranceId(value: string): boolean {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    GENERIC_PATTERN.test(value)
  );
}

function digitAt(value: string, index: number): number {
  return value.charCodeAt(index) - 48;
}

const SVNR_PATTERN = /^[1-9][0-9]{9}$/;
/** Weights for positions 1 to 10; position 4 is the check digit itself. */
const SVNR_WEIGHTS = [3, 7, 9, 0, 5, 8, 4, 2, 1, 6] as const;

/** A normalised Austrian SVNR whose check digit matches. */
export function isValidSvnr(value: string): boolean {
  if (typeof value !== "string" || !SVNR_PATTERN.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += digitAt(value, i) * SVNR_WEIGHTS[i];
  const check = sum % 11;
  return check !== 10 && check === digitAt(value, 3);
}

const AHV_PATTERN = /^756[0-9]{10}$/;

/** A normalised Swiss AHV number (AHVN13) whose EAN-13 check digit matches. */
export function isValidAhv(value: string): boolean {
  if (typeof value !== "string" || !AHV_PATTERN.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += digitAt(value, i) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10 === digitAt(value, 12);
}

const BSN_PATTERN = /^[0-9]{9}$/;

/** A normalised Dutch BSN that passes the eleven-test. */
export function isValidBsn(value: string): boolean {
  if (typeof value !== "string" || !BSN_PATTERN.test(value)) return false;
  if (value === "000000000") return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += digitAt(value, i) * (9 - i);
  sum -= digitAt(value, 8);
  return sum % 11 === 0;
}

const NIR_PATTERN = /^[1-478][0-9]{4}(?:[0-9]{2}|2A|2B)[0-9]{8}$/;

/** A normalised French NIR (13 characters and the key) whose key matches. */
export function isValidNir(value: string): boolean {
  if (typeof value !== "string" || !NIR_PATTERN.test(value)) return false;
  const department = value.slice(5, 7);
  const numeric =
    value.slice(0, 5) +
    (department === "2A" ? "19" : department === "2B" ? "18" : department) +
    value.slice(7, 13);
  const key = Number(value.slice(13, 15));
  return key >= 1 && key <= 97 && 97 - (Number(numeric) % 97) === key;
}

/** A normalised number that is valid under its country's rule. */
export function isValidInsuranceNumber(
  value: string,
  country: string,
): boolean {
  switch (insuranceNumberRule(country)) {
    case "DE":
      return isValidKvnr(value);
    case "AT":
      return isValidSvnr(value);
    case "CH":
      return isValidAhv(value);
    case "NL":
      return isValidBsn(value);
    case "FR":
      return isValidNir(value);
    case "generic":
      return isValidGenericInsuranceId(value);
  }
}

/** The rejection code a number carries when it fails its country's rule. */
export function insuranceNumberRejectionCode(country: string): string {
  const codes: Record<InsuranceNumberRule, string> = {
    DE: "invalid_kvnr",
    AT: "invalid_svnr",
    CH: "invalid_ahv",
    NL: "invalid_bsn",
    FR: "invalid_nir",
    generic: "invalid_member_id",
  };
  return codes[insuranceNumberRule(country)];
}

/**
 * The number as a person writes it: an SVNR as `NNNN DDMMYY`, an AHV number
 * as `756.XXXX.XXXX.XX`, a NIR as `S AA MM DD CCC OOO KK`; every other value
 * as stored. A value that does not fit its country's shape is returned as is.
 */
export function formatInsuranceNumber(value: string, country: string): string {
  switch (insuranceNumberRule(country)) {
    case "AT":
      return SVNR_PATTERN.test(value)
        ? `${value.slice(0, 4)} ${value.slice(4)}`
        : value;
    case "CH":
      return AHV_PATTERN.test(value)
        ? `${value.slice(0, 3)}.${value.slice(3, 7)}.${value.slice(7, 11)}.${value.slice(11)}`
        : value;
    case "FR":
      return NIR_PATTERN.test(value)
        ? [
            value.slice(0, 1),
            value.slice(1, 3),
            value.slice(3, 5),
            value.slice(5, 7),
            value.slice(7, 10),
            value.slice(10, 13),
            value.slice(13, 15),
          ].join(" ")
        : value;
    default:
      return value;
  }
}

/**
 * A stored number written the way its country writes it, or null. The
 * country is the stored one; absent or null is DE.
 */
export function displayInsuranceNumber(identity: {
  insuranceNumber: string | null;
  insuranceNumberCountry?: string | null;
}): string | null {
  if (!identity.insuranceNumber) return null;
  return formatInsuranceNumber(
    identity.insuranceNumber,
    resolveInsuranceNumberCountry(identity.insuranceNumberCountry),
  );
}

/**
 * The country the form offers before one is stored. A stored number without
 * a country is German, so only an empty profile is guessed: from a region in
 * the browser's languages (`de-AT`, `en-US`), else from the account's
 * language, else Germany.
 */
export function suggestInsuranceNumberCountry(input: {
  stored: string | null | undefined;
  hasNumber: boolean;
  languages?: readonly string[];
  locale?: string | null;
}): string {
  if (isIsoCountryCode(input.stored)) return input.stored;
  if (input.hasNumber) return "DE";
  for (const tag of input.languages ?? []) {
    const region = /^[a-z]{2,3}-([A-Za-z]{2})$/i.exec(tag)?.[1]?.toUpperCase();
    if (isIsoCountryCode(region)) return region;
  }
  const byLocale: Record<string, string> = {
    de: "DE",
    fr: "FR",
    nl: "NL",
    it: "IT",
    es: "ES",
    pl: "PL",
    ko: "KR",
    ru: "RU",
    "pt-BR": "BR",
    en: "US",
  };
  return (input.locale && ownValue(byLocale, input.locale)) || "DE";
}
