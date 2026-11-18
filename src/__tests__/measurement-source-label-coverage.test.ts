/**
 * Every provenance enum member a surface renders must have a label.
 *
 * Settings → Sources listed `GOOGLE_HEALTH`, `OURA`, `POLAR` and `STRAVA` by
 * their internal name for a full release line: the label catalogue was
 * written when the enum was seven members long, the render path falls back
 * to the raw value, and nothing failed when a provider landed without its
 * label. Same fall-through in the measurement list (the source facet offers
 * every enum member) and on the medication intake caption, where the v1.28
 * Apple Health dose sync reads `via APPLE_HEALTH`.
 *
 * The member list comes from `prisma/schema.prisma` — the enum itself, not a
 * copy of it — so the next provider cannot ship without its label. Each
 * catalogue is checked in two steps: the map has an entry for the member,
 * and the key that entry names resolves to a real string in EVERY locale
 * bundle (a key that resolves nowhere renders as the key, which is no better
 * than the enum value it replaced).
 *
 * Mutation check: drop a member from either map and this goes red naming it;
 * point one at a key the bundles do not carry and the resolve arm goes red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  INTAKE_SOURCE_LABEL_KEYS,
  LAB_SOURCE_LABEL_KEYS,
  NUTRIENT_SOURCE_LABEL_KEYS,
  INTAKE_SOURCE_VALUES,
  MEASUREMENT_SOURCE_LIST_LABEL_KEYS,
  MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS,
} from "@/lib/i18n/source-labels";
import { measurementSourceEnum } from "@/lib/validations/measurement";
import { NUTRIENT_SOURCE } from "@/lib/nutrients/sources";
import { deviceTypeEnum } from "@/lib/validations/source-priority";
import { readDeclaredSchema } from "./helpers/prisma-schema-names";

const ROOT = join(__dirname, "../..");
const MESSAGES_DIR = join(ROOT, "messages");

const LOCALES = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    locale: f.replace(/\.json$/, ""),
    bundle: JSON.parse(readFileSync(join(MESSAGES_DIR, f), "utf8")) as unknown,
  }));

function resolveKey(bundle: unknown, key: string): string | undefined {
  let node: unknown = bundle;
  for (const segment of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === "string" && node !== "" ? node : undefined;
}

const declaredEnums = readDeclaredSchema().enums;

function membersOf(enumName: string): string[] {
  const declared = declaredEnums.find((e) => e.name === enumName);
  if (!declared) throw new Error(`${enumName} is not declared in the schema`);
  return declared.values;
}

/**
 * Assert the catalogue covers the enum and that every key it names resolves.
 * `floor` fails the whole check if the schema reader stopped matching — an
 * empty member list would otherwise pass every assertion below vacuously.
 */
function expectLabelled(
  members: string[],
  floor: number,
  catalogue: Record<string, string>,
  catalogueName: string,
): void {
  expect(
    members.length,
    `Read only ${members.length} members from prisma/schema.prisma — the ` +
      `schema reader stopped matching, so this guard proves nothing.`,
  ).toBeGreaterThanOrEqual(floor);

  const unlabelled = members.filter((member) => !catalogue[member]);
  expect(
    unlabelled,
    `${catalogueName} has no entry for these enum members, so the surface ` +
      `renders their raw enum value:\n` +
      unlabelled.map((m) => `  ${m}`).join("\n"),
  ).toEqual([]);

  const unresolved: string[] = [];
  for (const member of members) {
    const key = catalogue[member];
    if (!key) continue;
    for (const { locale, bundle } of LOCALES) {
      if (resolveKey(bundle, key) === undefined) {
        unresolved.push(`${member} → ${key} (${locale})`);
      }
    }
  }
  expect(
    unresolved,
    `${catalogueName} names keys that no message bundle carries:\n` +
      unresolved.map((s) => `  ${s}`).join("\n"),
  ).toEqual([]);
}

describe("source label coverage", () => {
  it("has more than one locale bundle to check against", () => {
    expect(LOCALES.length).toBeGreaterThanOrEqual(7);
  });

  it("keeps the Zod source enum in step with the schema", () => {
    expect([...measurementSourceEnum.options].sort()).toEqual(
      [...membersOf("MeasurementSource")].sort(),
    );
  });

  it("labels every MeasurementSource in Settings → Sources", () => {
    expectLabelled(
      membersOf("MeasurementSource"),
      14,
      MEASUREMENT_SOURCE_SETTINGS_LABEL_KEYS,
      "The settings source catalogue",
    );
  });

  it("labels every MeasurementSource in the measurement list", () => {
    expectLabelled(
      membersOf("MeasurementSource"),
      14,
      MEASUREMENT_SOURCE_LIST_LABEL_KEYS,
      "The measurement-list source catalogue",
    );
  });

  it("labels every IntakeSource on the intake history", () => {
    const members = membersOf("IntakeSource");
    expect([...INTAKE_SOURCE_VALUES].sort()).toEqual([...members].sort());
    expectLabelled(
      members,
      5,
      INTAKE_SOURCE_LABEL_KEYS,
      "The intake source catalogue",
    );
  });

  /**
   * Nutrient day totals and lab readings keep their source as text, closed by
   * a constant (`NUTRIENT_SOURCE`) or by the write paths (`LabResult.source`),
   * not a schema enum. Both read in the measurement list's vocabulary, so the
   * same source carries the same name on every page.
   */
  it("labels every nutrient source in the measurement vocabulary", () => {
    const members = Object.values(NUTRIENT_SOURCE);
    expectLabelled(
      members,
      5,
      NUTRIENT_SOURCE_LABEL_KEYS,
      "The nutrient source catalogue",
    );
    expect(NUTRIENT_SOURCE_LABEL_KEYS.APPLE_HEALTH).toBe(
      MEASUREMENT_SOURCE_LIST_LABEL_KEYS.APPLE_HEALTH,
    );
    expect(NUTRIENT_SOURCE_LABEL_KEYS.EXTERNAL).toBe(
      MEASUREMENT_SOURCE_LIST_LABEL_KEYS.EXTERNAL,
    );
  });

  it("labels every lab source the write paths set", () => {
    // MANUAL / OCR (lab routes), DOCUMENT (document import), IMPORT (lab CSV),
    // APPLE_HEALTH (Health Records).
    const members = ["MANUAL", "OCR", "DOCUMENT", "IMPORT", "APPLE_HEALTH"];
    expect(Object.keys(LAB_SOURCE_LABEL_KEYS).sort()).toEqual(
      [...members].sort(),
    );
    expectLabelled(
      members,
      5,
      LAB_SOURCE_LABEL_KEYS,
      "The lab source catalogue",
    );
  });

  /**
   * The other enum the sources section renders. It is already closed by its
   * own type (`Record<DeviceType, string>` off the Zod enum), so this arm is
   * the bundle half only — the keys have to exist for the type to help.
   */
  it("labels every device type in Settings → Sources", () => {
    const catalogue = Object.fromEntries(
      deviceTypeEnum.options.map((d) => [
        d,
        `settings.sections.sources.deviceLabels.${d}`,
      ]),
    );
    expectLabelled(
      [...deviceTypeEnum.options],
      7,
      catalogue,
      "The device catalogue",
    );
  });
});
