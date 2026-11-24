/**
 * What an Apple Wallet pass of the emergency card says (v1.50): `pass.json`
 * and one `pass.strings` table per language, built from the card's view. A
 * pure function: no database, no clock, no randomness, so the same input
 * gives the same pass, byte for byte.
 *
 * The design is one strong surface and little text. The front carries a
 * large title without a label (the name, else "Emergency card"), up to three
 * short facts a helper acts on in five seconds (blood type, the first
 * allergy, a pregnancy), the date the content last changed and the QR code to
 * the full card. Everything else is in the detail sheet, in the card's
 * reading order. The header stays neutral ("Emergency card", or the date),
 * because the collapsed stack in Wallet shows it every time the owner pays.
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

export const WALLET_COLOURS = {
  backgroundColor: "rgb(122, 22, 44)",
  foregroundColor: "rgb(255, 255, 255)",
  labelColor: "rgb(255, 214, 222)",
  footerBackgroundColor: "rgb(40, 10, 30)",
} as const;

/** The most characters of the name the front shows. */
const NAME_MAX = 28;
/** The most characters of the first allergy's substance on the front. */
const ALLERGY_MAX = 24;

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
  altText: string;
  poster: {
    headerFields: PassField[];
    primaryFields: PassField[];
    footerFields: PassField[];
    additionalInfoFields: PassField[];
  };
  generic: {
    headerFields: PassField[];
    primaryFields: PassField[];
    secondaryFields: PassField[];
    auxiliaryFields: PassField[];
    backFields: PassField[];
  };
}

function upper(locale: string, text: string): string {
  return text.toLocaleUpperCase(locale);
}

