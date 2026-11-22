/**
 * Every by-external-ids family answers a re-post of a deleted sample by who
 * deleted it.
 *
 * The iPhone app reads the whole Apple Health history after a reinstall or on
 * a new device. A family whose ingest takes a re-post of a sample the person
 * deleted in HealthLog as new brings it back (iOS #191: a dose deleted in
 * HealthLog came back on the next install and took its stock twice); one that
 * refuses a re-post after an Apple Health deletion loses a sample that is in
 * HealthKit again. The rule and its answer live in
 * `src/lib/sync/tombstone-repost.ts`. This guard holds every
 * `DELETE /api/<domain>/by-external-ids` route to the list there, each
 * listed delete to stamping the origin, each listed ingest to reading it, and
 * each family without a tombstone to having no way for the person to delete
 * an Apple Health row, so a new family cannot ship without a rule.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  deletedInHealthLog,
  EXTERNAL_ID_TOMBSTONE_FAMILIES,
} from "@/lib/sync/tombstone-repost";
import {
  readSourceText,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

function byExternalIdRoutes(): string[] {
  return walkSourceFiles(join(SRC, "app/api"), { floor: 300 })
    .filter((p) => /(^|\/)by-external-ids\/route\.ts$/.test(p))
    .map((p) => p.replace(/\/route\.ts$/, ""))
    .sort();
}

function code(file: string): string {
  const path = join(SRC, file);
  expect(existsSync(path), `${file} exists`).toBe(true);
  return stripComments(readSourceText(path));
}

const families = Object.entries(EXTERNAL_ID_TOMBSTONE_FAMILIES);
const withTombstone = families.flatMap(([route, family]) =>
  family.rule === "no-person-delete" ? [] : [[route, family] as const],
);
const withoutTombstone = families.flatMap(([route, family]) =>
  family.rule === "no-person-delete" ? [[route, family] as const] : [],
);

describe("by-external-ids tombstone families", () => {
  const routes = byExternalIdRoutes();

  it("finds the routes at all", () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it("lists every by-external-ids route with a rule", () => {
    expect(routes).toEqual(Object.keys(EXTERNAL_ID_TOMBSTONE_FAMILIES).sort());
  });

  it.each(withTombstone)(
    "%s: the delete stamps the deletion as Apple Health's",
    (_route, family) => {
      const source = code(family.delete);
      expect(source).toMatch(/\bappleHealthDeletion\(/);
      // A bare tombstone here would read as deleted in HealthLog.
      expect(source).not.toMatch(/deletedAt:\s*new Date\(/);
    },
  );

  it.each(withTombstone)(
    "%s: the ingest refuses by the origin, with the shared answer",
    (_route, family) => {
      const source = family.ingest.map(code).join("\n");
      expect(source).toMatch(/\bdeletedInHealthLog\(/);
      expect(source).toMatch(/\bDELETED_IN_HEALTHLOG_(ENTRY|REASON)\b/);
      expect(source).toMatch(/from\s+"@\/lib\/sync\/tombstone-repost"/);
    },
  );

  it("a revived cycle day starts from empty fields, and the bulk drain refuses one deleted in HealthLog", () => {
    const family =
      EXTERNAL_ID_TOMBSTONE_FAMILIES["cycle/day-logs/by-external-ids"];
    expect(family.rule).toBe("revive-empty");
    const write = code(family.ingest[0]);
    expect(write).toMatch(/\bconst revived\s*=/);
    expect(write).toMatch(/\brevived\s*\?\s*null\s*:/);
    expect(code(family.ingest[1])).toMatch(/refuseDeletedInHealthLog:\s*true/);
  });

  it.each(withoutTombstone)(
    "%s: the person cannot delete an Apple Health row",
    (route, family) => {
      const { file, refusal } = family.personDelete;
      if (file !== null) {
        // The person-facing delete refuses a synced row with its own code.
        expect(code(file)).toContain(`"${refusal}"`);
        return;
      }
      // No person-facing delete at all: no route of the domain but the
      // by-external-ids one exports DELETE.
      const root = join(
        SRC,
        "app/api",
        route.replace(/\/by-external-ids$/, ""),
      );
      const deleting = walkSourceFiles(root, { floor: 2 })
        .filter((p) => /(^|\/)route\.ts$/.test(p))
        .filter((p) => !p.startsWith("by-external-ids/"))
        .filter((p) =>
          /export\s+(const|async function)\s+DELETE\b/.test(
            stripComments(readSourceText(join(root, p))),
          ),
        );
      expect(deleting).toEqual([]);
    },
  );
});

describe("deletedInHealthLog", () => {
  const at = new Date("2026-11-20T08:00:00.000Z");
  const later = new Date("2026-11-21T08:00:00.000Z");

  it("is false for a live row", () => {
    expect(
      deletedInHealthLog({ deletedAt: null, appleHealthDeletedAt: null }),
    ).toBe(false);
    // A revived row may keep a stale stamp; it is live all the same.
    expect(
      deletedInHealthLog({ deletedAt: null, appleHealthDeletedAt: at }),
    ).toBe(false);
  });

  it("is false for the deletion the phone reported", () => {
    expect(
      deletedInHealthLog({
        deletedAt: new Date(at),
        appleHealthDeletedAt: new Date(at),
      }),
    ).toBe(false);
  });

  it("is true for any other deletion, and for a tombstone without an origin", () => {
    expect(
      deletedInHealthLog({ deletedAt: at, appleHealthDeletedAt: null }),
    ).toBe(true);
    // Reported deleted, written again, then deleted in HealthLog.
    expect(
      deletedInHealthLog({ deletedAt: later, appleHealthDeletedAt: at }),
    ).toBe(true);
  });
});
