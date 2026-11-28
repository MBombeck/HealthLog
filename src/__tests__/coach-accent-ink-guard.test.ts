import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSourceText, walkSourceFiles } from "./helpers/source-files";

/**
 * The Coach's accent is ink (`bg-primary` with a `text-background` glyph),
 * the face of the floating Coach button (`layout-coach-fab.tsx`). A gradient
 * from the primary to a second colour carried no meaning and made the new
 * conversation button look unlike the Coach button beside it, so no component
 * paints one.
 */
const ROOT = join(__dirname, "..", "components");
const GRADIENT_FROM_PRIMARY = /\bfrom-primary(?:\/\d+)?\b/g;

describe("Coach accent is ink", () => {
  const files = walkSourceFiles(ROOT, { floor: 800 }).filter(
    (rel) => !rel.includes("__tests__/"),
  );

  it("walks the component tree", () => {
    expect(files.length).toBeGreaterThan(800);
    expect(files.some((f) => f.endsWith("layout-coach-fab.tsx"))).toBe(true);
  });

  it("no component paints a gradient from the primary", () => {
    const offenders = files.flatMap((rel) =>
      [...readSourceText(join(ROOT, rel)).matchAll(GRADIENT_FROM_PRIMARY)].map(
        () => rel,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
