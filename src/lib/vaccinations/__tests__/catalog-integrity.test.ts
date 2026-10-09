/**
 * What the catalogue promises about itself, and the one promise it makes to
 * every row that outlives it.
 *
 * The structural checks below are cheap and mostly hold shapes the type system
 * already holds — they exist because the file is edited by hand, entry by
 * entry, and a paste that duplicates a slug or points a combination at an
 * antigen that no longer exists compiles fine right up until two doses share
 * an identity.
 *
 * The one that matters is the last block: a slug this release does not know
 * must degrade to the record's own free text. A record keeps `antigenSlug`
 * verbatim, backups restore it without validation, and slugs are append-only
 * by convention rather than by constraint — so the day one is dropped or
 * renamed, every dose that carried it is still a real dose belonging to a real
 * person. The resolver returning `null` is what makes that survivable, and a
 * resolver that threw or a renderer that produced an empty label would turn a
 * catalogue edit into data loss on screen.
 */
import { describe, expect, it } from "vitest";

import {
  ANTIGEN_SLUGS,
  VACCINE_CATALOG,
  VACCINE_CATALOG_SLUGS,
  resolveCatalogEntry,
  type AntigenSlug,
} from "@/lib/vaccinations/vaccine-catalog";
import { componentsForDose } from "@/lib/vaccinations/resolve-vaccine-entry";

const MONOVALENT = new Set<string>(ANTIGEN_SLUGS);