function cut(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max
    ? chars.join("")
    : `${chars.slice(0, max - 1).join("")}…`;
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

/** The short facts on the front, in order: blood type, allergy, pregnancy. */
function frontFacts(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): PassField[] {
  const { view } = input;
  const facts: PassField[] = [];
  if (
    has(view, "BLOOD_TYPE") &&
    view.bloodType &&
    view.bloodType !== "UNKNOWN"
  ) {
    facts.push({
      key: "blood",
      label: upper(locale, t("records.emergency.bloodType")),
      // The detail sheet's wording, so the pass reads one notation.
      value: t(`records.emergency.bloodTypeValues.${view.bloodType}`),
    });
  }
  const allergies = has(view, "ALLERGIES") ? view.allergies : null;
  if (allergies && allergies.length > 0) {
    // Severe ones come first. A label never claims more than it counts: under
    // "Severe allergy" the count is of further severe ones only; the milder
    // ones are in the detail sheet.
    const [first] = allergies;
    const severe = first.severity === "SEVERE";
    const more = allergies
      .slice(1)
      .filter((a) => !severe || a.severity === "SEVERE").length;
    facts.push({
      key: "allergy",
      label: upper(
        locale,
        severe
          ? t("emergencyCard.walletPass.severeAllergy")
          : t("emergencyCard.walletPass.allergy"),
      ),
      value: `${cut(first.substance, ALLERGY_MAX)}${more > 0 ? ` +${more}` : ""}`,
    });
  }
  const pregnancy = has(view, "PREGNANCY") ? view.pregnancy : null;
  if (pregnancy) {
    facts.push({
      key: "pregnancy",
      label: upper(locale, t("emergencyCard.pregnancy")),
      value:
        pregnancy.state === "PREGNANT"
          ? pregnancy.gestationalWeeks !== null
            ? t("emergencyCard.walletPass.week", {
                weeks: pregnancy.gestationalWeeks,
                days: pregnancy.gestationalDays ?? 0,
              })
            : t("emergencyCard.pregnant")
          : t("emergencyCard.walletPass.postpartum"),
    });
  }
  return facts;
}

/** The meta lines at the end of the detail sheet: issuer and signer. */
function provenance(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): PassField[] {
  const host = new URL(input.origin).host;
  return [
    {
      key: "m_issuer",
      label: upper(locale, t("emergencyCard.walletPass.issuedBy")),
      value: host,
      attributedValue: `<a href="${input.origin}">${host}</a>`,
    },
    {
      key: "m_signer",
      label: upper(locale, t("emergencyCard.walletPass.signedBy")),
      value:
        input.signer.kind === "relay"
          ? t("emergencyCard.walletPass.signerRelay")
          : input.signer.organization,
    },
  ];
}

/** The detail sheet of a live pass. */
function details(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): PassField[] {
  const rows = emergencyCardRows(input.view, t, locale).filter(
    (r) => r.key !== "NAME",
  );
  const out: PassField[] = rows.map((row) => ({
    key: `f_${row.key.toLowerCase()}`,
    label: upper(locale, row.label),
    value: row.lines.join("\n"),
    ...(row.key === "CONTACTS"
      ? { dataDetectorTypes: ["PKDataDetectorTypePhoneNumber" as const] }
      : {}),
  }));
  const validLabel = upper(locale, t("emergencyCard.walletPass.validUntil"));
  out.push(
    input.expiresOnDay
      ? dateField("m_valid", validLabel, input.expiresOnDay)
      : {
          key: "m_valid",
          label: validLabel,
          value: t("emergencyCard.walletPass.untilRevoked"),
        },
    {
      key: "m_asof",
      label: upper(locale, t("emergencyCard.walletPass.asOf")),
      value: t("emergencyCard.walletPass.asOfValue", {
        date: formatDay(locale, input.asOfDay),
      }),
    },
    ...provenance(input, t, locale),
    {
      key: "m_note",
      label: upper(locale, t("emergencyCard.walletPass.noteLabel")),
      value: t("emergencyCard.walletPass.note"),
    },
    {
      key: "m_lock",
      label: upper(locale, t("emergencyCard.walletPass.lockLabel")),
      value: t("emergencyCard.walletPass.lock"),
    },
  );
  return out;
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

function liveSections(
  input: WalletPassContentInput,
  t: Translate,
  locale: string,
): Sections {
  const { view } = input;
  const kind: PassField = {
    key: "kind",
    value: upper(locale, t("emergencyCard.walletPass.kind")),
  };
  const asOf = dateField(
    "as_of",
    upper(locale, t("emergencyCard.walletPass.asOf")),
    input.asOfDay,
  );
  const name = has(view, "NAME") && view.name ? cut(view.name, NAME_MAX) : null;
  // Without a name the title says what the card is, so the header, which
  // would repeat it, shows the date instead.
  const title: PassField = {
    key: "name",
    value: name ?? t("emergencyCard.title"),
  };
  const facts = frontFacts(input, t, locale);
  const sheet = details(input, t, locale);
  const pregnancy = facts.filter((f) => f.key === "pregnancy");
  return {
    description: t("emergencyCard.title"),
    altText: t("emergencyCard.walletPass.scan"),
    poster: {
      headerFields: [name ? kind : asOf],
      primaryFields: [title, ...facts],
      footerFields: name ? [asOf] : [],
      additionalInfoFields: sheet,
    },
    generic: {
      headerFields: [kind],
      primaryFields: [
        name
          ? { ...title, label: upper(locale, t("emergencyCard.name")) }
          : title,
      ],
      secondaryFields: facts.filter((f) => f.key !== "pregnancy"),
      auxiliaryFields: [...pregnancy, asOf],
      backFields: sheet,
    },
  };
}

/** The withdrawn version: no QR code, no health data, not even the name. */
function voidedSections(
  input: WalletPassContentInput & { voidedOnDay: string },
  t: Translate,
  locale: string,
): Sections {
  const kind: PassField = {
    key: "kind",
    value: upper(locale, t("emergencyCard.walletPass.kind")),
  };
  const title: PassField = {
    key: "name",
    value: t("emergencyCard.walletPass.withdrawn"),
  };
  const asOf = dateField(
    "as_of",
    upper(locale, t("emergencyCard.walletPass.asOf")),
    input.voidedOnDay,
  );
  const sheet: PassField[] = [
    {
      key: "m_void",
      label: upper(locale, t("emergencyCard.walletPass.withdrawn")),
      value: t("emergencyCard.walletPass.withdrawnBody", {
        date: formatDay(locale, input.voidedOnDay),
      }),
    },
    ...provenance(input, t, locale),
  ];
  return {
    description: t("emergencyCard.title"),
    altText: t("emergencyCard.walletPass.scan"),
    poster: {
      headerFields: [kind],
      primaryFields: [title],
      footerFields: [asOf],
      additionalInfoFields: sheet,
    },
    generic: {
      headerFields: [kind],
      primaryFields: [title],
      secondaryFields: [],
      auxiliaryFields: [asOf],
      backFields: sheet,
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
  const out = [s.description, s.altText];
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
    logoText: "HealthLog",
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
