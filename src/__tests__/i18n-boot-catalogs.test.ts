/**
 * The boot catalogs the root layout loads (`/i18n/<locale>.js`) exist for
 * every shipped locale. The layout asks for the reader's locale by name, so a
 * locale the generator does not write is a 404 and a page of raw keys.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { locales } from "@/lib/i18n/config";

const SCRIPT = join(__dirname, "../../scripts/generate-i18n-boot.mjs");
const out = mkdtempSync(join(tmpdir(), "hl-i18n-boot-"));

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("i18n boot catalogs", () => {
  execFileSync(process.execPath, [SCRIPT, out], { stdio: "pipe" });

  it.each(locales)("writes %s", (locale) => {
    const file = join(out, `${locale}.js`);
    expect(existsSync(file)).toBe(true);
    // A whole catalog, not an empty shell: every bundle is far above this.
    expect(statSync(file).size).toBeGreaterThan(100_000);
  });
});
