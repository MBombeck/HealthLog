/**
 * What an Apple Wallet pass of the emergency card says (v1.50): `pass.json`
 * and one `pass.strings` table per language, built from the card's view. A
 * pure function: no database, no clock, no randomness, so the same input
 * gives the same pass, byte for byte.
 *
 * The design is one strong surface and little text (wallet-design v2). The
 * front has three places a helper reads in five seconds: the name, one short
 * value beside it (a pregnancy, else the blood type) and one warning as a
 * whole sentence ("Severe allergy: Penicillin +1"). The header is the date
 * the content last changed, the logo text says what the card is, and the
 * collapsed stack in Wallet shows only those two. Medical detail is in the
 * info sheet, where the pass came from and what it is not on the back.
 *
 * Every text comes from the same rows the printed card, the offline copy and
 * the link use (`emergencyCardRows`), and only items the card was asked for
 * appear: the view already holds nothing else, and every front field checks
 * `view.fields` again so a loader bug cannot widen the pass.
 *
 * Languages: `pass.json` holds the owner's language. For each of the app's
 * languages, the layout is built again with that language's translator and
 * the two are walked side by side; every text pairs with its counterpart, so
 * a phone in that language reads whole rows in its own words while the
 * owner's free text (a substance, a medication name, a note) stays as
 * entered.
 */
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { locales, type Locale } from "@/lib/i18n/config";

import type { EmergencyCardView } from "../card-data";
import { emergencyCardRows, type Translate } from "../rows";

import {
  assertWalletPassJson,
  type PassField,
  type WalletPassJson,
} from "./pass-json";

/**
 * One hue, only the lightness moves: a deep emergency red that stands apart
 * from both the black and the light grey Wallet background, white values,
 * pink labels (6.7:1 on the red, 12:1 on the strip) and a near-black strip.
 */
export const WALLET_COLOURS = {
  backgroundColor: "rgb(138, 14, 36)",
  foregroundColor: "rgb(255, 255, 255)",
  labelColor: "rgb(255, 204, 211)",
  footerBackgroundColor: "rgb(58, 6, 16)",
} as const;

/** The most characters of the name, beside a short value and alone. */
const NAME_MAX_BESIDE = 22;
const NAME_MAX_ALONE = 28;
/** The most characters of a short front value (an allergy, a condition). */
const FIELD_MAX = 22;
/** The most characters of the first allergy's substance in a field. */
const ALLERGY_MAX = 14;
/** The poster footer: one whole sentence. */
export const FOOTER_MAX = 38;

export type WalletSignerIdentity =
  | { kind: "relay" }
  /** The operator's own certificate; `organization` is its `O=`. */
  | { kind: "local"; organization: string };

export interface WalletPassContentInput {
  /** The card, read for the link's frozen items. */
  view: EmergencyCardView;
  /** The owner's language: what `pass.json` holds. */
  locale: Locale;
  passTypeIdentifier: string;
  teamIdentifier: string;
  signer: WalletSignerIdentity;
  serialNumber: string;
  authenticationToken: string;
  /** The instance's https origin, e.g. `https://health.example.org`. */
  origin: string;
  /** The QR link (`<origin>/e/hlm_…`). Not drawn on a voided pass. */
  linkUrl: string;
  /** The owner's calendar day the content last changed. */
  asOfDay: string;
  /** When the link stops working, or null. */
  expiresAt: Date | null;
  /** The owner's calendar day the link stops working, or null. */
  expiresOnDay: string | null;
  /** The owner's calendar day the pass was withdrawn; null while live. */
  voidedOnDay: string | null;
}

export interface WalletPassContent {
  passJson: WalletPassJson;
  /** Per language: the entries of its `pass.strings`, nonce not included. */
  strings: Record<Locale, Array<[string, string]>>;
}

interface Sections {
  description: string;
  logoText: string;
  altText: string;
  poster: {
    headerFields: PassField[];
    primaryFields: PassField[];
    footerFields: PassField[];
    additionalInfoFields: PassField[];
    backFields: PassField[];
  };
  generic: {
    headerFields: PassField[];
    primaryFields: PassField[];
    secondaryFields: PassField[];
    auxiliaryFields: PassField[];
    backFields: PassField[];
  };
}

function chars(text: string): number {
  return [...text].length;
}

function cut(text: string, max: number): string {
  const all = [...text.trim()];
  return all.length <= max
    ? all.join("")
    : `${all.slice(0, max - 1).join("")}…`;
}

/** A date field: Wallet formats it in the phone's language. */
function dateField(key: string, label: string, day: string): PassField {
  return {
    key,
    label,
    value: `${day}T12:00:00Z`,
    dateStyle: "PKDateStyleMedium",
    ignoresTimeZone: true,
  };
}