describe("the vaccine catalogue holds its own shape", () => {
  it("carries a whole life's worth of entries, not a token list", () => {
    // The floor is not decoration: an adult-only catalogue was the rejected
    // alternative, and it would ship a module that cannot hold a child's
    // Pass. A count that collapses is the symptom.
    expect(VACCINE_CATALOG.length).toBeGreaterThanOrEqual(30);
    expect(MONOVALENT.size).toBeGreaterThanOrEqual(20);
  });

  it("gives every entry a unique slug", () => {
    const seen = new Map<string, number>();
    for (const slug of VACCINE_CATALOG_SLUGS) {
      seen.set(slug, (seen.get(slug) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([slug]) => slug);
    expect(
      duplicated,
      "two entries under one slug means two doses share an identity",
    ).toEqual([]);
  });

  it("offers every monovalent antigen as an entry of its own", () => {
    // An older Pass line records a component on its own, so every antigen a
    // combination can contain must also be loggable by itself.
    const missing = ANTIGEN_SLUGS.filter(
      (slug) => !VACCINE_CATALOG_SLUGS.includes(slug),
    );
    expect(missing).toEqual([]);
  });

  it("resolves every combination's components to real monovalent antigens", () => {
    const foreign: string[] = [];
    for (const entry of VACCINE_CATALOG) {
      for (const component of entry.components) {
        if (!MONOVALENT.has(component))
          foreign.push(`${entry.slug}/${component}`);
      }
    }
    expect(
      foreign,
      "a component that is not an antigen breaks the series axis silently",
    ).toEqual([]);
  });

  it("makes every monovalent entry its own single component", () => {
    const wrong = VACCINE_CATALOG.filter(
      (entry) =>
        MONOVALENT.has(entry.slug) &&
        (entry.components.length !== 1 || entry.components[0] !== entry.slug),
    ).map((entry) => entry.slug);
    expect(
      wrong,
      "a monovalent that does not count into its own series counts into none",
    ).toEqual([]);
  });

  it("gives every entry an ATC code in the J07 subtree", () => {
    const wrong = VACCINE_CATALOG.filter(
      (entry) => !/^J07[A-Z]{2}\d{2}$/.test(entry.atc),
    ).map((entry) => `${entry.slug}: ${entry.atc}`);
    expect(wrong).toEqual([]);
  });

  it("cites a source for every entry's numbers", () => {
    // Rendered numbers need a rendered citation. A blank or one-word source
    // is how a footnote stops being checkable.
    const thin = VACCINE_CATALOG.filter(
      (entry) => entry.source.trim().length < 8,
    ).map((entry) => entry.slug);
    expect(thin).toEqual([]);
  });

  it("keeps the numbers inside the range a schedule can mean", () => {
    const wrong: string[] = [];
    for (const entry of VACCINE_CATALOG) {
      const { typicalSeriesDoses: doses, boosterIntervalMonths: months } =
        entry;
      if (doses !== null && (doses < 1 || doses > 10)) {
        wrong.push(`${entry.slug}: ${doses} doses`);
      }
      if (months !== null && (months < 1 || months > 240)) {
        wrong.push(`${entry.slug}: every ${months} months`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps every synonym generic, lowercase and distinct", () => {
    // The vendor-name rule cannot be fully held by a matcher — a trade name
    // is a proper noun and nothing here knows the register. What a test CAN
    // hold is the shape a trade name would have to break: synonyms are
    // lowercase generic wording, never blank, never repeated.
    const wrong: string[] = [];
    const seen = new Set<string>();
    for (const entry of VACCINE_CATALOG) {
      for (const synonym of entry.synonyms ?? []) {
        if (synonym !== synonym.toLowerCase() || synonym.trim().length === 0) {
          wrong.push(`${entry.slug}: ${synonym}`);
        }
        if (seen.has(synonym)) wrong.push(`${entry.slug}: repeats ${synonym}`);
        seen.add(synonym);
      }
    }
    expect(wrong).toEqual([]);
  });
});

describe("a slug the catalogue no longer knows degrades to the free text", () => {
  /**
   * A record as the app would hold it after the catalogue moved on: a slug
   * written by an older release, and the person's own transcription beside it.
   */
  const ORPHANED_RECORD = {
    antigenSlug: "an-antigen-this-release-does-not-list",
    vaccineName: "Tetanus, as the 1987 Pass wrote it",
  };

  /**
   * What every consumer of the catalogue does with a record: ask the resolver,
   * take the catalogue's name when it answers, fall back to the person's own
   * wording when it does not. Written here rather than imported so the
   * guarantee is checked as a contract on the resolver, which is what every
   * caller depends on.
   */
  function displayIdentity(record: {
    antigenSlug: string | null;
    vaccineName: string | null;
  }): string {
    const entry = resolveCatalogEntry(record.antigenSlug);
    return entry ? entry.slug : (record.vaccineName ?? "");
  }

  it("returns null instead of throwing for a slug it does not have", () => {
    expect(() =>
      resolveCatalogEntry(ORPHANED_RECORD.antigenSlug),
    ).not.toThrow();
    expect(resolveCatalogEntry(ORPHANED_RECORD.antigenSlug)).toBeNull();
  });

  it("renders the person's own wording rather than an empty label", () => {
    const label = displayIdentity(ORPHANED_RECORD);
    expect(
      label,
      "an unresolvable slug must degrade to the free-text arm; an empty " +
        "label turns a catalogue edit into data loss on screen",
    ).toBe("Tetanus, as the 1987 Pass wrote it");
    expect(label.length).toBeGreaterThan(0);
  });

  it("degrades the same way for a null slug and an empty one", () => {
    expect(resolveCatalogEntry(null)).toBeNull();
    expect(resolveCatalogEntry(undefined)).toBeNull();
    expect(resolveCatalogEntry("")).toBeNull();
    expect(
      displayIdentity({ antigenSlug: null, vaccineName: "Free text only" }),
    ).toBe("Free text only");
  });

  it("matches no antigen at all rather than guessing from the name", () => {
    // The consequence that matters: an unresolvable dose must not clear a
    // booster reminder. No components means no match.
    expect(
      componentsForDose({ antigenSlug: ORPHANED_RECORD.antigenSlug }),
    ).toEqual([]);
    expect(componentsForDose({ antigenSlug: null })).toEqual([]);
  });

  it("still resolves a slug it does have, so the check above is not vacuous", () => {
    const tdap = resolveCatalogEntry("tdap");
    expect(tdap).not.toBeNull();
    expect(tdap?.components).toEqual<AntigenSlug[]>([
      "tetanus",
      "diphtheria",
      "pertussis",
    ]);
  });
});
