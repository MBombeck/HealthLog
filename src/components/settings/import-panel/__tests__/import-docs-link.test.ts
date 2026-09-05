/**
 * The import cards' "docs" links must point at the external docs site.
 *
 * The app serves no `/docs` tree, so the old internal
 * `/docs/integrations/data-import` href 404'd for every user who
 * clicked it. That is the property this suite exists to hold.
 *
 * It used to assert `INTEGRATION_DOCS_BASE` and `data-import` by name.
 * Both were how the link happened to be built, not what it had to be:
 * the guide is not an integration runbook, it lives under `/guides/`,
 * and `${INTEGRATION_DOCS_BASE}/data-import` only resolved through a
 * redirect. Pinning the spelling would have made the correction fail a
 * green suite, so the assertions now name the guarantee — an absolute
 * `docs.healthlog.dev` URL, no internal path, new-tab hygiene — and
 * `IMPORT_GUIDE_URL` owns the address in one place for both cards.
 *
 * Watched red: restoring `href="/docs/integrations/data-import"` in
 * either card fails the internal-path assertion; dropping `rel` fails
 * the hygiene one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IMPORT_GUIDE_URL } from "../constants";

const CARDS = ["csv-import-card.tsx", "json-import-card.tsx"] as const;

describe("import-card docs links", () => {
  it("resolves to an absolute docs-site guide, not a redirect stop", () => {
    expect(IMPORT_GUIDE_URL).toMatch(
      /^https:\/\/docs\.healthlog\.dev\/guides\/[a-z0-9-]+\/$/,
    );
  });

  for (const card of CARDS) {
    it(`${card} links the external docs site, never an internal /docs path`, () => {
      const source = readFileSync(join(__dirname, "..", card), "utf8");

      expect(source).not.toContain('href="/docs');
      expect(source).toContain("IMPORT_GUIDE_URL");
      // External link hygiene for a new-tab docs jump.
      expect(source).toContain('rel="noopener noreferrer"');
      expect(source).toContain('target="_blank"');
    });
  }
});
