/**
 * A placeholder card for the pass tests: an invented person, invented
 * values, a documentation host. Nothing here is anyone's record.
 */
import { join } from "node:path";

import type { EmergencyCardView } from "../../card-data";
import { EMERGENCY_CARD_FIELDS } from "../../fields";
import type { WalletPassContentInput } from "../content";

export const SAMPLE_VIEW: EmergencyCardView = {
  fields: [...EMERGENCY_CARD_FIELDS],
  name: "Alex Example",
  bloodType: "A_POS",
  allergies: [
    { substance: "Penicillin", severity: "SEVERE", reaction: "Hives" },
    { substance: "Peanuts", severity: "MODERATE", reaction: null },
    { substance: "Latex", severity: null, reaction: null },
  ],
  conditions: ["Type 1 diabetes"],
  medications: [
    { name: "Insulin glargine", dose: "20 IU at night" },
    { name: "Ramipril", dose: "5 mg" },
  ],
  pregnancy: {
    state: "PREGNANT",
    gestationalWeeks: 23,
    gestationalDays: 4,
    dueDate: "2027-03-20",
    deliveryDate: null,
    postpartumWeek: null,
  },
  implants: "Insulin pump",
  contacts:
    "Sam Example (partner) +49 170 0000000\nRiver Example 030 / 000 000",
  advanceDirective: "EXISTS",
  organDonor: "YES",
  note: 'Carries glucose tablets in the "left" pocket',
  dateOfBirth: "1990-05-17",
  asOf: "2026-11-24",
};

export const SAMPLE_INPUT: WalletPassContentInput = {
  view: SAMPLE_VIEW,
  locale: "en",
  passTypeIdentifier: "pass.dev.healthlog.emergency",
  teamIdentifier: "ABCDE12345",
  signer: { kind: "relay" },
  serialNumber: "3b2f8a5e-6c1d-4f7a-9b0e-2d4c6a8e1f35",
  authenticationToken: "a".repeat(64),
  origin: "https://health.example.org",
  linkUrl: `https://health.example.org/e/hlm_${"0".repeat(48)}`,
  asOfDay: "2026-11-24",
  expiresAt: new Date("2027-11-24T10:00:00.000Z"),
  expiresOnDay: "2027-11-24",
  voidedOnDay: null,
};

/** The same card with nothing but the blood type ticked. */
export const MINIMAL_INPUT: WalletPassContentInput = {
  ...SAMPLE_INPUT,
  view: {
    ...SAMPLE_VIEW,
    fields: ["BLOOD_TYPE"],
    name: null,
    allergies: null,
    conditions: null,
    medications: null,
    pregnancy: null,
    implants: null,
    contacts: null,
    advanceDirective: null,
    organDonor: null,
    note: null,
    dateOfBirth: null,
  },
  expiresAt: null,
  expiresOnDay: null,
};

export const NONCE = "0123456789abcdef0123456789abcdef";

/**
 * The push relay's CC0 reference implementation (`relay-spec/`, copied from
 * healthlog-push), loaded by its folder: the parts the tests use.
 */
export interface RelayReference {
  deriveRSAKey(seed: Buffer): { privateKey: import("node:crypto").KeyObject };
  checkManifest(bytes: Buffer, pins: Record<string, readonly string[]>): string;
}

export const RELAY_SPEC_DIR = join(__dirname, "relay-spec");

export async function relayReference(): Promise<RelayReference> {
  return (await import(
    /* @vite-ignore */ join(RELAY_SPEC_DIR, `wallet.${"mjs"}`)
  )) as RelayReference;
}
