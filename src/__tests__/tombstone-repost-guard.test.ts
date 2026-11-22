/**
 * Every by-external-ids family keeps a deleted sample deleted.
 *
 * The iPhone app reads the whole Apple Health history after a reinstall or on
 * a new device. A family whose ingest takes a re-post of a deleted sample id
 * as new brings back what the person deleted (iOS #191: a dose deleted in
 * HealthLog came back on the next install). The rule and its answer live in
 * `src/lib/sync/tombstone-repost.ts`; this guard holds every
 * `DELETE /api/<domain>/by-external-ids` route to the list there, and each
 * listed ingest to its rule, so a new family cannot ship without one.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { EXTERNAL_ID_TOMBSTONE_FAMILIES } from "@/lib/sync/tombstone-repost";
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

describe("by-external-ids tombstone families", () => {
  const routes = byExternalIdRoutes();

  it("finds the routes at all", () => {
    expect(routes.length).toBeGreaterThanOrEqual(7);
  });

  it("lists every by-external-ids route with a rule", () => {
    expect(routes).toEqual(Object.keys(EXTERNAL_ID_TOMBSTONE_FAMILIES).sort());
  });

  it.each(Object.entries(EXTERNAL_ID_TOMBSTONE_FAMILIES))(
    "%s: its ingest applies the rule",
    (_route, family) => {
      const file = join(SRC, family.ingest);
      expect(existsSync(file), `${family.ingest} exists`).toBe(true);
      const code = stripComments(readSourceText(file));
      if (family.rule === "refuse") {
        // The shared answer, not a hand-written one that could drift.
        expect(code).toMatch(/\bTOMBSTONED_(ENTRY|REASON)\b/);
        expect(code).toMatch(/from\s+"@\/lib\/sync\/tombstone-repost"/);
      } else {
        // A revived day is written from empty fields.
        expect(code).toMatch(/\bconst revived\s*=/);
        expect(code).toMatch(/\brevived\s*\?\s*null\s*:/);
      }
    },
  );
});
