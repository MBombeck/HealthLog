/**
 * The locale catalog's boot script is cached by its URL: the service worker
 * serves `/i18n/<locale>.js?v=…` cache-first. Keyed by the package version,
 * every build of one release shared one URL, so a beta updated within a
 * release kept its first catalog and every key added since read as its raw
 * name ("timeline.zoom.range"). The key is the catalogs' content hash now.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("the locale catalog's cache key", () => {
  it("moves with the catalogs, not with the release", () => {
    const layout = read("src/app/layout.tsx");
    const src =
      /src=\{`\/i18n\/\$\{initialLocale\}\.js\?v=\$\{([^}]*)\}`\}/.exec(layout);
    expect(src?.[1]).toContain("NEXT_PUBLIC_I18N_CATALOG_VERSION");
    expect(src?.[1]).not.toContain("NEXT_PUBLIC_APP_VERSION");
  });

  it("is computed from the message catalogs at build time", () => {
    const config = read("next.config.ts");
    expect(config).toMatch(
      /NEXT_PUBLIC_I18N_CATALOG_VERSION:\s*catalogVersion\(\)/,
    );
    expect(config).toMatch(/join\(process\.cwd\(\), "messages"\)/);
  });
});
