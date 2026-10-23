/**
 * The image optimizer stays off while nothing uses it.
 *
 * `next.config.ts` sets `images.unoptimized`, which makes Next answer
 * `/_next/image` with 404 before it reads a parameter, so the route that
 * fetches, decodes and re-encodes images is not reachable at all. Two ways
 * to undo that quietly, and this pins both:
 *
 *   1. A component imports `next/image` (or `next/legacy/image`) while the
 *      optimizer is off. It would render, unoptimized, and the next person
 *      to notice the missing optimization would switch the optimizer back on
 *      without the review this flag deserves. Using `next/image` means
 *      revisiting this decision, so the import fails here first.
 *   2. The optimizer comes back on with `dangerouslyAllowSVG`. An SVG is a
 *      document, not a picture, and the framework's own advisories have been
 *      about exactly that input. Re-enabling the optimizer is allowed; doing
 *      it with SVG input allowed is not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

import {
  requireFloor,
  stripComments,
  walkSourceFiles,
} from "./helpers/source-files";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

type ImagesConfig = {
  unoptimized?: boolean;
  dangerouslyAllowSVG?: boolean;
};

/**
 * The config as Next reads it, imported once with the file rather than inside
 * a test: the config pulls in Next's plugins, and loading that graph in a test
 * body put the import against the test timeout on a loaded machine.
 */
const IMAGES: ImagesConfig =
  (nextConfig as { images?: ImagesConfig }).images ?? {};

// Any import of the module: static, dynamic, `require`, side effect or
// re-export. Two literals with one shape rather than one built from a string,
// so nothing has to be escaped into a pattern.
const NEXT_IMAGE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']next\/(?:legacy\/)?image["']/m;
const NEXT_LINK_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']next\/link["']/m;

/** Every non-generated, non-test source file under `src/` matching `re`. */
function importers(re: RegExp): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((rel) => !rel.startsWith("generated/"))
    .filter((rel) => !rel.includes("__tests__/"))
    .filter((rel) =>
      re.test(stripComments(readFileSync(join(SRC, rel), "utf8"))),
    );
}

describe("next/image optimizer", () => {
  it("the import matcher recognises every form of the import", () => {
    // The sweep below passes when it matches nothing, so the matcher has to
    // be shown to match before an empty result means anything.
    for (const line of [
      'import Image from "next/image";',
      "import Image from 'next/legacy/image';",
      'const Image = await import("next/image");',
      'const Image = require("next/image");',
      'import "next/image";',
      'export { default } from "next/image";',
    ]) {
      expect(NEXT_IMAGE_IMPORT.test(line), line).toBe(true);
    }
    for (const line of [
      "// `next/image` is wrong here",
      'const path = "/_next/image?url=x";',
      'import { foo } from "next/image-extra";',
    ]) {
      expect(NEXT_IMAGE_IMPORT.test(stripComments(line)), line).toBe(false);
    }
  });

  it("the same sweep finds the imports of a sibling module", () => {
    // An empty result for `next/image` is only worth something if the walk,
    // the comment stripping and the matcher together do find real imports.
    // `next/link` is imported the same way all over the tree.
    requireFloor("next/link importers", importers(NEXT_LINK_IMPORT), 100);
  });

  it("is off, and then nothing imports next/image", () => {
    const images = IMAGES;
    if (images.unoptimized !== true) return;
    expect(importers(NEXT_IMAGE_IMPORT)).toEqual([]);
  });

  it("is never on with SVG input allowed", () => {
    const images = IMAGES;
    if (images.unoptimized === true) return;
    expect(images.dangerouslyAllowSVG ?? false).toBe(false);
  });

  it("is off today", () => {
    // The two cases above each skip on the other branch. This pins which
    // branch the tree is on, so flipping it is a visible change to this
    // file and not a silent switch between the two.
    expect(IMAGES.unoptimized).toBe(true);
  });
});