/** The first phone number in the contacts, for the call button. */
export function firstPhoneNumber(contacts: string | null): string | null {
  if (!contacts) return null;
  // One line at a time: a number never runs on into the next line.
  for (const m of contacts.matchAll(/[+0][\d \t\-/()]*/g)) {
    const digits = m[0].replace(/[ \t\-/()]/g, "");
    if (/^(?:\+|0)\d{6,15}$/.test(digits)) return digits;
  }
  return null;
}

function has(
  view: EmergencyCardView,
  field: EmergencyCardView["fields"][number],
) {
  return view.fields.includes(field);
}

/** Something a helper must know at once: a short field and a whole sentence. */
interface Warning {
  field: PassField;
  sentence: string;
}

/**
 * What the front can say, each read only when the card was asked for it:
 * the warnings in order of urgency (the first allergy, severe ones first,
 * then the first condition), the blood type and a pregnancy.
 */
interface FrontFacts {
  warnings: Warning[];
  blood: PassField | null;
  /** The poster's wording, and the shorter one of the generic row. */
  pregnancy: { poster: PassField; generic: PassField } | null;
}

function frontFacts(input: WalletPassContentInput, t: Translate): FrontFacts {
  const { view } = input;
  const warnings: Warning[] = [];

  const allergies = has(view, "ALLERGIES") ? view.allergies : null;
  if (allergies && allergies.length > 0) {
    // Severe ones come first. A label never claims more than it counts:
    // under "Severe allergy" the count is of further severe ones only; the
    // milder ones are in the detail sheet.
    const [first] = allergies;
    const severe = first.severity === "SEVERE";
    const more = allergies
      .slice(1)
      .filter((a) => !severe || a.severity === "SEVERE").length;
    const plus = more > 0 ? ` +${more}` : "";
    const sentenceKey = severe
      ? "emergencyCard.walletPass.alertSevereAllergy"
      : "emergencyCard.walletPass.alertAllergy";
    // The substance gets what the sentence leaves of the footer's width.
    const room =
      FOOTER_MAX - chars(t(sentenceKey, { substance: "" })) - chars(plus);
    warnings.push({
      field: {
        key: "allergy",
        label: severe
          ? t("emergencyCard.walletPass.severeAllergy")
          : t("emergencyCard.walletPass.allergy"),
        value: `${cut(first.substance, ALLERGY_MAX)}${plus}`,
      },
      sentence: t(sentenceKey, {
        substance: `${cut(first.substance, Math.max(8, room))}${plus}`,
      }),
    });
  }

  const condition = has(view, "CONDITIONS") ? view.conditions?.[0] : null;
  if (condition && condition.trim()) {
    warnings.push({
      field: {
        key: "condition",
        label: t("doctorReport.emergency.chronicConditions"),
        value: cut(condition, FIELD_MAX),
      },
      sentence: cut(condition, FOOTER_MAX),
    });
  }

  const blood: PassField | null =
    has(view, "BLOOD_TYPE") && view.bloodType && view.bloodType !== "UNKNOWN"
      ? {
          key: "blood",
          label: t("records.emergency.bloodType"),
          // The detail sheet's wording, so the pass reads one notation.
          value: t(`records.emergency.bloodTypeValues.${view.bloodType}`),
        }
      : null;

  const p = has(view, "PREGNANCY") ? view.pregnancy : null;
  let pregnancy: FrontFacts["pregnancy"] = null;
  if (p) {
    const label = t("emergencyCard.pregnancy");
    const weeks = p.state === "PREGNANT" && p.gestationalWeeks !== null;
    const vars = {
      weeks: p.gestationalWeeks ?? 0,
      days: p.gestationalDays ?? 0,
    };
    const value = weeks
      ? t("emergencyCard.walletPass.week", vars)
      : p.state === "PREGNANT"
        ? t("emergencyCard.pregnant")
        : t("emergencyCard.walletPass.postpartum");
    pregnancy = {
      poster: { key: "pregnancy", label, value },
      generic: weeks
        ? {
            key: "pregnancy",
            label: t("emergencyCard.walletPass.pregnancyShort"),
            value: t("emergencyCard.walletPass.weekShort", vars),
          }
        : { key: "pregnancy", label, value },
    };
  }
  return { warnings, blood, pregnancy };
}

/**
 * The front's three places, filled by urgency (wallet-design §5.3):
 *
 *   L (left, wide)   the name; without it the most urgent warning; without
 *                    one the blood type, then a pregnancy;
 *   R (right, short) a pregnancy, else the blood type, unless L shows it;
 *   footer           the first warning L does not show, as a sentence.
 *
 * Wallet lays the QR code on the edge of the strip and these under it, so
 * nothing else fits; the rest is one tap away in the detail sheet.
 */
