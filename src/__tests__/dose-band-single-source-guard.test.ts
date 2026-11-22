/**
 * One dose, one window: every reader takes a dose's band from the band
 * minter, which applies the medication's stored per-dose window.
 *
 * `defaultDoseBand` knows nothing of stored windows. It is the fallback for
 * the one dose the minter has no slot for (a rolling cadence's open
 * occurrence, minted only once taken), and nothing else. When the card read
 * a not-yet-minted dose from it, a dose with a window of 11:30 to 12:45 was
 * due from 11:30 in the today rows and from 11:00 on the card.
 *
 * The behaviour is pinned in
 * `src/lib/analytics/compliance/__tests__/current-dose-stored-window.test.ts`.
 * This freezes the callers: a new one fails here and has to say why the
 * minter cannot answer for it.
 */
import { describe, expect, it } from "vitest";

import { readSourceFolder } from "@/__tests__/helpers/source-files";

const CALLERS = readSourceFolder("src", {
  floor: 1000,
  include: (rel) =>
    !rel.startsWith("generated/") &&
    !rel.includes("__tests__/") &&
    !/\.test\.tsx?$/.test(rel),
})
  .filter(([, text]) => /\bdefaultDoseBand\(/.test(text))
  .map(([rel]) => `src/${rel}`)
  .sort();

describe("defaultDoseBand is a fallback, not a source", () => {
  it("is called only where the minter has no slot to offer", () => {
    expect(CALLERS.length).toBeGreaterThan(0);
    expect(CALLERS).toEqual(
      [
        // The definition.
        "src/lib/analytics/compliance/dose-status.ts",
        // `currentDoseOf`: after the trailing ledger and the forward slot.
        "src/lib/analytics/compliance/current-dose.ts",
        // `unmintedNextDose`: the rolling occurrence the ledger has not minted.
        "src/lib/dashboard/meds-today.ts",
      ].sort(),
    );
  });
});
