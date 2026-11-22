/**
 * #1430 — the starting registry. Only where the language and the zone agree,
 * or the language names one registry by itself; everything else is NONE.
 */
import { describe, expect, it } from "vitest";

import { deriveMedicineRegistry } from "@/lib/medications/medicine-registry-default";
import { resolveMedicineRegistry } from "@/lib/medications/medicine-registry";

describe("deriveMedicineRegistry", () => {
  it.each([
    ["de", "Europe/Berlin", "DE"],
    ["de", "Europe/Brussels", "BE"],
    ["fr", "Europe/Paris", "FR"],
    ["fr", "America/Toronto", "CA"],
    ["en", "Europe/London", "GB"],
    ["en", "America/New_York", "US"],
    ["en", "America/Indiana/Indianapolis", "US"],
    ["en", "Australia/Sydney", "AU"],
    ["nl", "Europe/Amsterdam", "NL"],
    ["es", "Europe/Madrid", "ES"],
    ["es", "Atlantic/Canary", "ES"],
    ["pt-BR", "America/Sao_Paulo", "BR"],
    // A language that names one registry by itself.
    ["pl", "Europe/Berlin", "PL"],
    ["pt-BR", "Europe/Lisbon", "BR"],
  ])("%s in %s starts at %s", (locale, timezone, expected) => {
    expect(deriveMedicineRegistry({ locale, timezone })).toBe(expected);
  });

  it.each([
    // The instance default zone does not make an English reader British.
    ["en", "Europe/Berlin"],
    // Austria and Switzerland have their own registries, not in the table.
    ["de", "Europe/Vienna"],
    ["de", "Europe/Zurich"],
    // Spanish in Mexico is not Spain.
    ["es", "America/Mexico_City"],
    // No registry in the table for these languages.
    ["it", "Europe/Rome"],
    ["ko", "Asia/Seoul"],
    ["ru", "Europe/Moscow"],
    // No language chosen: no signal.
    [null, "Europe/Berlin"],
    ["de", null],
  ])("%s in %s starts at NONE", (locale, timezone) => {
    expect(deriveMedicineRegistry({ locale, timezone })).toBe("NONE");
  });
});

describe("resolveMedicineRegistry", () => {
  it("keeps a stored choice whatever the language says", () => {
    expect(
      resolveMedicineRegistry({
        medicineRegistry: "PL",
        locale: "en",
        timezone: "Europe/London",
      }),
    ).toBe("PL");
    expect(
      resolveMedicineRegistry({
        medicineRegistry: "NONE",
        locale: "de",
        timezone: "Europe/Berlin",
      }),
    ).toBe("NONE");
  });

  it("derives while unsettled, and ignores a value outside the list", () => {
    expect(
      resolveMedicineRegistry({
        medicineRegistry: null,
        locale: "de",
        timezone: "Europe/Berlin",
      }),
    ).toBe("DE");
    expect(
      resolveMedicineRegistry({
        medicineRegistry: "XX",
        locale: "de",
        timezone: "Europe/Berlin",
      }),
    ).toBe("DE");
  });
});