function frontSlots(
  input: WalletPassContentInput,
  facts: FrontFacts,
  t: Translate,
): { left: PassField; right: PassField | null; footer: string | null } {
  const { view } = input;
  const name = has(view, "NAME") && view.name?.trim() ? view.name : null;
  const pregnancy = facts.pregnancy?.poster ?? null;
  let left: PassField;
  let warningsShown = 0;
  if (name) {
    left = { key: "name", label: t("emergencyCard.name"), value: name };
  } else if (facts.warnings.length > 0) {
    left = facts.warnings[0].field;
    warningsShown = 1;
  } else if (facts.blood) {
    left = facts.blood;
  } else if (pregnancy) {
    left = pregnancy;
  } else {
    // Nothing urgent was asked for: the card says what it is.
    left = { key: "title", value: t("emergencyCard.title") };
  }
  const right =
    [pregnancy, facts.blood].find((f) => f && f.key !== left.key) ?? null;
  if (left.key === "name") {
    left = {
      ...left,
      value: cut(left.value, right ? NAME_MAX_BESIDE : NAME_MAX_ALONE),
    };
  }
  return {
    left,
    right,
    footer: facts.warnings[warningsShown]?.sentence ?? null,
  };
}

/** Where the pass comes from: issuer, signer. */
function provenance(input: WalletPassContentInput, t: Translate): PassField[] {
  const host = new URL(input.origin).host;
  return [
    {
      key: "m_issuer",
      label: t("emergencyCard.walletPass.issuedBy"),
      value: host,
      attributedValue: `<a href="${input.origin}">${host}</a>`,
    },
    {
      key: "m_signer",
      label: t("emergencyCard.walletPass.signedBy"),
      value:
        input.signer.kind === "relay"
          ? t("emergencyCard.walletPass.signerRelay")
          : input.signer.organization,
    },
  ];
}

/** The detail sheet: the card's medical rows, in its reading order. */
function medicalRows(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): PassField[] {
  return emergencyCardRows(input.view, t, locale)
    .filter((r) => r.key !== "NAME")
    .map((row) => ({
      key: `f_${row.key.toLowerCase()}`,
      label: row.label,
      value: row.lines.join("\n"),
      ...(row.key === "CONTACTS"
        ? { dataDetectorTypes: ["PKDataDetectorTypePhoneNumber" as const] }
        : {}),
    }));
}

/** The back: how long the pass works, who made it, what it is not. */
function about(input: WalletPassContentInput, t: Translate): PassField[] {
  const validLabel = t("emergencyCard.walletPass.validUntil");
  return [
    input.expiresOnDay
      ? dateField("m_valid", validLabel, input.expiresOnDay)
      : {
          key: "m_valid",
          label: validLabel,
          value: t("emergencyCard.walletPass.untilRevoked"),
        },
    ...provenance(input, t),
    {
      key: "m_note",
      label: t("emergencyCard.walletPass.noteLabel"),
      value: t("emergencyCard.walletPass.note"),
    },
  ];
}

function formatDay(locale: string, day: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(new Date(`${day}T12:00:00Z`));
  } catch {
    return day;
  }
}

function common(t: Translate) {
  return {
    description: t("emergencyCard.title"),
    logoText: t("emergencyCard.walletPass.logoText"),
    altText: t("emergencyCard.walletPass.scan"),
  };
}

/**
 * The live pass. Labels in the language's own case: Wallet sets capitals
 * itself where a style wants them (the header, the generic rows), and
 * capitals set here only made every label wider and the sheet shout.
 */
function liveSections(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): Sections {
  const asOf = dateField(
    "as_of",
    t("emergencyCard.walletPass.asOf"),
    input.asOfDay,
  );
  const facts = frontFacts(input, t);
  const { left, right, footer } = frontSlots(input, facts, t);
  const medical = medicalRows(input, t, locale);
  const back = about(input, t);
  // The generic style has one row beside a square code: at most three
  // fields, the ones L does not already show.
  const row = [
    facts.warnings.find((w) => w.field.key === "allergy")?.field ?? null,
    facts.blood,
    facts.pregnancy?.generic ?? null,
  ].filter((f): f is PassField => f !== null && f.key !== left.key);
  return {
    ...common(t),
    poster: {
      headerFields: [asOf],
      primaryFields: right ? [left, right] : [left],
      footerFields: footer ? [{ key: "alert", value: footer }] : [],
      additionalInfoFields: medical,
      backFields: back,
    },
    generic: {
      headerFields: [asOf],
      primaryFields: [left],
      secondaryFields: row.slice(0, 2),
      auxiliaryFields: row.slice(2, 3),
      backFields: [...medical, ...back],
    },
  };
}

