/**
 * The wallet card's note on a shortened card points at the QR code only when
 * the card carries one.
 */
import { describe, expect, it } from "vitest";

import type { EmergencyCardView } from "@/lib/emergency-card/card-data";
import { EMERGENCY_CARD_FIELDS } from "@/lib/emergency-card/fields";
import { buildWalletCardPdf } from "@/lib/emergency-card/wallet-pdf";

const LONG: EmergencyCardView = {
  fields: [...EMERGENCY_CARD_FIELDS],
  name: null,
  bloodType: null,
  allergies: null,
  conditions: null,
  medications: Array.from({ length: 40 }, (_, i) => ({
    name: `Medication number ${i}`,
    dose: "10 mg twice a day",
  })),
  pregnancy: null,
  implants: null,
  contacts: null,
  advanceDirective: null,
  organDonor: null,
  note: null,
  dateOfBirth: null,
  asOf: "2026-11-24",
};

async function keysFor(linkUrl: string | null) {
  const keys: string[] = [];
  const bytes = await buildWalletCardPdf({
    view: LONG,
    t: (key) => {
      keys.push(key);
      return key;
    },
    locale: "en",
    linkUrl,
  });
  expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  return keys;
}

describe("buildWalletCardPdf", () => {
  it("says the full card is behind the code on a shortened card with one", async () => {
    const keys = await keysFor(`https://h.example/e/hlm_${"a".repeat(48)}`);
    expect(keys).toContain("emergencyCard.wallet.cut");
    expect(keys).not.toContain("emergencyCard.wallet.cutNoCode");
  });

  it("never points at a code the card does not carry", async () => {
    const keys = await keysFor(null);
    expect(keys).toContain("emergencyCard.wallet.cutNoCode");
    expect(keys).not.toContain("emergencyCard.wallet.cut");
    expect(keys).not.toContain("emergencyCard.wallet.scan");
  });
});
