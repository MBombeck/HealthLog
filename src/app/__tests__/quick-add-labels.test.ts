import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v1.4.15 phase-A3 fix #1 — the dashboard "Hinzufügen" / "Add" dropdown used
 * to render two menu items whose visible labels both resolved to the bare
 * verb ("Hinzufügen" in DE, "Add" in EN). The dropdown trigger ALSO says
 * "Hinzufügen", so a screen-reader user heard "Hinzufügen, Hinzufügen,
 * Hinzufügen" with no way to tell the entries apart.
 *
 * The fix is to give each entry a self-contained noun-phrase label
 * ("Messung erfassen", "Stimmung erfassen") that doesn't collide with the
 * trigger or the other entry. This guard locks that contract in: if anyone
 * later edits one of the two values to match the other (or to match
 * `common.add`), the test fails before the regression ships.
 *
 * Lives under `src/app/__tests__` because the consumer is the dashboard
 * page (`src/app/page.tsx`); the keys themselves are namespaced under
 * `dashboard.*` in both messages files.
 */

const ROOT = join(__dirname, "../../..");
const EN_PATH = join(ROOT, "messages/en.json");
const DE_PATH = join(ROOT, "messages/de.json");
const ES_PATH = join(ROOT, "messages/es.json");
const FR_PATH = join(ROOT, "messages/fr.json");
const IT_PATH = join(ROOT, "messages/it.json");
const PL_PATH = join(ROOT, "messages/pl.json");

interface Messages {
  common: { add: string };
  dashboard: {
    quickAddMeasurement: string;
    quickAddMood: string;
    /**
     * v1.4.37 W7b — third quick-add row: medication intake. Same
     * contract as the other two: distinct from siblings and from the
     * trigger label, otherwise the screen-reader hears "Hinzufügen,
     * Hinzufügen, Hinzufügen, Hinzufügen" with no way to discriminate.
     */
    quickAddMedicationIntake: string;
    quickAddWater: string;
  };
}

function load(path: string): Messages {
  return JSON.parse(readFileSync(path, "utf8")) as Messages;
}

describe("dashboard quick-add submenu labels", () => {
  // v1.4.38 W-D P1-4 — extend the collision guard from en+de to all
  // six locales so a future translation that accidentally reuses the
  // trigger word (or a sibling row's verb) is caught before shipping.
  // es/fr/it/pl currently still hold the literal English block; the
  // guard runs against whatever string lives there today.
  it.each([
    ["en", EN_PATH],
    ["de", DE_PATH],
    ["es", ES_PATH],
    ["fr", FR_PATH],
    ["it", IT_PATH],
    ["pl", PL_PATH],
  ])(
    "%s: every quick-add entry has a distinct accessible label",
    (_locale, path) => {
      const messages = load(path);

      const measurement = messages.dashboard.quickAddMeasurement;
      const mood = messages.dashboard.quickAddMood;
      const medicationIntake = messages.dashboard.quickAddMedicationIntake;
      const water = messages.dashboard.quickAddWater;
      const trigger = messages.common.add;

      // Non-empty
      expect(measurement.trim().length).toBeGreaterThan(0);
      expect(mood.trim().length).toBeGreaterThan(0);
      expect(medicationIntake.trim().length).toBeGreaterThan(0);
      expect(water.trim().length).toBeGreaterThan(0);

      // Distinct from each other — the icon is decorative (aria-hidden),
      // so the only thing distinguishing the rows is the visible text.
      expect(measurement).not.toBe(mood);
      expect(measurement).not.toBe(medicationIntake);
      expect(mood).not.toBe(medicationIntake);
      expect(measurement).not.toBe(water);
      expect(mood).not.toBe(water);
      expect(medicationIntake).not.toBe(water);

      // Distinct from the trigger label. The trigger sits ABOVE the menu
      // and announces itself first; if a menu item then repeats the same
      // word, screen-readers / users get no signal which row does what.
      expect(measurement).not.toBe(trigger);
      expect(mood).not.toBe(trigger);
      expect(medicationIntake).not.toBe(trigger);
      expect(water).not.toBe(trigger);
    },
  );
});