/** The withdrawn version: no QR code, no health data, not even the name. */
function voidedSections(
  input: WalletPassContentInput & { voidedOnDay: string },
  t: Translate,
  locale: string,
): Sections {
  const withdrawn = t("emergencyCard.walletPass.withdrawn");
  const header = dateField("as_of", withdrawn, input.voidedOnDay);
  const status: PassField = {
    key: "status",
    label: t("emergencyCard.walletPass.status"),
    value: withdrawn,
  };
  const note: PassField = {
    key: "m_void",
    label: t("emergencyCard.walletPass.status"),
    value: t("emergencyCard.walletPass.withdrawnBody", {
      date: formatDay(locale, input.voidedOnDay),
    }),
  };
  const back = provenance(input, t);
  return {
    ...common(t),
    poster: {
      headerFields: [header],
      primaryFields: [status],
      footerFields: [
        { key: "alert", value: t("emergencyCard.walletPass.voidFooter") },
      ],
      additionalInfoFields: [note],
      backFields: back,
    },
    generic: {
      headerFields: [header],
      primaryFields: [status],
      secondaryFields: [],
      auxiliaryFields: [],
      backFields: [note, ...back],
    },
  };
}

function sections(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): Sections {
  return input.voidedOnDay
    ? voidedSections({ ...input, voidedOnDay: input.voidedOnDay }, t, locale)
    : liveSections(input, t, locale);
}

function w3c(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Every localisable text of a layout, in a fixed walk order. */
function texts(s: Sections): string[] {
  // The logo text first: where it and the description read the same in the
  // owner's language, the first entry wins, and the visible one matters more.
  const out = [s.logoText, s.description, s.altText];
  const areas = [
    ...Object.values(s.poster),
    ...Object.values(s.generic),
  ] as PassField[][];
  for (const area of areas) {
    for (const f of area) {
      if (f.label) out.push(f.label);
      if (!f.dateStyle) out.push(f.value);
    }
  }
  return out;
}

function shape(s: Sections): string {
  return JSON.stringify(
    [...Object.values(s.poster), ...Object.values(s.generic)].map((area) =>
      (area as PassField[]).map((f) => [
        f.key,
        Boolean(f.label),
        Boolean(f.dateStyle),
      ]),
    ),
  );
}

export function buildPassContent(
  input: WalletPassContentInput,
  translatorFor: (locale: Locale) => Translate = (l) =>
    getServerTranslator(l).t,
): WalletPassContent {
  const owner = sections(input, translatorFor(input.locale), input.locale);
  const voided = input.voidedOnDay !== null;
  const phone =
    !voided && has(input.view, "CONTACTS")
      ? firstPhoneNumber(input.view.contacts)
      : null;

  const passJson = assertWalletPassJson({
    formatVersion: 1,
    passTypeIdentifier: input.passTypeIdentifier,
    teamIdentifier: input.teamIdentifier,
    serialNumber: input.serialNumber,
    authenticationToken: input.authenticationToken,
    webServiceURL: `${input.origin}/api/wallet/apple/`,
    organizationName: "HealthLog",
    description: owner.description,
    logoText: owner.logoText,
    sharingProhibited: true,
    ...(input.expiresAt ? { expirationDate: w3c(input.expiresAt) } : {}),
    voided,
    ...WALLET_COLOURS,
    ...(voided
      ? {}
      : {
          barcodes: [
            {
              format: "PKBarcodeFormatQR",
              message: input.linkUrl,
              messageEncoding: "iso-8859-1",
              altText: owner.altText,
            },
          ],
        }),
    ...(phone
      ? {
          featuredActions: [
            { identifier: "ice", type: "call", url: `tel:${phone}` },
          ],
        }
      : {}),
    posterGeneric: owner.poster,
    generic: owner.generic,
  });

  const ownerTexts = texts(owner);
  const ownerShape = shape(owner);
  const strings = {} as Record<Locale, Array<[string, string]>>;
  for (const locale of locales) {
    const theirs = sections(input, translatorFor(locale), locale);
    // Built from the same view, the layouts differ only in their words; a
    // different shape would pair a text with the wrong counterpart.
    if (shape(theirs) !== ownerShape) {
      throw new Error(`pass layout differs in ${locale}`);
    }
    const theirTexts = texts(theirs);
    strings[locale] = ownerTexts.map((text, i) => [text, theirTexts[i]]);
  }
  return { passJson, strings };
}
